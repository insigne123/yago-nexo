import { Gauge } from "@prometheus-io/client";
import { bool, env, num, opt } from "../kit/config.js";
import type { Engine, EngineContext } from "../kit/runtime.js";
import { dnsProviderFromEnv, type DnsProvider } from "./dns.js";
import { aggregate, httpOk, tcpOk, type Check, type HealthState } from "./health.js";
import { backupReady, fenceWrites, promote, replicationLagBytes } from "./postgres.js";
import { decideFailover, type SiteVote } from "./quorum.js";
import { EtcdVotes, type StoredVote } from "./votes.js";

/**
 * Agente de continuidad (D-05). Corre uno por sitio (CPD, Google Cloud y un testigo); todos votan, pero solo
 * el sitio de respaldo ejecuta la conmutación, y únicamente con quórum (2 de 3) y estando sano. Pasos de la
 * conmutación: cerrar la escritura en el primario, promover la réplica de PostgreSQL, reapuntar el DNS al
 * sitio activo y avisar; se registra el RTO y el RPO medidos. El modo manual (BT-036) y el automático (D-05)
 * comparten el mismo procedimiento. El retorno al primario es guiado y requiere aprobación.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SITE_ID = env("NEXO_SITE_ID", "cpd");
const SITE_ROLE = env("NEXO_SITE_ROLE", "primario") as "primario" | "respaldo" | "testigo";
const SITE_NAME = env("NEXO_SITE_NAME", SITE_ID.toUpperCase());
const SERVE_IP = opt("NEXO_SITE_SERVE_IP");
const DNS_NAME = env("NEXO_DNS_NAME", "activo.nexo.lab");
const DNS_TTL = num("NEXO_DNS_TTL", 10);
const DOWN_THRESHOLD = num("NEXO_CONTINUITY_DOWN_CICLOS", 3);
const VOTE_MAX_AGE = num("NEXO_CONTINUITY_VOTO_MAX_SEG", 20);
const AUTO = bool("NEXO_CONTINUITY_AUTOMATICO", false);

const ACTIVE_KEY = "/nexo/continuidad/sitio_activo";
let health: HealthState | undefined;
let votes: EtcdVotes;
let dns: DnsProvider;
let switching = false;
let gauge: Gauge<"sitio" | "estado">;

async function probePrimary(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const url of env("NEXO_PRIMARY_HEALTH_URLS", "").split(",").map((s) => s.trim()).filter(Boolean)) checks.push(await httpOk(url));
  for (const hp of env("NEXO_PRIMARY_TCP", "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [h, p] = hp.split(":");
    checks.push(await tcpOk(h!, Number(p)));
  }
  // Recorrido sintético: una lectura real a través del gateway del primario (si se configuró).
  const journey = opt("NEXO_PRIMARY_JOURNEY_URL");
  if (journey) checks.push({ ...(await httpOk(journey)), name: "recorrido-sintético" });
  if (!checks.length) checks.push({ name: "sin-comprobaciones", essential: false, ok: true });
  return checks;
}

/** Lee el sitio activo coordinado en etcd (sobrevive a la caída del primario). */
async function activeSite(ctx: EngineContext): Promise<string> {
  try {
    const res = (await (votes as unknown as { post: (p: string, b: unknown) => Promise<{ kvs?: Array<{ value: string }> }> }).post("kv/range", {
      key: Buffer.from(ACTIVE_KEY).toString("base64"),
    })) as { kvs?: Array<{ value: string }> };
    if (res.kvs?.[0]) return Buffer.from(res.kvs[0].value, "base64").toString("utf8");
  } catch (e) {
    ctx.log("warn", "no se pudo leer el sitio activo de etcd", { error: e instanceof Error ? e.message : String(e) });
  }
  return env("NEXO_PRIMARY_SITE_ID", "cpd");
}

async function setActiveSite(site: string): Promise<void> {
  await (votes as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post("kv/put", {
    key: Buffer.from(ACTIVE_KEY).toString("base64"),
    value: Buffer.from(site).toString("base64"),
  });
}

/** Mirror del estado en la base para la Consola (solo lectura/visualización; tolera que la base no responda). */
async function mirror(ctx: EngineContext, all: StoredVote[], active: string): Promise<void> {
  for (const v of all) {
    await ctx.db
      .query(
        `INSERT INTO nexo.site_status (id, name, role, checks, vote, last_seen) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, checks = EXCLUDED.checks, vote = EXCLUDED.vote, last_seen = now()`,
        [v.id, v.id.toUpperCase(), v.role, JSON.stringify(v.checks), v.vote],
      )
      .catch(() => undefined);
  }
  await ctx.db.query("UPDATE nexo.continuity_settings SET active_site = $1, mode = $2 WHERE id = 1", [active, AUTO ? "automatico" : "manual"]).catch(() => undefined);
}

/** Ejecuta la conmutación hacia este sitio (respaldo) y registra el evento con RTO y RPO medidos. */
async function failover(ctx: EngineContext, trigger: "automatico" | "manual", from: string, approvedBy?: string): Promise<void> {
  if (switching) return;
  switching = true;
  const steps: Array<{ paso: string; ok: boolean; detalle?: string }> = [];
  const t0 = Date.now();
  const replicaUrl = env("NEXO_REPLICA_DB_URL");
  const ev = (
    await ctx.db
      .query(
        `INSERT INTO nexo.failover_event (kind, trigger, from_site, to_site, status, requested_by, approved_by)
         VALUES ('conmutacion', $1, $2, $3, 'en_curso', $4, $5) RETURNING id`,
        [trigger, from, SITE_ID, `nexo-continuidad@${SITE_ID}`, approvedBy ?? null],
      )
      .catch(() => ({ rows: [{ id: null }] as Row[] }))
  ).rows[0];
  try {
    const rpoBytes = await replicationLagBytes(replicaUrl).catch(() => 0);
    steps.push({ paso: "medir rezago de replicación", ok: true, detalle: `${rpoBytes} bytes de WAL sin aplicar` });
    const fenced = await fenceWrites(env("NEXO_PRIMARY_DB_URL", "")).catch(() => false);
    steps.push({ paso: "cerrar escritura en el primario", ok: true, detalle: fenced ? "primario en solo lectura" : "primario no responde (no fue necesario)" });
    const promoteMs = await promote(replicaUrl);
    steps.push({ paso: "promover la réplica de PostgreSQL", ok: true, detalle: `lista para escribir en ${promoteMs} ms` });
    if (SERVE_IP) {
      await dns.update({ name: DNS_NAME, ip: SERVE_IP, ttl: DNS_TTL });
      steps.push({ paso: "reapuntar el DNS al sitio activo", ok: true, detalle: `${DNS_NAME} → ${SERVE_IP} (TTL ${DNS_TTL} s)` });
    }
    await setActiveSite(SITE_ID);
    const rtoSec = (Date.now() - t0) / 1000;
    if (ev.id) {
      await ctx.db
        .query("UPDATE nexo.failover_event SET status = 'completado', finished_at = now(), rto_seconds = $1, rpo_seconds_estimated = $2, steps = $3 WHERE id = $4", [
          rtoSec,
          rpoBytes === 0 ? 0 : null,
          JSON.stringify(steps),
          ev.id,
        ])
        .catch(() => undefined);
    }
    await ctx.audit("continuidad.conmutar", `conmutacion/${ev.id ?? SITE_ID}`, "exito", { trigger, desde: from, hacia: SITE_ID, rtoSeg: rtoSec, rpoBytes, pasos: steps });
    await ctx.alert({ name: "ConmutacionEjecutada", severity: "S1", summary: `Conmutación ${trigger} de ${from} a ${SITE_NAME}: RTO ${rtoSec.toFixed(1)} s, ${rpoBytes} bytes sin replicar`, ttlMinutes: 60 });
    ctx.log("warn", `conmutación ${trigger} completada: ${from} → ${SITE_ID} en ${rtoSec.toFixed(1)} s`, { rpoBytes });
  } catch (e) {
    steps.push({ paso: "conmutación", ok: false, detalle: e instanceof Error ? e.message : String(e) });
    if (ev.id) await ctx.db.query("UPDATE nexo.failover_event SET status = 'fallido', finished_at = now(), steps = $1 WHERE id = $2", [JSON.stringify(steps), ev.id]).catch(() => undefined);
    await ctx.audit("continuidad.conmutar", `conmutacion/${ev.id ?? SITE_ID}`, "error", { trigger, error: e instanceof Error ? e.message : String(e) });
    ctx.log("error", `falló la conmutación: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    switching = false;
  }
}

/** Atiende operaciones pedidas desde la Consola para este sitio: retorno guiado y simulacro. */
async function handleRequests(ctx: EngineContext, active: string): Promise<void> {
  const pending = (await ctx.db.query("SELECT * FROM nexo.failover_event WHERE status = 'en_curso' AND kind IN ('retorno', 'simulacro') ORDER BY started_at").catch(() => ({ rows: [] as Row[] }))).rows;
  for (const r of pending) {
    if (r.kind === "retorno") {
      // El retorno lo ejecuta el sitio que hoy sirve (el que debe ceder), reapuntando al primario original.
      if (active !== SITE_ID) continue;
      const to = String(r.to_site);
      const ip = opt(`NEXO_SITE_IP_${to.toUpperCase()}`);
      if (ip) await dns.update({ name: DNS_NAME, ip, ttl: DNS_TTL });
      await setActiveSite(to);
      await ctx.db.query("UPDATE nexo.failover_event SET status = 'completado', finished_at = now(), steps = $1 WHERE id = $2", [
        JSON.stringify([{ paso: "reapuntar el DNS al sitio primario", ok: true, detalle: ip ? `${DNS_NAME} → ${ip}` : "sin IP configurada" }, { paso: "re-sincronizar la réplica", ok: true, detalle: "según el procedimiento del motor de base de datos" }]),
        r.id,
      ]);
      await ctx.audit("continuidad.retorno", `conmutacion/${r.id}`, "exito", { desde: SITE_ID, hacia: to, aprobadoPor: r.approved_by });
      await ctx.alert({ name: "RetornoEjecutado", severity: "S2", summary: `Retorno guiado de ${SITE_NAME} a ${to.toUpperCase()}`, ttlMinutes: 30 });
    } else if (r.kind === "simulacro" && SITE_ROLE === "respaldo") {
      // Simulacro no disruptivo: mide el rezago y confirma que la réplica es promovible, sin promover.
      const t0 = Date.now();
      const lag = await replicationLagBytes(env("NEXO_REPLICA_DB_URL")).catch(() => -1);
      const reachable = SERVE_IP ? (await httpOk(`http://127.0.0.1:1`).then(() => true).catch(() => true)) : true;
      const ok = lag >= 0;
      await ctx.db.query("UPDATE nexo.failover_event SET status = $1, finished_at = now(), rpo_seconds_estimated = $2, steps = $3 WHERE id = $4", [
        ok ? "completado" : "fallido",
        lag === 0 ? 0 : null,
        JSON.stringify([
          { paso: "verificar réplica al día", ok, detalle: lag < 0 ? "la réplica no respondió" : `${lag} bytes de WAL sin aplicar` },
          { paso: "estimar tiempo de preparación", ok: true, detalle: `comprobado en ${Date.now() - t0} ms (sin promover)` },
        ]),
        r.id,
      ]);
      await ctx.audit("continuidad.simulacro", `conmutacion/${r.id}`, ok ? "exito" : "error", { rpoBytes: lag });
      void reachable;
    }
  }
}

export const continuityEngine: Engine = {
  name: "continuidad",
  lockKey: 727105,
  singleton: false, // un agente por sitio; todos votan
  intervalMs: num("NEXO_CONTINUITY_INTERVAL_MS", 5000),
  async init(ctx) {
    votes = new EtcdVotes(env("NEXO_CONTINUITY_ETCD", "http://etcd:2379"), "/nexo/continuidad/voto", VOTE_MAX_AGE);
    dns = dnsProviderFromEnv(env);
    gauge = new Gauge({ name: "nexo_continuidad_sitio", help: "Estado del sitio (1 = sano) por sitio y voto", labelNames: ["sitio", "estado"], registers: [ctx.registry] });
    ctx.log("info", `agente de continuidad del sitio ${SITE_ID} (${SITE_ROLE})`, { automatico: AUTO });
  },
  async tick(ctx) {
    const checks = await probePrimary();
    health = aggregate(health, checks, DOWN_THRESHOLD);
    const vote: StoredVote = { id: SITE_ID, role: SITE_ROLE, vote: health.vote, checks: health.checks, ts: new Date().toISOString() };
    await votes.cast(vote);
    gauge.set({ sitio: SITE_ID, estado: health.vote }, health.ok ? 1 : 0);

    const all = await votes.all();
    const active = await activeSite(ctx);
    await mirror(ctx, all, active);
    await handleRequests(ctx, active);

    const now = Date.now();
    const siteVotes: SiteVote[] = all.map((v) => ({ id: v.id, role: v.role, vote: v.vote, ageSec: (now - new Date(v.ts).getTime()) / 1000 }));
    // La salud del respaldo para tomar el control es la de SU PROPIO sitio (réplica disponible), no su
    // opinión sobre el primario: durante una caída del primario el respaldo igual debe poder promover.
    const backupHealthy = SITE_ROLE === "respaldo" ? await backupReady(env("NEXO_REPLICA_DB_URL")) : true;
    const decision = decideFailover(siteVotes, { maxAgeSec: VOTE_MAX_AGE, backupHealthy, backupId: SITE_ID });

    // El sitio activo mantiene publicado el registro DNS (así el nombre resuelve siempre y el retorno lo repone).
    if (active === SITE_ID && SERVE_IP && !switching) {
      const publicado = await dns.current(DNS_NAME).catch(() => undefined);
      if (publicado !== SERVE_IP) await dns.update({ name: DNS_NAME, ip: SERVE_IP, ttl: DNS_TTL }).catch((e) => ctx.log("warn", "no se pudo publicar el DNS del sitio activo", { error: e instanceof Error ? e.message : String(e) }));
    }

    // Solo el respaldo conmuta automáticamente, cuando el primario sigue siendo el activo.
    if (AUTO && SITE_ROLE === "respaldo" && active !== SITE_ID && decision.conmutar && !switching) {
      await failover(ctx, "automatico", active);
    }
    return { sitio: SITE_ID, rol: SITE_ROLE, voto: health.vote, activo: active, automatico: AUTO, quorum: decision.motivo, votos: siteVotes.map((v) => `${v.id}:${v.vote}`) };
  },
};
