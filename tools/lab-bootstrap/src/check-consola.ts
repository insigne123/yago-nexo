/**
 * Verificación de la API de la Consola Nexo contra el laboratorio: autenticación con Keycloak, matriz
 * rol-permiso (BT-026), catálogo e impacto (BT-018, BT-022, BT-024), auditoría encadenada y detección de
 * alteraciones (BT-031), reproceso autorizado (BT-051), exportación con manifiesto (BT-049, BT-060),
 * consumo sin cobro (BT-021), canales TLS (BT-028) y webhook de alertas.
 *
 * Uso: NEXO_CONSOLE_URL=http://localhost:8090/api/v1 pnpm --filter @nexo/lab-bootstrap check:consola
 */
import { createHash, randomUUID } from "node:crypto";
import { Agent, fetch } from "undici";
import { unzipSync, strFromU8 } from "fflate";
import pg from "pg";
import { Wso2Client } from "@nexo/wso2-client";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const DB_URL = process.env.NEXO_DATABASE_URL ?? "postgres://nexo:nexo-lab-console@localhost:15432/nexo";

const USERS = {
  administrador: "admin.nexo",
  desarrollador: "ana.desarrollo",
  aprobador: "luis.aprobador",
  operador: "carla.operacion",
  auditor: "pedro.auditoria",
  consumidor: "consumidor.demo",
} as const;
type Role = keyof typeof USERS;

const rows: Array<{ requisito: string; prueba: string; esperado: string; obtenido: string; cumple: boolean }> = [];
function check(requisito: string, prueba: string, esperado: unknown, obtenido: unknown, cumple = String(esperado) === String(obtenido)) {
  rows.push({ requisito, prueba, esperado: String(esperado), obtenido: String(obtenido).slice(0, 60), cumple });
  return cumple;
}

async function token(username: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", scope: "openid", username, password: PASSWORD }).toString(),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`Keycloak no entregó token para ${username}: ${body.error_description ?? res.status}`);
  return body.access_token;
}

async function call(tok: string | undefined, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : type.includes("zip") || type.includes("octet") ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data: data as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const CHAOS = process.env.NEXO_LAB_CHAOS_URL ?? "http://localhost:7001/_chaos";

async function chaos(failRate: number) {
  await fetch(CHAOS, { method: "POST", headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" }, body: JSON.stringify({ failRate }) });
}

/** Provoca un mensaje fallido real: el destino responde 500 y el Integrador agota los reintentos. */
async function produceDeadLetter(): Promise<string> {
  const wso2 = new Wso2Client({
    baseUrl: "https://apim:9443",
    auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
    tls: { rejectUnauthorized: false },
  });
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo");
  if (!app) throw new Error("falta la aplicación OperadorDemo (ejecute el bootstrap)");
  const key = (await wso2.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak");
  const tok = await fetch("http://keycloak:8080/realms/nexo/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key?.consumerKey}:${key?.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  const { access_token } = (await tok.json()) as { access_token: string };
  await chaos(1);
  const res = await fetch("https://apim:8243/solicitudes/1.0.0/", {
    method: "POST",
    dispatcher: insecure,
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", "idempotency-key": `consola-${randomUUID()}` },
    body: JSON.stringify({ rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" }),
  });
  const body = (await res.json()) as { correlacion?: string };
  if (res.status !== 202 || !body.correlacion) throw new Error(`el flujo no aceptó la solicitud (${res.status})`);
  return body.correlacion;
}

async function main() {
  const tok = {} as Record<Role, string>;
  for (const [role, user] of Object.entries(USERS) as Array<[Role, string]>) tok[role] = await token(user);

  // --------------------------------------------------------------- autenticación y roles (BT-026)
  check("BT-026", "salud sin token", 200, (await call(undefined, "GET", "/health")).status);
  check("BT-026", "sin token → rechazo", 401, (await call(undefined, "GET", "/me")).status);
  check("BT-026", "token alterado → rechazo", 401, (await call(`${tok.auditor.slice(0, -4)}AAAA`, "GET", "/me")).status);
  for (const role of Object.keys(USERS) as Role[]) {
    const me = await call(tok[role], "GET", "/me");
    check("BT-026", `rol de ${USERS[role]}`, role, (me.data.roles ?? []).join(","));
  }
  check("BT-026", "consumidor no edita el catálogo", 403, (await call(tok.consumidor, "PATCH", "/apis/x", { purpose: "x" })).status);
  check("BT-026", "desarrollador no lee auditoría", 403, (await call(tok.desarrollador, "GET", "/audit-events")).status);
  check("BT-026", "administrador no verifica auditoría", 403, (await call(tok.administrador, "GET", "/audit-events/verify")).status);
  const matrix = await call(tok.auditor, "GET", "/compliance/role-matrix");
  check("BT-026", "matriz rol-permiso publicada", "27 permisos × 6 roles", `${matrix.data.length} permisos × ${Object.keys(matrix.data[0] ?? {}).length - 1} roles`);

  // --------------------------------------------------------------- catálogo e impacto (BT-018, BT-022, BT-024)
  const sync = await call(tok.desarrollador, "POST", "/catalog/sync");
  check("BT-018", "sincronización con WSO2", 200, sync.status);
  const apis = (await call(tok.consumidor, "GET", "/apis")).data as Array<{ name: string; completeness: number }>;
  check("BT-018", "APIs en el catálogo", ">= 5", apis.length, apis.length >= 5);
  const incompletas = apis.filter((a) => a.completeness < 100).map((a) => a.name);
  check("BT-018", "fichas con los 8 campos", "todas", incompletas.length ? incompletas.join(", ") : "todas");
  const graph = (await call(tok.desarrollador, "GET", "/graph")).data as { edges: Array<{ source: string }> };
  check("BT-022", "dependencias derivadas del Integrador", "> 0", graph.edges.filter((e) => e.source === "analizador_mi").length, graph.edges.some((e) => e.source === "analizador_mi"));
  const impact = await call(tok.desarrollador, "POST", "/impact/simulate", { nodeId: "sistema:registro-soap:7001", change: { kind: "campo", detail: "Se elimina el campo estado" } });
  const af = impact.data.affected ?? {};
  check(
    "BT-024",
    "impacto de cambiar el registro SOAP",
    "flujo, API y consumidor",
    `${af.flujos?.length ?? 0} flujo, ${af.apis?.length ?? 0} API, ${af.consumidores?.length ?? 0} consumidor`,
    af.flujos?.length > 0 && af.apis?.length > 0 && af.consumidores?.length > 0,
  );

  // --------------------------------------------------------------- consumo sin cobro (BT-021)
  const usageAll = (await call(tok.aprobador, "GET", "/usage")).data as Array<{ label: string; plan: string }>;
  check("BT-021", "consumo atribuido por consumidor", "OperadorDemo, sin cobro", usageAll.map((u) => `${u.label}, ${u.plan}`).join("; "), usageAll.some((u) => u.label === "OperadorDemo" && u.plan === "sin cobro"));
  const usageOwn = (await call(tok.consumidor, "GET", "/usage")).data as unknown[];
  check("BT-021", "un consumidor no ve el consumo de otros", 0, usageOwn.length);
  const csv = await call(tok.aprobador, "GET", "/usage/export");
  check("BT-021", "exportación CSV del consumo", "tipo,clave,llamadas…", String(csv.data).split("\n")[0], String(csv.data).startsWith("tipo,clave,llamadas"));

  // --------------------------------------------------------------- canales TLS (BT-028)
  const tls = (await call(tok.auditor, "GET", "/compliance/tls-channels")).data as Array<{ canal: string; versiones: string[]; rechazaTls10: boolean }>;
  for (const c of tls) {
    check("BT-028", `TLS en ${c.canal}`, "TLS ≥ 1.2 y rechaza 1.0", `${c.versiones.join("/") || "sin TLS"}${c.rechazaTls10 ? ", rechaza 1.0" : ""}`, c.versiones.length > 0 && c.versiones.every((v) => v === "TLSv1.2" || v === "TLSv1.3") && c.rechazaTls10);
  }

  // --------------------------------------------------------------- despliegue progresivo: segregación de funciones (D-04)
  const apiConcesiones = (await call(tok.desarrollador, "GET", "/apis?q=Concesiones")).data.find((a: { name: string }) => a.name === "Concesiones");
  const created = await call(tok.desarrollador, "POST", "/rollouts", { apiId: apiConcesiones.id, strategy: "canary", candidateEndpoint: "http://concesiones-v2:7001", steps: [10, 50, 100], stepDurationSec: 30 });
  if (created.status === 201) {
    check("D-04", "desarrollador solicita el despliegue", 201, created.status);
    check("D-04", "desarrollador no se aprueba a sí mismo", 403, (await call(tok.desarrollador, "POST", `/rollouts/${created.data.id}/approve`)).status);
    const aborted = await call(tok.operador, "POST", `/rollouts/${created.data.id}/abort`, { reason: "verificación de la Consola" });
    check("D-04", "operador detiene el despliegue", "abortado", aborted.data.status);
  } else {
    check("D-04", "desarrollador solicita el despliegue", 201, `${created.status} ${created.data.message ?? ""}`);
  }

  // --------------------------------------------------------------- mensajes fallidos (BT-051)
  const correlacion = await produceDeadLetter();
  let pending: { id: string; status: string; payloadPreview: string } | undefined;
  try {
    for (let i = 0; i < 40 && !pending; i++) {
      await sleep(1500);
      const dlq = (await call(tok.aprobador, "GET", "/dead-letters")).data as Array<{ id: string; status: string; payloadPreview: string }>;
      pending = dlq.find((m) => m.id === correlacion && m.status === "pendiente");
    }
  } finally {
    await chaos(0); // el destino vuelve a responder antes de reprocesar
  }
  check("BT-051", "falla del destino llega a la cola de fallidos", "pendiente", pending?.status ?? "no llegó");
  if (pending) {
    check("BT-029", "vista previa sin RUT completo", "RUT enmascarado", /\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]/.test(pending.payloadPreview) ? "RUT visible" : "RUT enmascarado");
    const path = `/dead-letters/${encodeURIComponent(pending.id)}/reprocess`;
    check("BT-051", "reproceso exige motivo", 400, (await call(tok.aprobador, "POST", path, {})).status);
    check("BT-051", "desarrollador no puede reprocesar", 403, (await call(tok.desarrollador, "POST", path, { reason: "intento sin permiso" })).status);
    const rep = await call(tok.aprobador, "POST", path, { reason: "Destino restablecido, se reintenta (verificación)" });
    check("BT-051", "reproceso autorizado y auditado", "reprocesado", rep.data.status);
    // Si el destino fallara de nuevo, el mensaje volvería a la cola en ~15 s (reintentos 2/4/8 s).
    await sleep(20_000);
    const after = (await call(tok.aprobador, "GET", "/dead-letters")).data as Array<{ id: string; status: string }>;
    check("BT-051", "mensaje reprocesado con éxito", "fuera de la cola", after.find((m) => m.id === correlacion)?.status === "pendiente" ? "volvió a fallar" : "fuera de la cola");
  }

  // --------------------------------------------------------------- alertas
  const am = await call(undefined, "POST", "/alerts/alertmanager", {
    alerts: [{ status: "firing", labels: { alertname: "VerificacionConsola", severidad: "S3" }, annotations: { resumen: "Alerta de prueba de la verificación" }, fingerprint: "verificacion" }],
  });
  check("BT-034", "webhook de Alertmanager", 204, am.status);
  const ov = (await call(tok.operador, "GET", "/overview")).data;
  check("BT-034", "resumen muestra alertas abiertas", "≥ 1", ov.alertas?.abiertas, Number(ov.alertas?.abiertas) >= 1);

  // --------------------------------------------------------------- exportación con manifiesto (BT-049, BT-060)
  const job = await call(tok.auditor, "POST", "/exports");
  let st = job.data;
  for (let i = 0; i < 30 && st.status === "en_curso"; i++) {
    await sleep(1000);
    st = (await call(tok.auditor, "GET", `/exports/${job.data.id}`)).data;
  }
  check("BT-049", "exportación generada", "listo", st.status);
  if (st.status === "listo") {
    const zip = (await call(tok.auditor, "GET", `/exports/${job.data.id}/download`)).data as Uint8Array;
    const files = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(files["manifiesto.json"]!)) as { items: Array<{ archivo: string; sha256: string; tipo: string }> };
    const bad = manifest.items.filter((it) => !files[it.archivo] || createHash("sha256").update(files[it.archivo]!).digest("hex") !== it.sha256);
    check("BT-060", "hashes del manifiesto coinciden", `${manifest.items.length} de ${manifest.items.length}`, `${manifest.items.length - bad.length} de ${manifest.items.length}`);
    const tipos = [...new Set(manifest.items.map((i) => i.tipo))].sort().join(", ");
    check("BT-049", "incluye APIs, flujos y metadatos", "api, flujo, metadatos", tipos);
  }

  // --------------------------------------------------------------- auditoría encadenada (BT-031)
  const verify = await call(tok.auditor, "GET", "/audit-events/verify");
  check("BT-031", "cadena de auditoría íntegra", true, verify.data.ok);
  const events = (await call(tok.auditor, "GET", "/audit-events?limit=500")).data as Array<{ action: string }>;
  const acciones = new Set(events.map((e) => e.action));
  const esperadas = ["catalogo.sincronizar", "impacto.simular", "despliegue.crear", "despliegue.abortar", "exportacion.generar"];
  const faltan = esperadas.filter((a) => !acciones.has(a));
  check("BT-031", "acciones de la Consola auditadas", "todas", faltan.length ? `faltan ${faltan.join(", ")}` : "todas");
  // Alteración deliberada de un evento directamente en la base: la verificación debe detectarla.
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const victim = (await db.query("SELECT seq, details FROM nexo.audit_event ORDER BY seq LIMIT 1 OFFSET 1")).rows[0];
    if (victim) {
      await db.query("UPDATE nexo.audit_event SET details = $1 WHERE seq = $2", [JSON.stringify({ alterado: true }), victim.seq]);
      const broken = await call(tok.auditor, "GET", "/audit-events/verify");
      check("BT-031", "detecta un evento alterado", `quiebre en seq ${victim.seq}`, broken.data.ok ? "no detectado" : `quiebre en seq ${broken.data.brokenAt}`);
      await db.query("UPDATE nexo.audit_event SET details = $1 WHERE seq = $2", [victim.details === null ? null : JSON.stringify(victim.details), victim.seq]);
      check("BT-031", "cadena íntegra tras restaurar", true, (await call(tok.auditor, "GET", "/audit-events/verify")).data.ok);
    }
  } finally {
    await db.end();
  }

  console.table(rows);
  const failed = rows.filter((r) => !r.cumple);
  console.log(failed.length ? `[Consola] ${failed.length} de ${rows.length} verificaciones NO cumplen` : `[Consola] ${rows.length} verificaciones cumplen`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error("[Consola] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
