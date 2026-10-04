import type { AuditEvent, ChainVerification } from "../api/types";
import { sha256Hex } from "../lib/sha256";

/**
 * Cadena de auditoría simulada con el mismo algoritmo que @nexo/shared (BT-032):
 * hash = SHA-256(hashPrevio + evento canónico), con claves ordenadas y sin el propio hash.
 */

export const GENESIS_HASH = "0".repeat(64);

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function computeHash(prevHash: string, event: Omit<AuditEvent, "hash">): string {
  return sha256Hex(prevHash + canonicalize(event));
}

export interface AuditInput {
  actor: string;
  actorType: "usuario" | "tecnico";
  action: string;
  resource?: string;
  result: "exito" | "rechazado" | "error";
  sourceIp?: string;
  ts: string;
}

function pseudoUuid(seq: number, ts: string): string {
  const h = sha256Hex(`${seq}|${ts}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Agrega un evento al final de la cadena (los eventos se mantienen ordenados por seq). */
export function appendAudit(chain: AuditEvent[], input: AuditInput): AuditEvent {
  const last = chain.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const base: Omit<AuditEvent, "hash"> = {
    id: pseudoUuid(seq, input.ts),
    seq,
    ts: input.ts,
    source: "consola",
    actor: input.actor,
    actorType: input.actorType,
    action: input.action,
    resource: input.resource,
    result: input.result,
    sourceIp: input.sourceIp,
    correlationId: `corr-${sha256Hex(`${seq}${input.action}`).slice(0, 12)}`,
    prevHash,
  };
  const event: AuditEvent = { ...base, hash: computeHash(prevHash, base) };
  chain.push(event);
  return event;
}

export function verifyAudit(chain: readonly AuditEvent[]): ChainVerification {
  let prev = GENESIS_HASH;
  let expected = chain[0]?.seq ?? 1;
  for (let i = 0; i < chain.length; i++) {
    const event = chain[i]!;
    if (event.seq !== expected) return { ok: false, count: i, brokenAt: event.seq, reason: "secuencia" };
    if (event.prevHash !== prev)
      return { ok: false, count: i, brokenAt: event.seq, reason: "encadenamiento" };
    const { hash, ...rest } = event;
    if (computeHash(prev, rest) !== hash) return { ok: false, count: i, brokenAt: event.seq, reason: "hash" };
    prev = hash ?? "";
    expected++;
  }
  return { ok: true, count: chain.length, lastSeq: chain.at(-1)?.seq ?? 0 };
}
