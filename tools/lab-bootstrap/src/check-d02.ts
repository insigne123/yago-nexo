/**
 * Verificación de D-02 (guardián de anomalías con bloqueo configurable):
 *   1. bloqueo automático: un consumidor irrumpe con un volumen anómalo, el guardián lo bloquea en el gateway
 *      (deny policy de WSO2, HTTP 403) y el bloqueo se levanta solo al cumplir su duración;
 *   2. bloqueo con aprobación: el guardián propone el bloqueo, una persona distinta lo aprueba (cuatro ojos),
 *      el consumidor queda bloqueado y un aprobador lo libera.
 * Cada acción queda en la auditoría encadenada.
 */
import { fetch, Agent } from "undici";
import { appToken, runLoad } from "./load.js";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const GATEWAY_URL = process.env.NEXO_D02_URL ?? "https://apim:8243/concesiones/1.0.0/concesiones";
const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(username: string) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", username, password: PASSWORD }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api<T>(tok: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function gatewayStatus(appTok: string): Promise<number> {
  const res = await fetch(GATEWAY_URL, { dispatcher: insecure, headers: { authorization: `Bearer ${appTok}` } });
  await res.arrayBuffer();
  return res.status;
}

/** Espera hasta que el gateway responda el código esperado; devuelve los segundos que tomó. */
async function waitGateway(expected: number, timeoutSec: number): Promise<number | undefined> {
  const t0 = Date.now();
  const tok = await appToken("OperadorDemo");
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if ((await gatewayStatus(tok)) === expected) return Math.round((Date.now() - t0) / 1000);
    await sleep(1000);
  }
  return undefined;
}

type Rule = { id: string; name: string; enabled: boolean; metric: string; sensitivity: number; minVolume: number; action: string; blockTtlMinutes: number; apiId?: string };
type Anomaly = { id: string; ruleId: string; status: string; consumer?: string; blockId?: string; observed: number; baseline: number; score: number };
type Block = { id: string; active: boolean; conditionValue: string; releasedBy?: string };

async function main() {
  const admin = await token("admin.nexo");
  const approver = await token("luis.aprobador");
  const auditor = await token("pedro.auditoria");
  const apis = (await api<Array<{ wso2ApiId: string; name: string }>>(approver, "GET", "/apis?q=Concesiones")).data;
  const apiId = apis.find((a) => a.name === "Concesiones")?.wso2ApiId;
  if (!apiId) throw new Error("falta la API Concesiones en el catálogo");

  // Las reglas existentes se desactivan durante la verificación y se restauran al final.
  const previous = (await api<Rule[]>(admin, "GET", "/anomaly-rules")).data.filter((r) => r.enabled);
  const setEnabled = (r: Rule, enabled: boolean) =>
    api(admin, "PATCH", `/anomaly-rules/${r.id}`, {
      name: r.name,
      apiId: r.apiId,
      metric: r.metric,
      sensitivity: r.sensitivity,
      minVolume: r.minVolume,
      action: r.action,
      blockTtlMinutes: r.blockTtlMinutes,
      enabled,
    });
  for (const r of previous) await setEnabled(r, false);
  const rows: Array<Record<string, unknown>> = [];
  const stamp = new Date().toISOString().slice(11, 19);

  try {
    // ------------------------------------------------------------ 1) bloqueo automático con vencimiento
    const auto = (
      await api<Rule>(admin, "POST", "/anomaly-rules", {
        name: `Verificación D-02 automático ${stamp}`,
        apiId,
        metric: "volumen",
        sensitivity: 6,
        minVolume: 30,
        action: "bloquear_automatico",
        blockTtlMinutes: 1,
        enabled: true,
      })
    ).data;
    await runLoad({ url: GATEWAY_URL, rps: 2, seconds: 35 }); // tráfico normal previo
    const ctrl = new AbortController();
    const burstStart = Date.now();
    let blockedAt: number | undefined;
    const burst = runLoad({
      url: GATEWAY_URL,
      rps: 20,
      seconds: 150,
      signal: ctrl.signal,
      onSecond: (s) => {
        if (s.ok === 0 && s.errores > 0 && blockedAt === undefined) {
          blockedAt = Date.now();
          setTimeout(() => ctrl.abort(), 3000);
        }
      },
    });
    const load = await burst;
    const ev = (await api<Anomaly[]>(approver, "GET", "/anomalies")).data.find((e) => e.ruleId === auto.id);
    const detectSec = blockedAt ? Math.round((blockedAt - burstStart) / 1000) : undefined;
    rows.push({
      prueba: "abuso detectado y bloqueado en el gateway",
      esperado: "bloqueada · 403 en menos de 2 min",
      obtenido: `${ev?.status ?? "sin evento"} · ${load.porCodigo["403"] ?? 0} respuestas 403 · a los ${detectSec ?? "—"} s`,
      cumple: ev?.status === "bloqueada" && !!detectSec && detectSec < 120 && (load.porCodigo["403"] ?? 0) > 0,
    });
    const releaseSec = await waitGateway(200, 150);
    const block = (await api<Block[]>(approver, "GET", "/blocks")).data.find((b) => b.id === ev?.blockId);
    rows.push({
      prueba: "bloqueo se levanta solo al vencer (1 min)",
      esperado: "liberado por nexo-guardian · acceso 200",
      obtenido: `${block?.active === false ? `liberado por ${block.releasedBy}` : "sigue activo"} · acceso ${releaseSec === undefined ? "no volvió" : `200 tras ${releaseSec} s`}`,
      cumple: block?.active === false && block.releasedBy === "nexo-guardian" && releaseSec !== undefined,
    });
    await setEnabled(auto, false);

    // ------------------------------------------------------------ 2) bloqueo con aprobación (cuatro ojos)
    await sleep(35_000); // la ráfaga anterior sale de la ventana actual
    const manual = (
      await api<Rule>(admin, "POST", "/anomaly-rules", {
        name: `Verificación D-02 con aprobación ${stamp}`,
        apiId,
        metric: "volumen",
        sensitivity: 6,
        minVolume: 30,
        action: "bloquear_con_aprobacion",
        blockTtlMinutes: 10,
        enabled: true,
      })
    ).data;
    const ctrl2 = new AbortController();
    const burst2 = runLoad({ url: GATEWAY_URL, rps: 20, seconds: 150, signal: ctrl2.signal });
    let proposed: Anomaly | undefined;
    for (let i = 0; i < 50 && !proposed; i++) {
      await sleep(3000);
      proposed = (await api<Anomaly[]>(approver, "GET", "/anomalies?status=bloqueo_propuesto")).data.find((e) => e.ruleId === manual.id);
    }
    ctrl2.abort();
    const load2 = await burst2;
    rows.push({
      prueba: "propone el bloqueo sin bloquear",
      esperado: "bloqueo_propuesto · sin 403",
      obtenido: `${proposed?.status ?? "sin propuesta"} · ${load2.porCodigo["403"] ?? 0} respuestas 403`,
      cumple: proposed?.status === "bloqueo_propuesto" && !(load2.porCodigo["403"] ?? 0),
    });
    if (proposed) {
      const dev = await token("ana.desarrollo");
      const denied = await api(dev, "POST", `/anomalies/${proposed.id}/approve-block`);
      rows.push({ prueba: "un desarrollador no puede aprobar", esperado: 403, obtenido: denied.status, cumple: denied.status === 403 });
      const approved = await api<Anomaly>(approver, "POST", `/anomalies/${proposed.id}/approve-block`);
      const enforcedSec = await waitGateway(403, 60);
      rows.push({
        prueba: "aprobador aprueba y el gateway bloquea",
        esperado: "bloqueada · 403",
        obtenido: `${approved.data.status} · ${enforcedSec === undefined ? "sin 403" : `403 tras ${enforcedSec} s`}`,
        cumple: approved.data.status === "bloqueada" && enforcedSec !== undefined,
      });
      const released = await api<Block>(approver, "POST", `/blocks/${approved.data.blockId}/release`, { reason: "Verificación D-02: consumidor contactado" });
      const backSec = await waitGateway(200, 60);
      rows.push({
        prueba: "aprobador libera y vuelve el acceso",
        esperado: "liberado · 200",
        obtenido: `${released.data.active === false ? "liberado" : `HTTP ${released.status}`} · ${backSec === undefined ? "sin acceso" : `200 tras ${backSec} s`}`,
        cumple: released.data.active === false && backSec !== undefined,
      });
    }
    await setEnabled(manual, false);

    // ------------------------------------------------------------ auditoría
    const audit = (await api<Array<{ action: string }>>(auditor, "GET", "/audit-events?limit=300")).data.map((e) => e.action);
    const needed = ["anomalias.bloqueo.automatico", "anomalias.bloqueo.vencer", "anomalias.detectar", "anomalias.bloqueo.aprobar", "anomalias.bloqueo.liberar"];
    const missing = needed.filter((a) => !audit.includes(a));
    rows.push({ prueba: "cada acción queda auditada", esperado: "todas", obtenido: missing.length ? `faltan ${missing.join(", ")}` : "todas", cumple: !missing.length });
    const chain = await api<{ ok: boolean }>(auditor, "GET", "/audit-events/verify");
    rows.push({ prueba: "cadena de auditoría íntegra", esperado: true, obtenido: chain.data.ok, cumple: chain.data.ok === true });
  } finally {
    for (const r of previous) await setEnabled(r, true);
  }

  console.table(rows);
  const ok = rows.every((r) => r.cumple);
  console.log(ok ? "[D-02] verificado: detección, bloqueo automático y con aprobación, vencimiento y liberación" : "[D-02] NO cumple");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[D-02] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
