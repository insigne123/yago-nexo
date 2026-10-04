import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import pg from "pg";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import { AuditStore, createPool, type Db } from "@nexo/console-db";
import type { AuditResult } from "@nexo/shared";
import { Wso2Client } from "@nexo/wso2-client";
import { bool, env, num, opt } from "./config.js";
import { OpenSearch } from "./opensearch.js";

/** Registro estructurado (JSON por línea) que recoge Fluent Bit. */
export type Logger = (nivel: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export function logger(motor: string): Logger {
  return (nivel, msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), nivel, motor, msg, ...extra });
    if (nivel === "error") console.error(line);
    else console.log(line);
  };
}

export interface Alert {
  name: string;
  severity: "S1" | "S2" | "S3" | "S4";
  summary: string;
  labels?: Record<string, string>;
  /** Minutos que la alerta queda activa si nadie la resuelve antes. */
  ttlMinutes?: number;
}

export interface EngineContext {
  db: Db;
  instance: string;
  log: Logger;
  registry: Registry;
  wso2: () => Wso2Client;
  os: () => OpenSearch;
  audit: (action: string, resource: string, result: AuditResult, details?: Record<string, unknown>) => Promise<void>;
  alert: (a: Alert) => Promise<void>;
}

export interface Engine {
  /** Nombre del motor (descubrimiento, guardian, despliegues, siem). */
  name: string;
  /** Llave del bloqueo de asesoría de PostgreSQL: un solo líder activo por motor. */
  lockKey: number;
  intervalMs: number;
  /**
   * false = todas las réplicas trabajan a la vez (no hay líder único). Lo usa el agente de continuidad (D-05):
   * cada sitio corre su propio agente y todos deben votar. Por defecto true (un solo líder por el bloqueo).
   */
  singleton?: boolean;
  init?(ctx: EngineContext): Promise<void>;
  /** Una vuelta de trabajo. Lo que devuelve se publica en el latido (Consola). */
  tick(ctx: EngineContext): Promise<Record<string, unknown> | void>;
}

/**
 * Liderazgo con pg_try_advisory_lock en una conexión dedicada: si la conexión se corta, PostgreSQL libera
 * el bloqueo y otra réplica toma el mando. Así se pueden correr varias réplicas sin trabajo duplicado.
 */
class Leadership {
  private client?: pg.Client;
  leader = false;

  constructor(
    private readonly url: string,
    private readonly key: number,
  ) {}

  async check(): Promise<boolean> {
    try {
      if (!this.client) {
        const c = new pg.Client({
          connectionString: this.url,
          ssl: process.env.NEXO_DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.NEXO_DATABASE_SSL_INSECURE !== "true" } : undefined,
        });
        c.on("error", () => this.reset());
        await c.connect();
        this.client = c;
      }
      if (!this.leader) {
        const r = await this.client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [this.key]);
        this.leader = r.rows[0]?.ok === true;
      } else {
        await this.client.query("SELECT 1");
      }
    } catch {
      this.reset();
    }
    return this.leader;
  }

  reset() {
    this.leader = false;
    const c = this.client;
    this.client = undefined;
    c?.end().catch(() => undefined);
  }
}

export function createContext(motor: string, registry: Registry): EngineContext {
  const db = createPool(env("NEXO_DATABASE_URL"));
  const store = new AuditStore(db);
  const log = logger(motor);
  const instance = `${hostname()}:${process.pid}`;
  let wso2: Wso2Client | undefined;
  let os: OpenSearch | undefined;
  const alertmanager = opt("NEXO_ALERTMANAGER_URL");
  return {
    db,
    instance,
    log,
    registry,
    wso2: () =>
      (wso2 ??= new Wso2Client({
        baseUrl: env("NEXO_WSO2_URL", "https://apim:9443"),
        auth: { type: "basic", username: env("NEXO_WSO2_USER", "admin"), password: env("NEXO_WSO2_PASSWORD") },
        tls: { rejectUnauthorized: !bool("NEXO_WSO2_INSECURE_TLS", false) },
      })),
    os: () => (os ??= new OpenSearch(env("NEXO_OPENSEARCH_URL", "http://opensearch:9200"), opt("NEXO_OPENSEARCH_USER"), opt("NEXO_OPENSEARCH_PASSWORD"))),
    audit: async (action, resource, result, details) => {
      await store.append({ source: "motor", actor: `nexo-${motor}`, actorType: "tecnico", action, resource, result, details });
    },
    alert: async (a) => {
      log(a.severity === "S1" || a.severity === "S2" ? "warn" : "info", `alerta: ${a.summary}`, { alerta: a.name, severidad: a.severity, ...a.labels });
      if (!alertmanager) return;
      const now = new Date();
      const body = [
        {
          labels: { alertname: a.name, severidad: a.severity, motor, ...a.labels },
          annotations: { resumen: a.summary },
          startsAt: now.toISOString(),
          endsAt: new Date(now.getTime() + (a.ttlMinutes ?? 30) * 60_000).toISOString(),
        },
      ];
      await fetch(`${alertmanager}/api/v2/alerts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e: unknown) =>
        log("warn", "no se pudo enviar la alerta a Alertmanager", { error: e instanceof Error ? e.message : String(e) }),
      );
    },
  };
}

/** Ejecuta uno o más motores con liderazgo, latido, métricas y salud, hasta recibir SIGTERM. */
export async function runEngines(engines: Engine[]): Promise<void> {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "nexo_motores_" });
  const ticks = new Counter({ name: "nexo_motor_vueltas_total", help: "Vueltas de trabajo por motor y resultado", labelNames: ["motor", "resultado"], registers: [registry] });
  const leaderGauge = new Gauge({ name: "nexo_motor_lider", help: "1 si esta instancia es la líder del motor", labelNames: ["motor"], registers: [registry] });
  const lastRun = new Gauge({ name: "nexo_motor_ultima_vuelta_timestamp_segundos", help: "Momento de la última vuelta exitosa", labelNames: ["motor"], registers: [registry] });
  const duration = new Histogram({
    name: "nexo_motor_vuelta_duracion_segundos",
    help: "Duración de cada vuelta",
    labelNames: ["motor"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });

  const contexts = new Map<string, EngineContext>();
  const leaders = new Map<string, Leadership>();
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  const running = new Set<Promise<unknown>>();

  for (const engine of engines) {
    const ctx = createContext(engine.name, registry);
    contexts.set(engine.name, ctx);
    leaders.set(engine.name, new Leadership(env("NEXO_DATABASE_URL"), engine.lockKey));
    await engine.init?.(ctx);
    ctx.log("info", `motor iniciado (cada ${engine.intervalMs} ms)`, { instancia: ctx.instance });
  }

  const loop = (engine: Engine) => {
    const ctx = contexts.get(engine.name)!;
    const leadership = leaders.get(engine.name)!;
    let busy = false;
    const beat = async (info: Record<string, unknown>) => {
      await ctx.db
        .query(
          `INSERT INTO nexo.engine_heartbeat (engine, instance, leader, info, last_seen) VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (engine, instance) DO UPDATE SET leader = EXCLUDED.leader, info = EXCLUDED.info, last_seen = now()`,
          [engine.name, ctx.instance, leadership.leader, JSON.stringify(info)],
        )
        .catch(() => undefined);
      // Olvida las instancias que ya no laten (réplicas o agentes retirados), para que la Consola no las muestre.
      await ctx.db.query("DELETE FROM nexo.engine_heartbeat WHERE engine = $1 AND last_seen < now() - interval '3 minutes'", [engine.name]).catch(() => undefined);
    };
    const step = async () => {
      if (busy || stopping) return;
      busy = true;
      const end = duration.startTimer({ motor: engine.name });
      const work = (async () => {
        const isLeader = engine.singleton === false ? true : await leadership.check();
        leaderGauge.set({ motor: engine.name }, isLeader ? 1 : 0);
        if (!isLeader) {
          await beat({ estado: "en espera (otra réplica es líder)" });
          return;
        }
        try {
          const info = (await engine.tick(ctx)) ?? {};
          ticks.inc({ motor: engine.name, resultado: "ok" });
          lastRun.set({ motor: engine.name }, Date.now() / 1000);
          await beat({ estado: "activo", ...info });
        } catch (e) {
          ticks.inc({ motor: engine.name, resultado: "error" });
          ctx.log("error", "falló una vuelta del motor", { error: e instanceof Error ? e.message : String(e) });
          await beat({ estado: "error", error: e instanceof Error ? e.message : String(e) });
        }
      })();
      running.add(work);
      try {
        await work;
      } finally {
        running.delete(work);
        end();
        busy = false;
      }
    };
    void step();
    timers.push(setInterval(() => void step(), engine.intervalMs));
  };
  engines.forEach(loop);

  const port = num("NEXO_METRICS_PORT", 9465);
  const server: Server = createServer((req, res) => {
    if (req.url === "/metrics") {
      registry
        .metrics()
        .then((m) => {
          res.writeHead(200, { "content-type": registry.contentType });
          res.end(m);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
      return;
    }
    if (req.url === "/health" || req.url === "/ready") {
      res.writeHead(stopping ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: stopping ? "deteniendo" : "ok", motores: engines.map((e) => ({ motor: e.name, lider: leaders.get(e.name)!.leader })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "0.0.0.0");

  await new Promise<void>((resolve) => {
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      timers.forEach(clearInterval);
      await Promise.allSettled([...running]);
      for (const [name, l] of leaders) {
        l.reset();
        await contexts.get(name)!.db.end().catch(() => undefined);
      }
      server.close();
      resolve();
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
  });
}
