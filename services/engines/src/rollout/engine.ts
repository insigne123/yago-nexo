import type { Server } from "node:http";
import { Counter, Gauge } from "@prometheus-io/client";
import { bool, env, gatewaysFor, num, opt } from "../kit/config.js";
import type { Engine, EngineContext } from "../kit/runtime.js";
import { startControlPlane } from "./control-plane.js";
import { clusterReady, delta, mergeSnapshots, parseEnvoyStats, toVersionMetrics, type StatsSnapshot } from "./envoy-stats.js";
import { decide, errorRate, type Thresholds } from "./gates.js";
import { discoverRoutes, upsertRoutes } from "./routes.js";
import { basePath, clusterName, slugOf } from "./xds.js";

/**
 * Motor de despliegues progresivos (D-04), sin corte de servicio.
 *
 * El tráfico de la API pasa por nexo-division (Envoy) y el motor es su plano de control: cada paso cambia
 * pesos o tráfico sombra en vivo (Envoy los aplica en ~1 s sin cortar conexiones). La API no se redespliega
 * en WSO2 durante el despliegue, así que no hay ventana sin servicio. Flujo:
 *   1. sombra (opcional): el candidato recibe una copia de las lecturas y sus respuestas se descartan;
 *   2. canary: pasos de peso (p. ej. 5, 25, 50 y 100 %) con compuertas de error y latencia p99;
 *      blue-green: 100 % de una vez, con el estable listo para volver al instante;
 *   3. al terminar, el candidato pasa a ser el estable de la ruta.
 * Cualquier compuerta fallida revierte al estable en el acto. Las métricas por versión salen de Envoy.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ENVIRONMENT = env("NEXO_DIVISION_ENV", "prod");
const DIVISION_URL = env("NEXO_DIVISION_URL", "http://nexo-division:10000");
const ADMIN_URLS = env("NEXO_DIVISION_ADMIN_URLS", "http://nexo-division:9901")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROUTE_SYNC_MS = num("NEXO_DIVISION_SYNC_MS", 30_000);

let stepsTotal: Counter<"estrategia" | "tipo">;
let rollbacksTotal: Counter<"tipo">;
let weightGauge: Gauge<"api">;
let controlPlane: Server | undefined;
let lastSync = 0;
const revisionCache = new Map<string, { prefix: string; seedUrl: string } | null>();

async function syncRoutes(ctx: EngineContext): Promise<number> {
  const gateway = gatewaysFor(ENVIRONMENT)[0]!.name;
  const declared = await discoverRoutes(ctx.wso2(), gateway, DIVISION_URL, revisionCache);
  const changed = await upsertRoutes(ctx.db, ENVIRONMENT, declared);
  // Rutas que ya no declara ninguna API (y sin despliegue en curso) dejan de existir.
  await ctx.db.query("DELETE FROM nexo.traffic_route WHERE environment = $1 AND rollout_id IS NULL AND NOT (api_id = ANY($2::text[]))", [
    ENVIRONMENT,
    declared.map((d) => d.apiId),
  ]);
  lastSync = Date.now();
  return changed;
}

/** Contadores de Envoy de los clústeres de la ruta en cada réplica (sin sumar). */
async function replicaSnapshots(prefix: string, urls: readonly string[]): Promise<StatsSnapshot[]> {
  const names = urls.map((u) => clusterName(prefix, u));
  const filter = encodeURIComponent(`cluster\\.${slugOf(prefix)}__`);
  return Promise.all(
    ADMIN_URLS.map(async (u) => {
      const res = await fetch(`${u}/stats/prometheus?filter=${filter}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`nexo-division (${u}) respondió ${res.status} a /stats`);
      return parseEnvoyStats(await res.text(), names);
    }),
  );
}

/** Contadores sumados de todas las réplicas, por nombre de clúster. */
async function snapshot(prefix: string, urls: readonly string[]): Promise<StatsSnapshot> {
  return mergeSnapshots(await replicaSnapshots(prefix, urls));
}

async function route(ctx: EngineContext, r: Row): Promise<Row | undefined> {
  return (await ctx.db.query("SELECT * FROM nexo.traffic_route WHERE api_id = $1 AND environment = $2", [r.api_id, r.environment])).rows[0];
}

async function setRoute(ctx: EngineContext, apiId: string, fields: { candidate: string | null; weight: number; mirror: number; rolloutId: string | null; stable?: string }) {
  await ctx.db.query(
    `UPDATE nexo.traffic_route SET candidate_url = $1, weight = $2, mirror_percent = $3, rollout_id = $4,
       stable_url = COALESCE($5, stable_url), version = version + 1, updated_at = now()
     WHERE api_id = $6 AND environment = $7`,
    [fields.candidate, fields.weight, fields.mirror, fields.rolloutId, fields.stable ?? null, apiId, ENVIRONMENT],
  );
}

async function beginStep(ctx: EngineContext, r: Row, rt: Row, kind: "sombra" | "canary" | "blue_green", weight: number) {
  const mirror = kind === "sombra" ? 100 : 0;
  await setRoute(ctx, r.api_id, { candidate: r.candidate_endpoint, weight, mirror, rolloutId: r.id });
  const baseline = await snapshot(rt.route_prefix, [rt.stable_url, r.candidate_endpoint]).catch(() => ({}));
  const detail =
    kind === "sombra"
      ? "tráfico sombra: el candidato recibe una copia de las lecturas; los consumidores siguen en la versión estable"
      : `${weight} % del tráfico al candidato`;
  await ctx.db.query("INSERT INTO nexo.rollout_step (rollout_id, weight, kind, baseline, detail) VALUES ($1,$2,$3,$4,$5)", [
    r.id,
    weight,
    kind,
    JSON.stringify(baseline),
    detail,
  ]);
  await ctx.db.query("UPDATE nexo.rollout SET current_weight = $1, updated_at = now() WHERE id = $2", [weight, r.id]);
  stepsTotal.inc({ estrategia: r.strategy, tipo: kind });
  weightGauge.set({ api: r.api_name ?? r.api_id }, weight);
  await ctx.audit("despliegue.paso", `rollout/${r.id}`, "exito", { tipo: kind, peso: weight, sombra: mirror, ruta: rt.route_prefix });
  ctx.log("info", `despliegue ${r.api_name}: ${detail}`, { rollout: r.id });
}

async function finish(ctx: EngineContext, r: Row, status: "revertido" | "abortado", reason: string, kind: "automatica" | "manual") {
  await setRoute(ctx, r.api_id, { candidate: null, weight: 0, mirror: 0, rolloutId: null });
  await ctx.db.query(
    "UPDATE nexo.rollout_step SET decision = 'revertir', ended_at = now(), detail = coalesce(detail || ' · ', '') || $2 WHERE rollout_id = $1 AND decision = 'pendiente'",
    [r.id, reason],
  );
  await ctx.db.query("UPDATE nexo.rollout SET status = $1, rollback_reason = $2, current_weight = 0, finished_at = now(), updated_at = now() WHERE id = $3", [
    status,
    reason,
    r.id,
  ]);
  rollbacksTotal.inc({ tipo: kind });
  weightGauge.set({ api: r.api_name ?? r.api_id }, 0);
  await ctx.audit(kind === "automatica" ? "despliegue.revertir" : "despliegue.detener", `rollout/${r.id}`, "exito", { motivo: reason, estable: r.stable_endpoint });
  await ctx.alert({
    name: kind === "automatica" ? "DespliegueRevertido" : "DespliegueDetenido",
    severity: kind === "automatica" ? "S3" : "S4",
    summary: `${r.api_name}: ${kind === "automatica" ? "reversa automática" : "despliegue detenido"} — ${reason}`,
    labels: { api: String(r.api_name ?? r.api_id) },
  });
  ctx.log("warn", `despliegue ${r.api_name} ${status}: ${reason}`, { rollout: r.id });
}

async function abortBeforeStart(ctx: EngineContext, r: Row, reason: string) {
  await ctx.db.query("UPDATE nexo.rollout SET status = 'abortado', rollback_reason = $1, finished_at = now(), updated_at = now() WHERE id = $2", [reason, r.id]);
  await ctx.audit("despliegue.abortar", `rollout/${r.id}`, "error", { motivo: reason });
  ctx.log("warn", `despliegue ${r.api_name} no se inició: ${reason}`, { rollout: r.id });
}

async function start(ctx: EngineContext, r: Row) {
  let rt = await route(ctx, r);
  if (!rt && Date.now() - lastSync > 5000) {
    await syncRoutes(ctx);
    rt = await route(ctx, r);
  }
  if (!rt) {
    return abortBeforeStart(
      ctx,
      r,
      `La API no pasa por nexo-division en ${r.environment}: su endpoint en el gateway debe ser ${DIVISION_URL}/rutas/<nombre> (declare "division" en el proyecto de la API)`,
    );
  }
  if (rt.rollout_id && rt.rollout_id !== r.id) return; // otra ejecución tiene la ruta; se reintenta en la próxima vuelta
  if (basePath(r.candidate_endpoint) !== basePath(rt.stable_url)) {
    return abortBeforeStart(ctx, r, `El candidato debe tener la misma ruta base que el estable (${basePath(rt.stable_url) || "/"})`);
  }
  if (r.strategy === "blue_green") {
    const probe = await fetch(r.candidate_endpoint, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (!probe || probe.status >= 500) return abortBeforeStart(ctx, r, `El candidato no responde (${probe ? `HTTP ${probe.status}` : "sin conexión"}); no se movió tráfico`);
  }
  // Crear antes de usar: el candidato entra a la ruta con peso 0 y el primer paso espera a que Envoy lo tenga listo.
  await setRoute(ctx, r.api_id, { candidate: r.candidate_endpoint, weight: 0, mirror: 0, rolloutId: r.id });
  await ctx.db.query("UPDATE nexo.rollout SET stable_endpoint = $1, started_at = now(), updated_at = now() WHERE id = $2", [rt.stable_url, r.id]);
  await ctx.audit("despliegue.iniciar", `rollout/${r.id}`, "exito", { ruta: rt.route_prefix, estable: rt.stable_url, candidato: r.candidate_endpoint });
  ctx.log("info", `despliegue ${r.api_name}: preparando el candidato en nexo-division`, { rollout: r.id });
}

/** Primer paso, cuando todas las réplicas de Envoy tienen el clúster del candidato con su host resuelto. */
async function firstStep(ctx: EngineContext, r: Row, rt: Row) {
  const snaps = await replicaSnapshots(rt.route_prefix, [rt.stable_url, r.candidate_endpoint]);
  if (!clusterReady(snaps, clusterName(rt.route_prefix, r.candidate_endpoint))) {
    const waited = (Date.now() - new Date(r.started_at).getTime()) / 1000;
    if (waited > num("NEXO_DIVISION_READY_TIMEOUT_SEC", 30)) {
      return finish(ctx, r, "abortado", `nexo-division no pudo preparar el candidato en ${Math.round(waited)} s (¿el nombre del backend resuelve?)`, "automatica");
    }
    return;
  }
  if (Number(r.shadow_seconds) > 0) return beginStep(ctx, r, rt, "sombra", 0);
  return beginStep(ctx, r, rt, r.strategy === "blue_green" ? "blue_green" : "canary", r.strategy === "blue_green" ? 100 : (r.steps as number[])[0]!);
}

async function evaluate(ctx: EngineContext, r: Row) {
  const rt = await route(ctx, r);
  if (!rt) return finish(ctx, r, "abortado", "La ruta de la API ya no existe en nexo-division", "automatica");
  const step = (await ctx.db.query("SELECT * FROM nexo.rollout_step WHERE rollout_id = $1 ORDER BY id DESC LIMIT 1", [r.id])).rows[0];
  if (!step) return firstStep(ctx, r, rt);
  if (step.decision !== "pendiente") return;
  const now = await snapshot(rt.route_prefix, [rt.stable_url, r.candidate_endpoint]);
  const base = (step.baseline ?? {}) as StatsSnapshot;
  const cName = clusterName(rt.route_prefix, r.candidate_endpoint);
  const sName = clusterName(rt.route_prefix, rt.stable_url);
  const m = { candidate: toVersionMetrics(delta(now[cName], base[cName])), stable: toVersionMetrics(delta(now[sName], base[sName])) };
  await ctx.db.query("UPDATE nexo.rollout_step SET requests = $1, error_rate = $2, p99_ms = $3 WHERE id = $4", [
    m.candidate.requests,
    errorRate(m.candidate),
    m.candidate.p99Ms ?? null,
    step.id,
  ]);
  const elapsed = (Date.now() - new Date(step.started_at).getTime()) / 1000;
  const duration = step.kind === "sombra" ? Number(r.shadow_seconds) : Number(r.step_duration_sec);
  const d = decide(m, r.thresholds as Thresholds, elapsed, duration);
  if (d.action === "revertir") {
    const where = step.kind === "sombra" ? "en tráfico sombra (ningún consumidor recibió sus respuestas)" : `con ${step.weight} % del tráfico`;
    return finish(ctx, r, "revertido", `${d.reason}, ${where}`, "automatica");
  }
  if (d.action === "esperar") {
    if (!d.reason.startsWith("paso en observación") && !String(step.detail ?? "").endsWith(d.reason)) {
      await ctx.db.query("UPDATE nexo.rollout_step SET detail = split_part(coalesce(detail, ''), ' · ', 1) || ' · ' || $2 WHERE id = $1", [step.id, d.reason]);
    }
    return;
  }
  await ctx.db.query("UPDATE nexo.rollout_step SET decision = 'avanzar', ended_at = now(), detail = split_part(coalesce(detail, ''), ' · ', 1) || ' · ' || $2 WHERE id = $1", [
    step.id,
    d.reason,
  ]);
  const steps = r.steps as number[];
  if (r.strategy === "blue_green") {
    if (step.kind === "sombra") return beginStep(ctx, r, rt, "blue_green", 100);
  } else {
    const next = step.kind === "sombra" ? steps[0] : steps.find((w) => w > Number(step.weight));
    if (next !== undefined) return beginStep(ctx, r, rt, "canary", next);
  }
  // Terminado: el candidato pasa a ser el estable de la ruta.
  await setRoute(ctx, r.api_id, { candidate: null, weight: 0, mirror: 0, rolloutId: null, stable: r.candidate_endpoint });
  await ctx.db.query("UPDATE nexo.rollout SET status = 'completado', current_weight = 100, finished_at = now(), updated_at = now() WHERE id = $1", [r.id]);
  weightGauge.set({ api: r.api_name ?? r.api_id }, 0);
  await ctx.audit("despliegue.completar", `rollout/${r.id}`, "exito", { nuevoEstable: r.candidate_endpoint, estableAnterior: r.stable_endpoint });
  await ctx.alert({
    name: "DespliegueCompletado",
    severity: "S4",
    summary: `${r.api_name}: ${r.candidate_endpoint} es la nueva versión estable. Actualice "division_estable" en el proyecto versionado.`,
    labels: { api: String(r.api_name ?? r.api_id) },
    ttlMinutes: 10,
  });
  ctx.log("info", `despliegue ${r.api_name} completado: ${r.candidate_endpoint} es el nuevo estable`, { rollout: r.id });
}

export const rolloutEngine: Engine = {
  name: "despliegues",
  lockKey: 727103,
  intervalMs: num("NEXO_ROLLOUT_INTERVAL_MS", 2000),
  async init(ctx) {
    stepsTotal = new Counter({ name: "nexo_despliegue_pasos_total", help: "Pasos de despliegue aplicados", labelNames: ["estrategia", "tipo"], registers: [ctx.registry] });
    rollbacksTotal = new Counter({ name: "nexo_despliegue_reversas_total", help: "Reversas automáticas y detenciones manuales", labelNames: ["tipo"], registers: [ctx.registry] });
    weightGauge = new Gauge({ name: "nexo_despliegue_peso_candidato", help: "Peso actual del candidato por API", labelNames: ["api"], registers: [ctx.registry] });
    // El plano de control xDS lo atienden todas las réplicas (solo lee la base); el trabajo, solo la líder.
    controlPlane ??= startControlPlane({
      db: ctx.db,
      environment: ENVIRONMENT,
      port: num("NEXO_XDS_PORT", 9466),
      tls: { caFile: opt("NEXO_DIVISION_TLS_CA"), insecure: bool("NEXO_DIVISION_TLS_INSECURE", false) },
      log: ctx.log,
    });
  },
  async tick(ctx) {
    if (Date.now() - lastSync > ROUTE_SYNC_MS) {
      await syncRoutes(ctx).catch((e: unknown) => ctx.log("warn", "no se pudieron sincronizar las rutas", { error: e instanceof Error ? e.message : String(e) }));
    }
    const rows = (await ctx.db.query("SELECT * FROM nexo.rollout WHERE finished_at IS NULL AND status IN ('en_curso', 'abortado') ORDER BY created_at")).rows;
    for (const r of rows) {
      try {
        if (r.status === "abortado") {
          if (r.started_at) await finish(ctx, r, "abortado", r.rollback_reason ?? "detenido manualmente", "manual");
          else await ctx.db.query("UPDATE nexo.rollout SET finished_at = now() WHERE id = $1", [r.id]);
        } else if (!r.started_at) await start(ctx, r);
        else await evaluate(ctx, r);
      } catch (e) {
        ctx.log("error", `despliegue ${r.api_name}: ${e instanceof Error ? e.message : String(e)}`, { rollout: r.id });
      }
    }
    const routes = (await ctx.db.query("SELECT count(*)::int AS n FROM nexo.traffic_route WHERE environment = $1", [ENVIRONMENT])).rows[0];
    return { desplieguesActivos: rows.length, rutas: routes?.n ?? 0, ambiente: ENVIRONMENT };
  },
};
