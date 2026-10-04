/**
 * Verificación de D-04 (despliegues canary y blue-green con reversa automática y sin corte de servicio):
 *   1. una versión mala se detecta en tráfico sombra y se revierte sin que ningún consumidor reciba un error;
 *   2. una versión buena avanza por sombra y 5/25/50/100 % y queda como estable, sin errores para los consumidores;
 *   3. un blue-green devuelve el tráfico a la versión anterior de una vez, sin errores.
 * Durante cada escenario corre carga de fondo a través del gateway (OAuth con Keycloak).
 *
 * Requisitos: laboratorio arriba (make up), motores y nexo-division, y la API Concesiones desplegada en prod
 * con "division" (make deploy-apis).
 */
import { fetch } from "undici";
import { runLoad, type LoadResult } from "./load.js";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const GATEWAY_URL = process.env.NEXO_D04_URL ?? "https://apim:8243/concesiones/1.0.0/concesiones";
const V1 = "http://concesiones-v1:7001";
const V2 = "http://concesiones-v2:7001";
const CHAOS_V2 = process.env.NEXO_LAB_CHAOS_V2 ?? "http://localhost:7011/_chaos";

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
    headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function chaos(failRate: number) {
  await fetch(CHAOS_V2, { method: "POST", headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" }, body: JSON.stringify({ failRate }) });
}

type Rollout = { id: string; status: string; rollbackReason?: string; stepsDone: Array<{ kind: string; weight: number; requests: number; decision: string }> };

/** Crea, aprueba (cuatro ojos) y sigue un despliegue mientras corre la carga de fondo. */
async function scenario(apiId: string, body: Record<string, unknown>, loadSeconds: number): Promise<{ rollout: Rollout; load: LoadResult; seconds: number }> {
  const dev = await token("ana.desarrollo");
  const approver = await token("luis.aprobador");
  const controller = new AbortController();
  const loadPromise = runLoad({ url: GATEWAY_URL, rps: 20, seconds: loadSeconds, signal: controller.signal });
  await sleep(4000);
  const created = await api<Rollout & { message?: string }>(dev, "POST", "/rollouts", { apiId, ...body });
  if (created.status !== 201) throw new Error(`no se pudo crear el despliegue: ${created.status} ${created.data.message ?? ""}`);
  const t0 = Date.now();
  const approved = await api<Rollout>(approver, "POST", `/rollouts/${created.data.id}/approve`);
  if (approved.status !== 200) throw new Error(`no se pudo aprobar: ${approved.status}`);
  let r = approved.data;
  while (r.status === "en_curso" && Date.now() - t0 < 300_000) {
    await sleep(2000);
    r = (await api<Rollout>(approver, "GET", `/rollouts/${r.id}`)).data;
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  await sleep(3000); // la carga sigue unos segundos después del final del despliegue
  controller.abort();
  return { rollout: r, load: await loadPromise, seconds };
}

async function main() {
  const viewer = await token("luis.aprobador");
  const routes = (await api<Array<{ apiId: string; apiName: string; stableUrl: string; rolloutId?: string }>>(viewer, "GET", "/traffic-routes")).data;
  const route = routes.find((x) => x.apiName.startsWith("Concesiones "));
  if (!route) throw new Error("La API Concesiones no pasa por nexo-division (despliéguela en prod con make deploy-apis)");
  if (route.rolloutId) throw new Error("Hay un despliegue en curso en la ruta; espere a que termine");
  if (route.stableUrl !== V1) {
    console.log(`[D-04] la ruta está en ${route.stableUrl}; se vuelve a ${V1} antes de verificar`);
    await scenario(route.apiId, { strategy: "blue_green", candidateEndpoint: V1, stepDurationSec: 10, thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 1 } }, 30);
  }
  const rows: Array<Record<string, unknown>> = [];
  const thresholds = { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 10 };

  // 1) Versión mala: falla todo lo que recibe. Debe revertirse en sombra, sin errores para los consumidores.
  await chaos(1);
  let bad: Awaited<ReturnType<typeof scenario>>;
  try {
    bad = await scenario(route.apiId, { strategy: "canary", candidateEndpoint: V2, shadowSeconds: 30, steps: [5, 25, 50, 100], stepDurationSec: 15, thresholds }, 45);
  } finally {
    await chaos(0);
  }
  rows.push({
    escenario: "versión mala con sombra",
    esperado: "revertido en sombra · 0 errores",
    obtenido: `${bad.rollout.status} en ${bad.rollout.stepsDone.at(-1)?.kind ?? "?"} a los ${bad.seconds} s · ${bad.load.errores} errores de ${bad.load.llamadas}`,
    cumple: bad.rollout.status === "revertido" && bad.rollout.stepsDone.at(-1)?.kind === "sombra" && bad.load.errores === 0,
  });

  // 2) Versión buena: sombra y pasos de 5, 25, 50 y 100 %; queda como estable.
  const good = await scenario(route.apiId, { strategy: "canary", candidateEndpoint: V2, shadowSeconds: 15, steps: [5, 25, 50, 100], stepDurationSec: 15, thresholds }, 150);
  const both = (good.load.porVersion["1.0.0"] ?? 0) > 0 && (good.load.porVersion["1.1.0"] ?? 0) > 0;
  rows.push({
    escenario: "versión buena: sombra + 5/25/50/100 %",
    esperado: "completado · 0 errores · ambas versiones atendieron",
    obtenido: `${good.rollout.status} en ${good.seconds} s (${good.rollout.stepsDone.map((s) => (s.kind === "sombra" ? "sombra" : `${s.weight}%`)).join("→")}) · ${good.load.errores} errores de ${good.load.llamadas}`,
    cumple: good.rollout.status === "completado" && good.load.errores === 0 && both,
  });

  // 3) Blue-green de vuelta a la versión anterior, de una vez.
  const bg = await scenario(route.apiId, { strategy: "blue_green", candidateEndpoint: V1, stepDurationSec: 15, thresholds }, 35);
  rows.push({
    escenario: "blue-green de vuelta a 1.0.0",
    esperado: "completado · 0 errores",
    obtenido: `${bg.rollout.status} en ${bg.seconds} s · ${bg.load.errores} errores de ${bg.load.llamadas}`,
    cumple: bg.rollout.status === "completado" && bg.load.errores === 0,
  });

  console.table(rows);
  const ok = rows.every((r) => r.cumple);
  console.log(ok ? "[D-04] verificado: reversa automática y despliegues sin corte de servicio" : "[D-04] NO cumple");
  if (!ok) process.exit(1);
}

main().catch(async (e) => {
  await chaos(0).catch(() => undefined);
  console.error("[D-04] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
