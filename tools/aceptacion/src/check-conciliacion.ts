/**
 * Conciliación del flujo asíncrono de solicitudes (PA-009, BT-009): envía 100 mensajes por el gateway con una
 * falla temporal inyectada en el sistema de destino (las primeras solicitudes responden 503), espera a que el flujo
 * los entregue con sus reintentos y concilia por correlación de punta a punta:
 *   gateway (202 + correlación) → Micro Integrator → RabbitMQ → destino (X-Correlation-ID, GET /_recepciones).
 * Pasa solo si 100 enviados = 100 entregados, con 0 duplicados y todas las fallas temporales recuperadas.
 * No usa /_estadisticas del destino, porque cuenta registros únicos (deduplica) y no puede mostrar un duplicado.
 *
 *   pnpm --filter @nexo/aceptacion conciliacion
 *   NEXO_CONCILIACION_MENSAJES=100 NEXO_CONCILIACION_FALLAS=10 …   cantidad de mensajes y de fallas inyectadas
 */
import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { conciliar, cumple, resumen, type Enviado, type Recepcion } from "./conciliacion.js";

const APIM = process.env.NEXO_APIM_URL ?? "https://apim:9443";
const GATEWAY = process.env.NEXO_GATEWAY_URL ?? "https://apim:8243";
const KEYCLOAK = process.env.NEXO_KEYCLOAK_URL ?? "http://keycloak:8080";
const DESTINO = process.env.NEXO_LAB_DESTINO_URL ?? "http://localhost:7001";
const CHAOS_TOKEN = process.env.NEXO_LAB_CHAOS_TOKEN ?? "nexo-lab-chaos";
const MENSAJES = Number(process.env.NEXO_CONCILIACION_MENSAJES ?? 100);
const FALLAS = Number(process.env.NEXO_CONCILIACION_FALLAS ?? 10);
const ESPERA_MAX_S = Number(process.env.NEXO_CONCILIACION_ESPERA_S ?? 180);

const log = (m: string) => console.log(`[conciliación] ${m}`);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTPS hacia API Manager con su certificado autofirmado del laboratorio. */
function https(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((ok, mal) => {
    const req = request(url, { method, headers, rejectUnauthorized: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", mal);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${url}: tiempo de espera agotado`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function token(): Promise<string> {
  const admin = `Basic ${Buffer.from(`admin:${process.env.APIM_ADMIN_PASSWORD ?? "admin"}`).toString("base64")}`;
  const apps = await https("GET", `${APIM}/api/am/devportal/v3/applications?limit=100`, {
    authorization: admin,
  });
  if (apps.status !== 200) throw new Error(`Dev Portal: aplicaciones ${apps.status}`);
  const app = (JSON.parse(apps.text) as { list: { applicationId: string; name: string }[] }).list.find(
    (a) => a.name === "OperadorDemo",
  );
  if (!app) throw new Error("falta la aplicación OperadorDemo (make bootstrap)");
  const keys = await https(
    "GET",
    `${APIM}/api/am/devportal/v3/applications/${app.applicationId}/oauth-keys`,
    { authorization: admin },
  );
  const key = (
    JSON.parse(keys.text) as { list: { keyManager: string; consumerKey: string; consumerSecret: string }[] }
  ).list.find((k) => k.keyManager === "Keycloak");
  if (!key) throw new Error("OperadorDemo no tiene claves del Key Manager Keycloak");
  const res = await fetch(`${KEYCLOAK}/realms/nexo/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key.consumerKey}:${key.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Keycloak: token ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function caos(cfg: Record<string, number>): Promise<void> {
  const r = await fetch(`${DESTINO}/_chaos`, {
    method: "POST",
    headers: { "x-chaos-token": CHAOS_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok)
    throw new Error(
      `POST ${DESTINO}/_chaos respondió ${r.status}${r.status === 400 ? " (¿imagen de los backends sin failNext? make build)" : ""}`,
    );
}

async function recepcionesDesde(desde: string): Promise<Recepcion[]> {
  const r = await fetch(`${DESTINO}/_recepciones?desde=${encodeURIComponent(desde)}`);
  if (!r.ok)
    throw new Error(
      `GET ${DESTINO}/_recepciones respondió ${r.status}: reconstruya la imagen de los backends de ejemplo (make build)`,
    );
  return ((await r.json()) as { recepciones: Recepcion[] }).recepciones;
}

async function main() {
  const corrida = randomUUID().slice(0, 8);
  const bearer = `Bearer ${await token()}`;
  const desde = new Date(Date.now() - 1000).toISOString();
  log(
    `corrida ${corrida}: ${MENSAJES} mensajes; falla temporal inyectada: las primeras ${FALLAS} solicitudes al destino responden 503`,
  );
  await caos({ failNext: FALLAS, failStatus: 503 });
  const enviados: Enviado[] = [];
  try {
    for (let n = 1; n <= MENSAJES; n++) {
      const idempotencyKey = `conciliacion-${corrida}-${String(n).padStart(3, "0")}`;
      const r = await https(
        "POST",
        `${GATEWAY}/solicitudes/1.0.0/`,
        { authorization: bearer, "content-type": "application/json", "idempotency-key": idempotencyKey },
        JSON.stringify({
          rutEmpresa: "76.086.428-5",
          servicio: "Internet",
          region: "Los Lagos",
          observaciones: `conciliación ${corrida} #${n}`,
        }),
      );
      let correlacion = "";
      try {
        correlacion = String((JSON.parse(r.text) as { correlacion?: string }).correlacion ?? "");
      } catch {
        /* respuesta sin JSON */
      }
      enviados.push({ n, idempotencyKey, status: r.status, correlacion });
    }
    log(`enviados ${enviados.length}: ${enviados.filter((e) => e.status === 202).length} aceptados con 202`);

    // Espera a que todo lo aceptado llegue al destino (los reintentos salen a los 2, 4 y 8 s).
    const inicio = Date.now();
    let c = conciliar(enviados, await recepcionesDesde(desde));
    while (c.entregados < c.aceptados && Date.now() - inicio < ESPERA_MAX_S * 1000) {
      await esperar(2000);
      c = conciliar(enviados, await recepcionesDesde(desde));
    }
    // Margen para que aparezca cualquier entrega duplicada tardía.
    await esperar(10_000);
    c = conciliar(enviados, await recepcionesDesde(desde));

    log("n    correlación                                     recepciones en el destino");
    for (const f of c.filas)
      log(
        `${String(f.n).padStart(3, "0")}  ${f.correlacion.padEnd(46)}  ${f.recepciones.join(" → ") || "(ninguna)"}`,
      );
    for (const e of c.noAceptados)
      log(`${String(e.n).padStart(3, "0")}  no aceptado por el gateway: ${e.status}`);
    const v = cumple(c, MENSAJES, FALLAS);
    // Las últimas líneas son el resumen: el registro de aceptación las toma como «resultado obtenido».
    log(resumen(c));
    log(
      `enviados ${c.enviados} · aceptados ${c.aceptados} · entregados ${c.entregados} · duplicados ${c.duplicados}`,
    );
    log(
      `fallas temporales inyectadas ${FALLAS} · respondidas por el destino ${c.fallasTemporales} · recuperadas ${c.recuperados}`,
    );
    if (!v.ok) {
      console.error(`[conciliación] ERROR: ${v.motivos.join("; ")}`);
      process.exitCode = 1;
      return;
    }
    log(`CUMPLE: ${c.enviados} enviados = ${c.entregados} entregados, ${c.duplicados} duplicados`);
  } finally {
    await caos({ failNext: 0 }).catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("[conciliación] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
