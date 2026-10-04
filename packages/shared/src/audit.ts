import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Esquema común de eventos de auditoría (BT-031) y cadena de integridad (BT-032).
 *
 * Cada evento incluye identidad (usuario o técnica), timestamp, acción, resultado e IP de
 * origen. Además lleva un número de secuencia por fuente y un hash encadenado
 * (hash = SHA-256(hashPrevio + evento canónico)), que permite verificar en el SIEM que los
 * eventos llegaron íntegros y en orden, y detectar huecos.
 */

export const AuditResult = z.enum(["exito", "rechazado", "error"]);
export type AuditResult = z.infer<typeof AuditResult>;

export const AuditEventInput = z.object({
  source: z.string().min(1).max(64),
  actor: z.string().min(1).max(256),
  actorType: z.enum(["usuario", "tecnico"]),
  action: z.string().min(1).max(128),
  resource: z.string().max(512).optional(),
  result: AuditResult,
  sourceIp: z.string().max(64).optional(),
  correlationId: z.string().max(128).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEventInput = z.infer<typeof AuditEventInput>;

export const AuditEvent = AuditEventInput.extend({
  id: z.string().uuid(),
  ts: z.string().datetime(),
  seq: z.number().int().nonnegative(),
  prevHash: z.string().length(64),
  hash: z.string().length(64),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const GENESIS_HASH = "0".repeat(64);

/** Serialización canónica: claves ordenadas, sin espacios, sin el propio hash. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function computeHash(prevHash: string, event: Omit<AuditEvent, "hash">): string {
  return createHash("sha256").update(prevHash).update(canonicalize(event)).digest("hex");
}

/** Encadenador en memoria para una fuente. La API lo respalda con la tabla audit_event. */
export class AuditChain {
  constructor(
    private seq = 0,
    private lastHash = GENESIS_HASH,
  ) {}

  append(input: AuditEventInput, now: Date = new Date()): AuditEvent {
    const parsed = AuditEventInput.parse(input);
    const base: Omit<AuditEvent, "hash"> = {
      ...parsed,
      id: randomUUID(),
      ts: now.toISOString(),
      seq: this.seq + 1,
      prevHash: this.lastHash,
    };
    const hash = computeHash(this.lastHash, base);
    this.seq = base.seq;
    this.lastHash = hash;
    return { ...base, hash };
  }

  get state(): { seq: number; lastHash: string } {
    return { seq: this.seq, lastHash: this.lastHash };
  }
}

export type ChainVerification =
  | { ok: true; count: number; lastSeq: number; lastHash: string }
  | { ok: false; count: number; brokenAt: number; reason: "hash" | "secuencia" | "encadenamiento" };

/** Verifica una secuencia de eventos de una misma fuente, ordenados por seq. */
export function verifyChain(events: readonly AuditEvent[], startHash = GENESIS_HASH): ChainVerification {
  let prev = startHash;
  let expectedSeq = events[0]?.seq ?? 1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== expectedSeq) return { ok: false, count: i, brokenAt: e.seq, reason: "secuencia" };
    if (e.prevHash !== prev) return { ok: false, count: i, brokenAt: e.seq, reason: "encadenamiento" };
    const { hash, ...rest } = e;
    if (computeHash(prev, rest) !== hash) return { ok: false, count: i, brokenAt: e.seq, reason: "hash" };
    prev = hash;
    expectedSeq++;
  }
  const last = events[events.length - 1];
  return { ok: true, count: events.length, lastSeq: last?.seq ?? 0, lastHash: prev };
}
