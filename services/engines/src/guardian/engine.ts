import { Counter, Gauge } from "@prometheus-io/client";
import { createBlock, releaseBlock } from "@nexo/console-db";
import { env, num } from "../kit/config.js";
import type { Engine, EngineContext } from "../kit/runtime.js";
import { describe, detect, isBusinessHours, type Metric } from "./detect.js";
import { buildQuery, parseSeries, type SeriesResponse } from "./series.js";

/**
 * Guardián de anomalías (D-02). Cada ventana (60 s por defecto) evalúa las reglas activas sobre la analítica
 * del gateway: volumen, errores, latencia, tamaño de respuestas, IP distintas y uso fuera de horario, por
 * consumidor. Según la regla: solo alerta, propone un bloqueo que una persona aprueba (cuatro ojos) o bloquea
 * de inmediato con duración limitada (deny policy de WSO2). Los bloqueos vencidos se levantan solos.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WINDOW_SEC = num("NEXO_GUARDIAN_WINDOW_SEC", 60);
const LAG_SEC = num("NEXO_GUARDIAN_LAG_SEC", 20);
const BASELINE_WINDOWS = num("NEXO_GUARDIAN_BASELINE_WINDOWS", 60);
const BUSINESS_HOURS = env("NEXO_HORARIO_HABIL", "1-5 08:00-20:00");
const TIME_ZONE = env("NEXO_ZONA_HORARIA", "America/Santiago");
/** Aplicaciones que nunca se bloquean automáticamente ("dueño:aplicación", separadas por coma); solo se alerta. */
const NEVER_BLOCK = new Set(
  env("NEXO_GUARDIAN_NO_BLOQUEAR", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const lastEvaluated = new Map<string, number>();
let detections: Counter<"metrica" | "accion">;
let activeBlocks: Gauge;

async function expireBlocks(ctx: EngineContext): Promise<number> {
  const expired = (await ctx.db.query("SELECT * FROM nexo.block WHERE active AND expires_at IS NOT NULL AND expires_at < now()")).rows;
  for (const b of expired) {
    await releaseBlock(ctx.db, ctx.wso2().admin, String(b.id), "nexo-guardian");
    await ctx.audit("anomalias.bloqueo.vencer", `bloqueo/${b.id}`, "exito", { objetivo: b.condition_value, tipo: b.condition_type });
    await ctx.alert({ name: "BloqueoVencido", severity: "S4", summary: `Se levantó el bloqueo de ${b.condition_value} al cumplirse su duración`, ttlMinutes: 10 });
  }
  return expired.length;
}

async function evaluateRule(ctx: EngineContext, rule: Row, endMs: number, blocked: Set<string>): Promise<number> {
  const metric = rule.metric as Metric;
  const fromMs = endMs - (BASELINE_WINDOWS + 1) * WINDOW_SEC * 1000;
  const res = await ctx.os().search<SeriesResponse>(
    env("NEXO_OPENSEARCH_METRICS_INDEX", "nexo-apim-metrics-*"),
    buildQuery(metric, fromMs, endMs, WINDOW_SEC, { apiId: rule.api_id, consumerId: rule.consumer_id }),
  );
  const windowStart = new Date(endMs - WINDOW_SEC * 1000);
  const offHours = !isBusinessHours(windowStart, BUSINESS_HOURS, TIME_ZONE);
  const apiName = rule.api_id ? ((await ctx.db.query("SELECT name, version FROM nexo.api_asset WHERE wso2_api_id = $1", [rule.api_id])).rows[0] ?? null) : null;
  let found = 0;
  for (const s of parseSeries(metric, res, fromMs, endMs, WINDOW_SEC)) {
    const current = s.windows.at(-1)!;
    if (current.calls === 0) continue;
    const d = detect(metric, current, s.windows.slice(0, -1), Number(rule.sensitivity), Number(rule.min_volume), offHours);
    if (!d.anomalous) continue;
    const target = `${s.owner}:${s.name}`;
    if (blocked.has(target)) continue; // ya bloqueado: sus llamadas rechazadas no generan nuevos eventos
    const action = rule.action !== "alertar" && NEVER_BLOCK.has(target) ? "alertar" : String(rule.action);
    const status = action === "alertar" ? "abierta" : action === "bloquear_con_aprobacion" ? "bloqueo_propuesto" : "bloqueada";
    const inserted = (
      await ctx.db.query(
        `INSERT INTO nexo.anomaly_event (rule_id, api_name, consumer, source_ip, metric, observed, baseline, score, window_start, action_taken, status, detected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'nexo-guardian')
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          rule.id,
          apiName ? `${apiName.name} ${apiName.version}` : null,
          target,
          null, // la unicidad es por consumidor y ventana; la IP principal va en la auditoría
          metric,
          d.observed,
          d.baseline,
          d.score,
          windowStart.toISOString(),
          action === "bloquear_automatico" ? "bloqueo_automatico" : action === "bloquear_con_aprobacion" ? "bloqueo_propuesto" : "alerta",
          status,
        ],
      )
    ).rows[0];
    if (!inserted) continue; // ventana ya evaluada (otra réplica o reinicio)
    found++;
    detections.inc({ metrica: metric, accion: action });
    const where = apiName ? ` en ${apiName.name}` : "";
    if (action === "bloquear_automatico") {
      const block = await createBlock(ctx.db, ctx.wso2().admin, {
        conditionType: "APPLICATION",
        conditionValue: target,
        reason: `Bloqueo automático por regla "${rule.name}": ${d.reason}`,
        ttlMinutes: Number(rule.block_ttl_minutes),
        createdBy: "nexo-guardian",
      });
      await ctx.db.query("UPDATE nexo.anomaly_event SET block_id = $1 WHERE id = $2", [block.id, inserted.id]);
      blocked.add(target);
      await ctx.audit("anomalias.bloqueo.automatico", `anomalia/${inserted.id}`, "exito", { regla: rule.name, objetivo: target, bloqueo: block.id, motivo: d.reason, ipPrincipal: s.topIp });
      await ctx.alert({
        name: "ConsumidorBloqueado",
        severity: "S2",
        summary: `${s.name}${where}: bloqueado por ${rule.block_ttl_minutes} min — ${describe(metric, d.observed)} (línea base ${describe(metric, d.baseline)})`,
        labels: { consumidor: target },
      });
    } else {
      await ctx.audit("anomalias.detectar", `anomalia/${inserted.id}`, "exito", { regla: rule.name, objetivo: target, accion: action, motivo: d.reason, ipPrincipal: s.topIp });
      await ctx.alert({
        name: action === "alertar" ? "AnomaliaDetectada" : "BloqueoPorAprobar",
        severity: action === "alertar" ? "S3" : "S2",
        summary: `${s.name}${where}: ${d.reason}${action === "bloquear_con_aprobacion" ? " — bloqueo propuesto, requiere aprobación" : ""}`,
        labels: { consumidor: target },
      });
    }
    ctx.log("warn", `anomalía ${metric} de ${target}${where}: ${d.reason}`, { regla: rule.id, accion: action });
  }
  return found;
}

export const guardianEngine: Engine = {
  name: "guardian",
  lockKey: 727102,
  intervalMs: num("NEXO_GUARDIAN_INTERVAL_MS", 15_000),
  async init(ctx) {
    detections = new Counter({ name: "nexo_guardian_anomalias_total", help: "Anomalías detectadas por métrica y acción", labelNames: ["metrica", "accion"], registers: [ctx.registry] });
    activeBlocks = new Gauge({ name: "nexo_guardian_bloqueos_activos", help: "Bloqueos activos en el gateway", registers: [ctx.registry] });
  },
  async tick(ctx) {
    const released = await expireBlocks(ctx);
    const endMs = Math.floor((Date.now() - LAG_SEC * 1000) / (WINDOW_SEC * 1000)) * WINDOW_SEC * 1000;
    const rules = (await ctx.db.query("SELECT * FROM nexo.anomaly_rule WHERE enabled ORDER BY name")).rows;
    const blocked = new Set((await ctx.db.query("SELECT condition_value FROM nexo.block WHERE active AND condition_type = 'APPLICATION'")).rows.map((r) => String(r.condition_value)));
    let found = 0;
    for (const rule of rules) {
      const key = `${rule.id}:${rule.updated_at}`;
      if (lastEvaluated.get(key) === endMs) continue;
      try {
        found += await evaluateRule(ctx, rule, endMs, blocked);
        lastEvaluated.set(key, endMs);
      } catch (e) {
        ctx.log("error", `regla "${rule.name}": ${e instanceof Error ? e.message : String(e)}`, { regla: rule.id });
      }
    }
    const active = (await ctx.db.query("SELECT count(*)::int AS n FROM nexo.block WHERE active")).rows[0]?.n ?? 0;
    activeBlocks.set(active);
    return { reglas: rules.length, ventana: new Date(endMs - WINDOW_SEC * 1000).toISOString(), anomalias: found, bloqueosActivos: active, liberados: released };
  },
};
