import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { config } from "../config.js";
import { AuditService } from "./audit.service.js";

/**
 * Rechazos 401 agrupados por IP de origen (BT-031), sin inundar la auditoría.
 *
 * Por cada IP y ventana (60 s por omisión) se registran a lo más dos eventos: uno al primer intento (para verlo
 * de inmediato) y, si hubo más, un resumen al cerrar la ventana con el total de intentos, los motivos y las rutas.
 * Se siguen hasta `maxIps` IP distintas por ventana; los intentos de las demás se suman en un único resumen con
 * IP «varias». Así, una ráfaga de miles de intentos (aunque falsifique la IP) deja como máximo 2·maxIps + 1 eventos
 * por ventana.
 */
export interface UnauthorizedSummary {
  ip: string;
  phase: "primero" | "resumen";
  count: number;
  first: Date;
  last: Date;
  reasons: Record<string, number>;
  paths: string[];
  windowSec: number;
}

interface Bucket {
  ip: string;
  first: number;
  last: number;
  count: number;
  reasons: Map<string, number>;
  paths: Set<string>;
}

export const OVERFLOW_IP = "varias";
const MAX_REASONS = 8;
const MAX_PATHS = 5;

export class UnauthorizedAggregator {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly opts: {
      windowMs: number;
      maxIps: number;
      emit: (s: UnauthorizedSummary) => Promise<unknown> | unknown;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Cuenta un intento. Devuelve la escritura del evento inmediato cuando es el primero de la IP en la ventana. */
  hit(ip: string | undefined, reason: string, path: string): Promise<void> {
    const now = this.now();
    this.flushExpired(now);
    let key = (ip || "desconocida").slice(0, 64);
    if (!this.buckets.has(key) && key !== OVERFLOW_IP && this.trackedIps() >= this.opts.maxIps)
      key = OVERFLOW_IP;
    let b = this.buckets.get(key);
    const isNew = !b;
    if (!b) {
      b = { ip: key, first: now, last: now, count: 0, reasons: new Map(), paths: new Set() };
      this.buckets.set(key, b);
    }
    b.count++;
    b.last = now;
    const r = reason.slice(0, 120);
    if (b.reasons.has(r) || b.reasons.size < MAX_REASONS) b.reasons.set(r, (b.reasons.get(r) ?? 0) + 1);
    else b.reasons.set("otros", (b.reasons.get("otros") ?? 0) + 1);
    if (b.paths.size < MAX_PATHS) b.paths.add(path.slice(0, 200));
    if (isNew && key !== OVERFLOW_IP)
      return Promise.resolve(this.opts.emit(this.summary(b, "primero"))).then(() => undefined);
    return Promise.resolve();
  }

  private trackedIps(): number {
    return this.buckets.size - (this.buckets.has(OVERFLOW_IP) ? 1 : 0);
  }

  private summary(b: Bucket, phase: UnauthorizedSummary["phase"]): UnauthorizedSummary {
    return {
      ip: b.ip,
      phase,
      count: b.count,
      first: new Date(b.first),
      last: new Date(b.last),
      reasons: Object.fromEntries(b.reasons),
      paths: [...b.paths],
      windowSec: Math.round(this.opts.windowMs / 1000),
    };
  }

  /** Cierra las ventanas vencidas (o todas, al apagar) y registra su resumen si hubo más de un intento. */
  flushExpired(now = this.now(), all = false): Promise<void> {
    const pending: Array<Promise<unknown> | unknown> = [];
    for (const [key, b] of this.buckets) {
      if (!all && now - b.first < this.opts.windowMs) continue;
      this.buckets.delete(key);
      if (key === OVERFLOW_IP || b.count > 1) pending.push(this.opts.emit(this.summary(b, "resumen")));
    }
    return Promise.all(pending).then(() => undefined);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Servicio de Nest: agrupa los 401 de la API y del webhook de alertas, y los escribe en la cadena de auditoría. */
@Injectable()
export class UnauthorizedAudit implements OnApplicationShutdown {
  readonly aggregator: UnauthorizedAggregator;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly audit: AuditService) {
    const windowMs = config.audit.unauthorizedWindowSec * 1000;
    this.aggregator = new UnauthorizedAggregator({
      windowMs,
      maxIps: config.audit.unauthorizedMaxIps,
      emit: (s) => this.write(s),
    });
    this.timer = setInterval(() => void this.aggregator.flushExpired(), Math.min(windowMs, 5000));
    this.timer.unref();
  }

  hit(ip: string | undefined, reason: string, path: string): Promise<void> {
    return this.aggregator.hit(ip, reason, path);
  }

  private write(s: UnauthorizedSummary) {
    return this.audit.append({
      actor: "anonimo",
      actorType: "usuario",
      action: "acceso.rechazado.autenticacion",
      resource: `ip/${s.ip}`,
      result: "rechazado",
      sourceIp: s.ip === OVERFLOW_IP ? undefined : s.ip,
      details: {
        fase: s.phase,
        intentos: s.count,
        desde: s.first.toISOString(),
        hasta: s.last.toISOString(),
        ventanaSeg: s.windowSec,
        motivos: s.reasons,
        rutas: s.paths,
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.aggregator.flushExpired(Date.now(), true);
  }
}
