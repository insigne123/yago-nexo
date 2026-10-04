import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { Counter, Gauge } from "@prometheus-io/client";
import type { AuditEvent } from "@nexo/shared";
import { env, num, opt } from "../kit/config.js";
import type { Engine, EngineContext } from "../kit/runtime.js";
import { frame, ndjson, parseDestinations, syslog5424, type Destination } from "./format.js";

/**
 * Reenvío de la auditoría encadenada al SIEM sin pérdida (BT-031, BT-032). Por cada destino hay un cursor en
 * la base (último seq entregado) que solo avanza después de la entrega: si el SIEM no responde, los eventos
 * esperan en PostgreSQL y se reenvían en orden cuando vuelve. La entrega es "al menos una vez"; cada evento
 * lleva su id, secuencia y hashes para que el SIEM descarte duplicados y verifique la cadena.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BATCH = num("NEXO_SIEM_LOTE", 200);
const sockets = new Map<string, Socket>();
const backoff = new Map<string, { until: number; delay: number }>();
/** Desde cuándo falla cada destino y cuándo se avisó por última vez (para alertar sin repetir). */
const failingSince = new Map<string, { since: number; alerted: number }>();
let sent: Counter<"destino">;
let failures: Counter<"destino">;
let lag: Gauge<"destino">;

function toEvent(r: Row): AuditEvent {
  const e: Record<string, unknown> = {
    id: r.id,
    ts: r.ts,
    seq: Number(r.seq),
    source: r.source,
    actor: r.actor,
    actorType: r.actor_type,
    action: r.action,
    result: r.result,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
  if (r.resource != null) e.resource = r.resource;
  if (r.source_ip != null) e.sourceIp = r.source_ip;
  if (r.correlation_id != null) e.correlationId = r.correlation_id;
  if (r.details != null) e.details = r.details;
  return e as unknown as AuditEvent;
}

function socketFor(d: Destination): Promise<Socket> {
  const existing = sockets.get(d.key);
  if (existing && !existing.destroyed && existing.writable) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      sockets.delete(d.key);
      reject(e);
    };
    const s = d.tls
      ? tlsConnect({ host: d.host, port: d.port, servername: d.host, ca: opt("NEXO_SIEM_TLS_CA") ? readFileSync(opt("NEXO_SIEM_TLS_CA")!) : undefined, minVersion: "TLSv1.2" }, () => resolve(s))
      : netConnect({ host: d.host!, port: d.port! }, () => resolve(s));
    s.setKeepAlive(true, 15_000);
    s.setTimeout(30_000, () => s.destroy(new Error("sin respuesta del SIEM")));
    s.once("error", onError);
    s.on("close", () => sockets.delete(d.key));
    sockets.set(d.key, s);
  });
}

/** Escribe el lote y confirma que la conexión siguió sana un instante después (la entrega TCP no tiene acuse propio). */
async function sendSyslog(d: Destination, events: readonly AuditEvent[]): Promise<void> {
  const s = await socketFor(d);
  const host = env("NEXO_SIEM_HOSTNAME", hostname());
  const pen = num("NEXO_SIEM_PEN", 32473);
  const payload = Buffer.concat(events.map((e) => frame(syslog5424(e, { hostname: host, appName: "nexo", pen }), d.framing ?? "lf")));
  await new Promise<void>((resolve, reject) => s.write(payload, (err) => (err ? reject(err) : resolve())));
  await new Promise((r) => setTimeout(r, 300));
  if (s.destroyed || !s.writable) throw new Error("la conexión con el SIEM se cerró durante el envío");
}

async function sendHttp(d: Destination, events: readonly AuditEvent[]): Promise<void> {
  const token = opt("NEXO_SIEM_HTTP_TOKEN");
  const res = await fetch(d.url!, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: ndjson(events),
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`el colector respondió ${res.status}`);
}

async function forward(ctx: EngineContext, d: Destination, maxBatches: number): Promise<{ delivered: number; lagEvents: number; error?: string }> {
  await ctx.db.query("INSERT INTO nexo.siem_cursor (destination) VALUES ($1) ON CONFLICT DO NOTHING", [d.key]);
  let delivered = 0;
  for (let i = 0; i < maxBatches; i++) {
    const cursor = Number((await ctx.db.query("SELECT last_seq FROM nexo.siem_cursor WHERE destination = $1", [d.key])).rows[0]?.last_seq ?? 0);
    const rows = (await ctx.db.query("SELECT * FROM nexo.audit_event WHERE seq > $1 ORDER BY seq LIMIT $2", [cursor, BATCH])).rows;
    if (!rows.length) break;
    const events = rows.map(toEvent);
    try {
      if (d.kind === "syslog") await sendSyslog(d, events);
      else await sendHttp(d, events);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.db.query("UPDATE nexo.siem_cursor SET last_error = $1, updated_at = now() WHERE destination = $2", [message, d.key]);
      failures.inc({ destino: d.key });
      throw e;
    }
    const last = events.at(-1)!.seq;
    await ctx.db.query("UPDATE nexo.siem_cursor SET last_seq = $1, sent_total = sent_total + $2, last_error = NULL, updated_at = now() WHERE destination = $3 AND last_seq = $4", [
      last,
      events.length,
      d.key,
      cursor,
    ]);
    delivered += events.length;
    sent.inc({ destino: d.key }, events.length);
  }
  const state = (
    await ctx.db.query("SELECT (SELECT coalesce(max(seq), 0) FROM nexo.audit_event) - last_seq AS lag FROM nexo.siem_cursor WHERE destination = $1", [d.key])
  ).rows[0];
  const lagEvents = Number(state?.lag ?? 0);
  lag.set({ destino: d.key }, lagEvents);
  return { delivered, lagEvents };
}

export const siemEngine: Engine = {
  name: "siem",
  lockKey: 727104,
  intervalMs: num("NEXO_SIEM_INTERVAL_MS", 3000),
  async init(ctx) {
    sent = new Counter({ name: "nexo_siem_eventos_enviados_total", help: "Eventos de auditoría entregados al SIEM", labelNames: ["destino"], registers: [ctx.registry] });
    failures = new Counter({ name: "nexo_siem_fallas_total", help: "Envíos al SIEM que fallaron (se reintentan)", labelNames: ["destino"], registers: [ctx.registry] });
    lag = new Gauge({ name: "nexo_siem_rezago_eventos", help: "Eventos de auditoría que aún no llegan al SIEM", labelNames: ["destino"], registers: [ctx.registry] });
  },
  async tick(ctx) {
    const destinations = parseDestinations(env("NEXO_SIEM_DESTINOS", ""));
    const estado: Array<Record<string, unknown>> = [];
    for (const d of destinations) {
      const b = backoff.get(d.key);
      if (b && Date.now() < b.until) {
        estado.push({ destino: d.key, estado: "reintentando", proximoIntento: new Date(b.until).toISOString() });
        continue;
      }
      try {
        const r = await forward(ctx, d, 10);
        backoff.delete(d.key);
        const failed = failingSince.get(d.key);
        if (failed) {
          failingSince.delete(d.key);
          await ctx.alert({ name: "SiemRecuperado", severity: "S4", summary: `La auditoría vuelve a llegar a ${d.key}; se entregaron los eventos pendientes`, ttlMinutes: 10 });
        }
        estado.push({ destino: d.key, estado: "al día", entregados: r.delivered, rezago: r.lagEvents });
      } catch (e) {
        const delay = Math.min(60_000, (b?.delay ?? 1000) * 2);
        backoff.set(d.key, { until: Date.now() + delay, delay });
        sockets.get(d.key)?.destroy();
        const message = e instanceof Error ? e.message : String(e);
        estado.push({ destino: d.key, estado: "error", error: message, reintentoEnMs: delay });
        ctx.log("warn", `no se pudo entregar la auditoría a ${d.key}; se reintentará`, { error: message, reintentoEnMs: delay });
        const f = failingSince.get(d.key) ?? { since: Date.now(), alerted: 0 };
        failingSince.set(d.key, f);
        const minutes = (Date.now() - f.since) / 60_000;
        if (minutes >= num("NEXO_SIEM_ALERTA_MIN", 5) && Date.now() - f.alerted > 30 * 60_000) {
          f.alerted = Date.now();
          await ctx.alert({
            name: "SiemSinEntrega",
            severity: "S2",
            summary: `La auditoría no llega a ${d.key} desde hace ${Math.round(minutes)} min (${message}); los eventos esperan en la base y se reenviarán en orden`,
          });
        }
      }
    }
    return { destinos: estado };
  },
};
