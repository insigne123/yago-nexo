/**
 * Verificación de D-01 (descubrimiento de APIs no gobernadas). En el laboratorio hay tres APIs "escondidas":
 * una detrás del NGINX heredado (con datos personales y sin autenticación), una ruta de APISIX con key-auth y
 * un servicio directo que publica su contrato OpenAPI. El escaneo debe encontrarlas, compararlas con el
 * catálogo, puntuar su exposición y respetar la clasificación que hagan las personas en los escaneos siguientes.
 * Requisitos: perfil legacy arriba y `make legado` (siembra APISIX y tráfico por NGINX).
 */
import { fetch } from "undici";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(username: string) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", username, password: PASSWORD }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api<T>(tok: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* CSV u otro texto */
  }
  return { status: res.status, data: data as T, text };
}

type Scan = { id: string; status: string; totals: { hallazgos: number; nuevos: number; noGobernados: number; riesgoAlto: number; errores: string[] } };
type Finding = {
  id: string;
  source: string;
  host: string;
  port?: number;
  path: string;
  specFound: boolean;
  authDetected: string;
  personalDataSuspected: boolean;
  matchedApiId?: string;
  exposureScore: number;
  reasons: string[];
  status: string;
};

async function scan(operator: string, sources: string[]): Promise<Scan> {
  const created = await api<Scan>(operator, "POST", "/discovery/scans", { sources });
  if (created.status !== 202) throw new Error(`no se pudo iniciar el escaneo: ${created.status}`);
  for (let i = 0; i < 100; i++) {
    await sleep(2000);
    const s = (await api<Scan[]>(operator, "GET", "/discovery/scans")).data.find((x) => x.id === created.data.id);
    if (s && s.status !== "en_curso") return s;
  }
  throw new Error("el escaneo no terminó en 200 s");
}

async function main() {
  const operator = await token("carla.operacion");
  const approver = await token("luis.aprobador");
  const dev = await token("ana.desarrollo");
  const auditor = await token("pedro.auditoria");
  const rows: Array<Record<string, unknown>> = [];
  const t0 = Date.now();
  const s1 = await scan(operator, ["apisix", "nginx", "red"]);
  const secs = Math.round((Date.now() - t0) / 1000);
  rows.push({ prueba: "escaneo de APISIX, NGINX y red", esperado: "terminado", obtenido: `${s1.status} en ${secs} s · ${s1.totals.hallazgos} hallazgos`, cumple: s1.status === "terminado" });

  const findings = (await api<Finding[]>(approver, "GET", "/discovery/findings")).data;
  const find = (pred: (f: Finding) => boolean) => findings.find(pred);
  const nginx = find((f) => f.source === "nginx" && f.path === "/interno/reportes/titulares");
  rows.push({
    prueba: "NGINX: reporte con datos personales",
    esperado: "sin autenticación · datos personales · puntaje ≥ 90",
    obtenido: nginx ? `${nginx.authDetected} · ${nginx.personalDataSuspected ? "datos personales" : "sin datos personales"} · ${nginx.exposureScore}` : "no encontrado",
    cumple: !!nginx && nginx.authDetected === "ninguna" && nginx.personalDataSuspected && nginx.exposureScore >= 90,
  });
  const apisix = find((f) => f.source === "apisix" && f.path === "/fiscalizacion");
  rows.push({
    prueba: "APISIX: ruta con key-auth",
    esperado: "autenticación requerida · no gobernada",
    obtenido: apisix ? `${apisix.authDetected} · ${apisix.matchedApiId ? "gobernada" : "no gobernada"} · ${apisix.exposureScore}` : "no encontrado",
    cumple: !!apisix && apisix.authDetected.startsWith("requerida") && !apisix.matchedApiId,
  });
  const direct = find((f) => f.source === "red" && f.host === "ocultas" && f.path === "/espectro/asignaciones");
  rows.push({
    prueba: "directa: contrato OpenAPI publicado",
    esperado: "contrato encontrado · datos personales",
    obtenido: direct ? `${direct.specFound ? "contrato encontrado" : "sin contrato"} · ${direct.personalDataSuspected ? "datos personales" : "sin datos personales"} · ${direct.exposureScore}` : "no encontrado",
    cumple: !!direct && direct.specFound && direct.personalDataSuspected,
  });
  const bypass = find((f) => f.source === "red" && f.host === "concesiones-v1" && !!f.matchedApiId);
  rows.push({
    prueba: "backend gobernado accesible sin gateway",
    esperado: "asociado a su API · motivo explícito",
    obtenido: bypass ? `${bypass.matchedApiId} · ${bypass.reasons.find((r) => r.includes("sin pasar por el gateway")) ? "motivo presente" : "sin motivo"}` : "no encontrado",
    cumple: !!bypass && bypass.reasons.some((r) => r.includes("sin pasar por el gateway")),
  });
  const ordered = findings.every((f, i) => i === 0 || findings[i - 1]!.exposureScore >= f.exposureScore);
  rows.push({ prueba: "hallazgos ordenados por exposición", esperado: true, obtenido: ordered, cumple: ordered });

  // Clasificación: solo quien tiene discovery:triage; se respeta en los escaneos siguientes.
  const denied = apisix ? await api(dev, "PATCH", `/discovery/findings/${apisix.id}`, { status: "en_migracion" }) : undefined;
  rows.push({ prueba: "desarrollador no puede clasificar", esperado: 403, obtenido: denied?.status, cumple: denied?.status === 403 });
  if (apisix) await api(approver, "PATCH", `/discovery/findings/${apisix.id}`, { status: "en_migracion", note: "Se migrará a WSO2 en la etapa 2" });
  const s2 = await scan(operator, ["apisix", "nginx", "red"]);
  const again = (await api<Finding[]>(approver, "GET", "/discovery/findings")).data;
  const kept = again.find((f) => f.id === apisix?.id);
  rows.push({
    prueba: "segundo escaneo sin duplicados",
    esperado: `${findings.length} hallazgos · 0 nuevos`,
    obtenido: `${again.length} hallazgos · ${s2.totals.nuevos} nuevos`,
    cumple: again.length === findings.length && s2.totals.nuevos === 0,
  });
  rows.push({ prueba: "se respeta la clasificación humana", esperado: "en_migracion", obtenido: kept?.status, cumple: kept?.status === "en_migracion" });

  const csv = await api<string>(approver, "GET", "/discovery/report?format=csv");
  const csvRows = csv.text.trim().split("\n").length - 1;
  rows.push({ prueba: "reporte CSV", esperado: `${again.length} filas`, obtenido: `${csvRows} filas`, cumple: csvRows === again.length });
  const pdf = await fetch(`${BASE}/discovery/report?format=pdf`, { headers: { authorization: `Bearer ${approver}` } });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  rows.push({
    prueba: "reporte PDF",
    esperado: "application/pdf",
    obtenido: `${pdf.headers.get("content-type")} · ${pdfBytes.length} bytes`,
    cumple: pdf.status === 200 && pdfBytes.subarray(0, 5).toString() === "%PDF-",
  });
  const audit = (await api<Array<{ action: string }>>(auditor, "GET", "/audit-events?limit=300")).data.map((e) => e.action);
  const needed = ["descubrimiento.escanear", "descubrimiento.escaneo.terminar", "descubrimiento.clasificar"];
  const missing = needed.filter((a) => !audit.includes(a));
  rows.push({ prueba: "escaneos y clasificación auditados", esperado: "todas", obtenido: missing.length ? `faltan ${missing.join(", ")}` : "todas", cumple: !missing.length });

  console.table(rows);
  const ok = rows.every((r) => r.cumple);
  console.log(ok ? "[D-01] verificado: descubrimiento, puntaje de exposición, clasificación y reportes" : "[D-01] NO cumple");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[D-01] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
