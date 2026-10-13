import { withTx, type Db, type Tx } from "./db.js";

/**
 * Retorno al sitio principal con dos personas (BT-026, BT-036). Una persona lo solicita, otra distinta lo
 * aprueba y la solicitud vence si nadie la aprueba a tiempo. Solo la aprobación crea el evento de conmutación
 * («retorno») que ejecutan los agentes de continuidad. Las operaciones toman un bloqueo de asesoría para que
 * dos réplicas de la API no aprueben ni creen solicitudes a la vez.
 */

export type FailbackStatus = "pendiente" | "aprobada" | "rechazada" | "vencida";

export interface FailbackActor {
  username: string;
  sub?: string;
}

export interface FailbackRequest {
  id: string;
  fromSite: string;
  toSite: string;
  reason: string;
  status: FailbackStatus;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  failoverEventId?: string;
}

export type FailbackErrorCode =
  | "sitio_activo"
  | "conmutacion_en_curso"
  | "pendiente_existente"
  | "no_existe"
  | "no_pendiente"
  | "vencida"
  | "misma_persona";

export class FailbackError extends Error {
  constructor(
    readonly code: FailbackErrorCode,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "FailbackError";
  }
}

const LOCK = 727003;

/** Dos identidades son la misma persona si coincide el nombre de usuario o el sujeto del token. */
export function samePerson(a: FailbackActor, b: { username: string; sub?: string | null }): boolean {
  if (a.username && a.username === b.username) return true;
  return !!a.sub && !!b.sub && a.sub === b.sub;
}

/** Estado vigente: una solicitud pendiente cuyo plazo pasó ya está vencida aunque la fila no se haya marcado. */
export function effectiveStatus(
  status: string,
  expiresAt: string | Date,
  now: Date = new Date(),
): FailbackStatus {
  if (status === "pendiente" && new Date(expiresAt).getTime() <= now.getTime()) return "vencida";
  return status as FailbackStatus;
}

export function failbackRow(r: Record<string, unknown>, now: Date = new Date()): FailbackRequest {
  const row: FailbackRequest = {
    id: String(r.id),
    fromSite: String(r.from_site),
    toSite: String(r.to_site),
    reason: String(r.reason),
    status: effectiveStatus(String(r.status), String(r.expires_at), now),
    requestedBy: String(r.requested_by),
    requestedAt: String(r.requested_at),
    expiresAt: String(r.expires_at),
  };
  if (r.decided_by != null) row.decidedBy = String(r.decided_by);
  if (r.decided_at != null) row.decidedAt = String(r.decided_at);
  if (r.decision_reason != null) row.decisionReason = String(r.decision_reason);
  if (r.failover_event_id != null) row.failoverEventId = String(r.failover_event_id);
  return row;
}

/** Marca como vencidas las solicitudes pendientes cuyo plazo pasó y las devuelve (para auditarlas). */
async function expireStale(tx: Tx): Promise<FailbackRequest[]> {
  const res = await tx.query(
    "UPDATE nexo.failback_request SET status = 'vencida' WHERE status = 'pendiente' AND expires_at <= now() RETURNING *",
  );
  return res.rows.map((r) => failbackRow(r));
}

async function guardSite(tx: Tx, primarySite: string): Promise<string> {
  const active = String(
    (await tx.query("SELECT active_site FROM nexo.continuity_settings WHERE id = 1")).rows[0]?.active_site ??
      primarySite,
  );
  if (active === primarySite)
    throw new FailbackError(
      "sitio_activo",
      `El sitio principal (${primarySite.toUpperCase()}) ya es el sitio activo`,
    );
  const busy = await tx.query("SELECT 1 FROM nexo.failover_event WHERE status = 'en_curso'");
  if (busy.rowCount) throw new FailbackError("conmutacion_en_curso", "Ya hay una conmutación en curso");
  return active;
}

/** Crea la solicitud de retorno. Devuelve además las solicitudes que vencieron (se marcan en la misma transacción). */
export async function requestFailback(
  db: Db,
  input: { actor: FailbackActor; reason: string; ttlMinutes: number; primarySite?: string },
): Promise<{ request: FailbackRequest; expired: FailbackRequest[] }> {
  const primary = input.primarySite ?? "cpd";
  return withTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    const expired = await expireStale(tx);
    const from = await guardSite(tx, primary);
    const pending = (
      await tx.query("SELECT id, requested_by FROM nexo.failback_request WHERE status = 'pendiente'")
    ).rows[0];
    if (pending) {
      throw new FailbackError(
        "pendiente_existente",
        `Ya hay una solicitud de retorno pendiente (de ${String(pending.requested_by)})`,
        String(pending.id),
      );
    }
    const res = await tx.query(
      `INSERT INTO nexo.failback_request (from_site, to_site, reason, requested_by, requested_by_sub, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING *`,
      [from, primary, input.reason, input.actor.username, input.actor.sub ?? null, input.ttlMinutes],
    );
    return { request: failbackRow(res.rows[0]), expired };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getFailbackRequest(
  db: Db,
  id: string,
): Promise<(FailbackRequest & { requestedBySub?: string }) | undefined> {
  if (!UUID.test(id)) return undefined;
  const r = (await db.query("SELECT * FROM nexo.failback_request WHERE id = $1", [id])).rows[0];
  if (!r) return undefined;
  return {
    ...failbackRow(r),
    ...(r.requested_by_sub != null ? { requestedBySub: String(r.requested_by_sub) } : {}),
  };
}

export async function listFailbackRequests(db: Db, limit = 50): Promise<FailbackRequest[]> {
  const res = await db.query("SELECT * FROM nexo.failback_request ORDER BY requested_at DESC LIMIT $1", [
    Math.min(Math.max(limit, 1), 200),
  ]);
  return res.rows.map((r) => failbackRow(r));
}

type Decision =
  | { kind: "aprobada"; request: FailbackRequest; failoverEvent: Record<string, unknown> }
  | { kind: "rechazada"; request: FailbackRequest }
  | { kind: "vencida"; request: FailbackRequest };

async function lockPending(
  tx: Tx,
  id: string,
): Promise<{ row: Record<string, unknown> } | { expired: FailbackRequest }> {
  if (!UUID.test(id)) throw new FailbackError("no_existe", "La solicitud de retorno no existe");
  await tx.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
  // El vencimiento se evalúa con el reloj de la base, el mismo que fijó el plazo.
  const row = (
    await tx.query(
      "SELECT *, expires_at <= now() AS vencio FROM nexo.failback_request WHERE id = $1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row) throw new FailbackError("no_existe", "La solicitud de retorno no existe");
  if (row.status !== "pendiente")
    throw new FailbackError("no_pendiente", `La solicitud de retorno está ${String(row.status)}`, id);
  if (row.vencio === true) {
    const upd = await tx.query(
      "UPDATE nexo.failback_request SET status = 'vencida' WHERE id = $1 RETURNING *",
      [id],
    );
    return { expired: failbackRow(upd.rows[0]) };
  }
  return { row };
}

/**
 * Aprueba la solicitud: exige otra persona, que siga pendiente y vigente, que el sitio principal no sea ya el
 * activo y que no haya otra conmutación en curso. Crea el evento «retorno» con quién lo pidió y quién lo aprobó.
 */
export async function approveFailback(
  db: Db,
  input: { id: string; actor: FailbackActor; reason?: string; primarySite?: string },
): Promise<{ request: FailbackRequest; failoverEvent: Record<string, unknown> }> {
  const primary = input.primarySite ?? "cpd";
  const out: Decision = await withTx(db, async (tx) => {
    const locked = await lockPending(tx, input.id);
    if ("expired" in locked) return { kind: "vencida", request: locked.expired };
    const { row } = locked;
    if (
      samePerson(input.actor, {
        username: String(row.requested_by),
        sub: row.requested_by_sub as string | null,
      })
    ) {
      throw new FailbackError(
        "misma_persona",
        "Regla de cuatro ojos: quien solicitó el retorno no puede aprobarlo",
        input.id,
      );
    }
    const from = await guardSite(tx, primary);
    const ev = await tx.query(
      `INSERT INTO nexo.failover_event (kind, trigger, from_site, to_site, requested_by, approved_by, steps)
       VALUES ('retorno', 'manual', $1, $2, $3, $4, '[]') RETURNING *`,
      [from, String(row.to_site), String(row.requested_by), input.actor.username],
    );
    const upd = await tx.query(
      `UPDATE nexo.failback_request SET status = 'aprobada', decided_by = $1, decided_by_sub = $2, decided_at = now(),
         decision_reason = $3, failover_event_id = $4 WHERE id = $5 RETURNING *`,
      [input.actor.username, input.actor.sub ?? null, input.reason ?? null, ev.rows[0].id, input.id],
    );
    return {
      kind: "aprobada",
      request: failbackRow(upd.rows[0]),
      failoverEvent: ev.rows[0] as Record<string, unknown>,
    };
  });
  if (out.kind === "vencida")
    throw new FailbackError(
      "vencida",
      `La solicitud de retorno venció el ${out.request.expiresAt}; debe solicitarse de nuevo`,
      input.id,
    );
  if (out.kind !== "aprobada") throw new Error("estado inesperado");
  return { request: out.request, failoverEvent: out.failoverEvent };
}

/** Rechaza (o retira) una solicitud pendiente con un motivo. Quien la pidió también puede retirarla. */
export async function rejectFailback(
  db: Db,
  input: { id: string; actor: FailbackActor; reason: string },
): Promise<FailbackRequest> {
  const out: Decision = await withTx(db, async (tx) => {
    const locked = await lockPending(tx, input.id);
    if ("expired" in locked) return { kind: "vencida", request: locked.expired };
    const upd = await tx.query(
      `UPDATE nexo.failback_request SET status = 'rechazada', decided_by = $1, decided_by_sub = $2, decided_at = now(), decision_reason = $3
       WHERE id = $4 RETURNING *`,
      [input.actor.username, input.actor.sub ?? null, input.reason, input.id],
    );
    return { kind: "rechazada", request: failbackRow(upd.rows[0]) };
  });
  if (out.kind === "vencida")
    throw new FailbackError(
      "vencida",
      `La solicitud de retorno venció el ${out.request.expiresAt}`,
      input.id,
    );
  return out.request;
}
