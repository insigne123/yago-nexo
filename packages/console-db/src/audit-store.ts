import { randomUUID } from "node:crypto";
import { AuditEventInput, computeHash, GENESIS_HASH, type AuditEvent } from "@nexo/shared";
import { withTx, type Db } from "./db.js";

/**
 * Persistencia de la cadena de auditoría (BT-031, BT-032). La secuencia y el hash previo se leen
 * bajo un bloqueo de asesoría, así varias réplicas de la API escriben una única cadena ordenada.
 */
export class AuditStore {
  constructor(private readonly db: Db) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const parsed = AuditEventInput.parse(input);
    return withTx(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(727002)");
      const last = await tx.query<{ seq: number; hash: string }>(
        "SELECT seq, hash FROM nexo.audit_event ORDER BY seq DESC LIMIT 1",
      );
      const prevHash = last.rows[0]?.hash ?? GENESIS_HASH;
      const base: Omit<AuditEvent, "hash"> = {
        ...parsed,
        id: randomUUID(),
        ts: new Date().toISOString(),
        seq: (last.rows[0]?.seq ?? 0) + 1,
        prevHash,
      };
      const hash = computeHash(prevHash, base);
      await tx.query(
        `INSERT INTO nexo.audit_event (id, seq, ts, source, actor, actor_type, action, resource, result, source_ip, correlation_id, details, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          base.id,
          base.seq,
          base.ts,
          base.source,
          base.actor,
          base.actorType,
          base.action,
          base.resource ?? null,
          base.result,
          base.sourceIp ?? null,
          base.correlationId ?? null,
          base.details ? JSON.stringify(base.details) : null,
          base.prevHash,
          hash,
        ],
      );
      return { ...base, hash };
    });
  }

  async list(filter: { from?: string; to?: string; actor?: string; action?: string; limit?: number }): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from) where.push(`ts >= $${params.push(filter.from)}`);
    if (filter.to) where.push(`ts <= $${params.push(filter.to)}`);
    if (filter.actor) where.push(`actor ILIKE $${params.push(`%${filter.actor}%`)}`);
    if (filter.action) where.push(`action ILIKE $${params.push(`%${filter.action}%`)}`);
    const limit = Math.min(filter.limit ?? 200, 1000);
    const res = await this.db.query(
      `SELECT * FROM nexo.audit_event ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}`,
      params,
    );
    return res.rows.map(rowToEvent);
  }

  /** Todos los eventos en orden, para verificar la cadena completa. */
  async all(): Promise<AuditEvent[]> {
    const res = await this.db.query("SELECT * FROM nexo.audit_event ORDER BY seq ASC");
    return res.rows.map(rowToEvent);
  }
}

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  const ev: Record<string, unknown> = {
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
  if (r.resource != null) ev.resource = r.resource;
  if (r.source_ip != null) ev.sourceIp = r.source_ip;
  if (r.correlation_id != null) ev.correlationId = r.correlation_id;
  if (r.details != null) ev.details = r.details;
  return ev as unknown as AuditEvent;
}
