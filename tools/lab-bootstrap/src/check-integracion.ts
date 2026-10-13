/**
 * Verificación del flujo de integración a través del gateway (BT-008/009/010/033/051), con aserciones:
 * consumidor → gateway (OAuth Keycloak) → Micro Integrator (validación, SOAP, transformación, cola) → destino.
 *   1. Solicitud válida: 202 con la razón social que agrega el servicio SOAP. Si el servicio SOAP está detenido,
 *      el flujo no puede enriquecerla y esta verificación falla.
 *   2. Repetición con la misma Idempotency-Key: 200 con la respuesta original, sin volver a procesar.
 *   3. Solicitud inválida: 422 del esquema.
 *   4. Entrega: el sistema de destino registró la solicitud exactamente una vez (GET /_recepciones, por correlación).
 *   5. Un rechazo 4xx del destino no se reintenta y queda en la cola de fallidos con 1 intento (0-32).
 *   6. Consultar la cola de fallidos más de 20 veces no la vacía (política sin límite de entregas, 1-06), incluso
 *      con lecturas reject_requeue_true, que sin la política la vaciarían.
 *   7. Traza de extremo a extremo en Jaeger (gateway y Micro Integrator).
 * Termina con código 1 si alguna no cumple.
 */
import { randomUUID } from "node:crypto";
import { Agent, fetch } from "undici";
import { Wso2Client } from "@nexo/wso2-client";
import {
  Verificaciones,
  buscarEnCola,
  evaluarAceptada,
  evaluarConsultaNoDestructiva,
  sinLimiteDeEntregas,
  evaluarEnFallidos,
  evaluarEntrega,
  evaluarInvalida,
  evaluarRechazoSinReintento,
  evaluarRepeticion,
  evaluarTraza,
  type InfoCola,
  type MensajeCola,
  type Recepcion,
  type RespuestaSolicitud,
} from "./integracion.js";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const wso2 = new Wso2Client({
  baseUrl: "https://apim:9443",
  auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
  tls: { rejectUnauthorized: false },
});
const DESTINO = process.env.NEXO_LAB_DESTINO_URL ?? "http://localhost:7001";
const CHAOS_TOKEN = process.env.NEXO_LAB_CHAOS_TOKEN ?? "nexo-lab-chaos";
const MQ = process.env.NEXO_RABBITMQ_API ?? "http://rabbitmq:15672/api";
const MQ_AUTH = `Basic ${Buffer.from(`nexo:${process.env.RABBITMQ_PASSWORD ?? "nexo-lab-mq"}`).toString("base64")}`;
const DLQ = "solicitudes.dlq";
/** Más lecturas que el límite de entregas por omisión de una cola quorum (20). */
const LECTURAS_DLQ = 25;
/** Modo de lectura que, sin la política, descarta el mensaje al pasar el límite (medido en RabbitMQ 4.3.6). */
const MODO_DESTRUCTIVO = "reject_requeue_true";

const log = (m: string, x?: unknown) =>
  console.log(`[integración] ${m}${x !== undefined ? ` ${JSON.stringify(x)}` : ""}`);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recepciones(correlacion: string): Promise<Recepcion[]> {
  const r = await fetch(`${DESTINO}/_recepciones?correlacion=${encodeURIComponent(correlacion)}`);
  if (!r.ok)
    throw new Error(
      `GET ${DESTINO}/_recepciones respondió ${r.status}: reconstruya la imagen de los backends de ejemplo (make build)`,
    );
  return ((await r.json()) as { recepciones: Recepcion[] }).recepciones;
}

async function caos(cfg: Record<string, number>): Promise<void> {
  const r = await fetch(`${DESTINO}/_chaos`, {
    method: "POST",
    headers: { "x-chaos-token": CHAOS_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(`POST ${DESTINO}/_chaos respondió ${r.status}`);
}

async function mq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${MQ}${path}`, {
    method,
    headers: { authorization: MQ_AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`RabbitMQ ${method} ${path}: ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Lectura de la cola sin consumir (igual que la Consola): toma los mensajes y los devuelve a la cola. Pide más
 * mensajes de los que informa la API (sus contadores se actualizan cada pocos segundos) para llegar al último.
 */
const leerFallidos = (informados: number | undefined, ackmode = "ack_requeue_true") =>
  mq<MensajeCola[]>("POST", `/queues/%2F/${DLQ}/get`, {
    count: Math.max((informados ?? 0) + 100, 200),
    ackmode,
    encoding: "auto",
    truncate: 50_000,
  });

async function main() {
  const v = new Verificaciones();
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo");
  const api = (await wso2.devportal.listApis()).list.find((a) => a.name === "SolicitudesConcesion");
  if (!app || !api) throw new Error("falta OperadorDemo o la API SolicitudesConcesion");
  const subs = (await wso2.devportal.listSubscriptions(app.applicationId)).list;
  if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
    await wso2.devportal.subscribe(app.applicationId, api.id, "Unlimited");
    for (const w of (await wso2.admin.listWorkflows("AM_SUBSCRIPTION_CREATION")).list)
      await wso2.admin.resolveWorkflow(w.referenceId, "APPROVED", "Aprobado (verificación de integración)");
    log("suscripción creada y aprobada");
  }
  const key = (await wso2.devportal.listKeys(app.applicationId)).list.find(
    (k) => k.keyManager === "Keycloak",
  );
  const tok = await fetch("http://keycloak:8080/realms/nexo/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key?.consumerKey}:${key?.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  const { access_token } = (await tok.json()) as { access_token: string };
  const traceId = randomUUID().replace(/-/g, "");
  const enviar = (idem: string, cuerpo: unknown, traza = false) =>
    fetch("https://apim:8243/solicitudes/1.0.0/", {
      method: "POST",
      dispatcher: insecure,
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        "idempotency-key": idem,
        ...(traza ? { traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01` } : {}),
      },
      body: JSON.stringify(cuerpo),
    });
  const valida = { rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" };
  const leer = async (r: Awaited<ReturnType<typeof enviar>>) =>
    (await r
      .text()
      .then((t) => (t ? JSON.parse(t) : {}))
      .catch(() => ({}))) as RespuestaSolicitud;

  // 1. Solicitud válida (el gateway puede tardar unos segundos en tener la API desplegada: 404 transitorio).
  const idem = `verif-${randomUUID()}`;
  let primera = await enviar(idem, valida, true);
  for (let i = 0; i < 8 && primera.status === 404; i++) {
    await esperar(3000);
    primera = await enviar(idem, valida, true);
  }
  const original = await leer(primera);
  log(`primera llamada: ${primera.status}`, original);
  const aceptada = evaluarAceptada(primera.status, original);
  v.verificar(aceptada.nombre, aceptada.ok, aceptada.detalle);

  // 2. Repetición con la misma Idempotency-Key.
  const segunda = await enviar(idem, valida, true);
  const repetida = await leer(segunda);
  log(`repetición con la misma Idempotency-Key: ${segunda.status}`, repetida);
  const rep = evaluarRepeticion(
    segunda.status,
    repetida,
    segunda.headers.get("x-idempotent-replay"),
    original,
  );
  v.verificar(rep.nombre, rep.ok, rep.detalle);

  // 3. Solicitud inválida.
  const invalida = await enviar(`${idem}-x`, { rutEmpresa: "1", servicio: "X" });
  const cuerpoInvalida = await leer(invalida);
  log(`solicitud inválida: ${invalida.status}`, cuerpoInvalida);
  const inv = evaluarInvalida(invalida.status, cuerpoInvalida);
  v.verificar(inv.nombre, inv.ok, inv.detalle);

  // 4. Entrega al destino, una sola vez (la repetición no llega al destino).
  if (aceptada.ok) {
    let filas: Recepcion[] = [];
    for (let i = 0; i < 20 && !filas.some((f) => f.resultado === "creado"); i++) {
      await esperar(1000);
      filas = await recepciones(original.correlacion!);
    }
    await esperar(3000);
    filas = await recepciones(original.correlacion!);
    const ent = evaluarEntrega(filas, original.correlacion!);
    v.verificar(ent.nombre, ent.ok, ent.detalle);
  } else {
    v.verificar(
      "entrega al sistema de destino, una sola vez",
      false,
      "no se evalúa: la solicitud válida no fue aceptada",
    );
  }

  // 5. Un rechazo 4xx del destino no se reintenta (0-32).
  const STATUS_RECHAZO = 422;
  await caos({ failNext: 1, failStatus: STATUS_RECHAZO });
  const rechazo = await enviar(`verif-rechazo-${randomUUID()}`, valida);
  const cuerpoRechazo = await leer(rechazo);
  log(`solicitud que el destino rechazará con ${STATUS_RECHAZO}: ${rechazo.status}`, cuerpoRechazo);
  let enFallidos: MensajeCola | undefined;
  if (rechazo.status === 202 && cuerpoRechazo.correlacion) {
    // El primer reintento saldría a los 2 s: 8 s bastan para ver que no hubo ninguno.
    await esperar(8000);
    const sr = evaluarRechazoSinReintento(
      await recepciones(cuerpoRechazo.correlacion),
      cuerpoRechazo.correlacion,
      STATUS_RECHAZO,
    );
    v.verificar(sr.nombre, sr.ok, sr.detalle);
    const info = await mq<InfoCola>("GET", `/queues/%2F/${DLQ}`);
    enFallidos = buscarEnCola(await leerFallidos(info.messages), cuerpoRechazo.correlacion);
    const ef = evaluarEnFallidos(enFallidos, STATUS_RECHAZO);
    v.verificar(ef.nombre, ef.ok, ef.detalle);

    // 6. Consultar la cola de fallidos no la vacía (1-06). Las lecturas en modo destructivo se hacen solo si la
    //    política está vigente: sin ella vaciarían la cola de fallidos del laboratorio.
    if (sinLimiteDeEntregas(info)) {
      for (let i = 0; i < LECTURAS_DLQ; i++) await leerFallidos(info.messages, MODO_DESTRUCTIVO);
      const despues = await mq<InfoCola>("GET", `/queues/%2F/${DLQ}`);
      const sigue = !!buscarEnCola(await leerFallidos(despues.messages), cuerpoRechazo.correlacion);
      const nd = evaluarConsultaNoDestructiva(despues, LECTURAS_DLQ, sigue);
      v.verificar(nd.nombre, nd.ok, nd.detalle);
    } else {
      const nd = evaluarConsultaNoDestructiva(info, undefined, !!enFallidos);
      v.verificar(nd.nombre, nd.ok, nd.detalle);
    }
  } else {
    await caos({ failNext: 0 });
    v.verificar(
      `rechazo ${STATUS_RECHAZO} del destino sin reintentos`,
      false,
      `la solicitud no fue aceptada (${rechazo.status})`,
    );
  }

  // 7. Traza de extremo a extremo.
  await esperar(4000);
  const services = (await (await fetch("http://localhost:16686/api/v3/services")).json()) as {
    services: string[];
  };
  log("servicios con trazas en Jaeger", services.services);
  const traceRes = await fetch(`http://localhost:16686/api/v3/traces/${traceId}`);
  const traza = evaluarTraza(
    traceRes.status,
    traceRes.ok ? ((await traceRes.json()) as Parameters<typeof evaluarTraza>[1]) : undefined,
    traceId,
  );
  v.verificar(traza.nombre, traza.ok, traza.detalle);

  log(v.resumen());
  if (v.fallidas.length) {
    console.error(`[integración] ERROR: no cumple ${v.fallidas.map((f) => f.nombre).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[integración] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
