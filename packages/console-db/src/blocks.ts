import type { Db } from "./db.js";

/** Lo mínimo de la Admin API de WSO2 que necesitan los bloqueos (deny policies). */
export interface DenyPolicyAdmin {
  createDenyPolicy(conditionType: BlockTarget, conditionValue: unknown): Promise<{ conditionId: string }>;
  deleteDenyPolicy(conditionId: string): Promise<unknown>;
}

export type BlockTarget = "APPLICATION" | "IP" | "USER" | "API";

/**
 * Crea el bloqueo en el gateway (deny policy de WSO2) y lo registra con su vencimiento (D-02).
 * Para APPLICATION el valor es "dueño:aplicación", como lo identifica WSO2.
 */
export async function createBlock(
  db: Db,
  admin: DenyPolicyAdmin,
  input: { conditionType: BlockTarget; conditionValue: string; reason: string; ttlMinutes: number; createdBy: string },
): Promise<Record<string, unknown>> {
  const value = input.conditionType === "IP" ? { fixedIp: input.conditionValue, invert: false } : input.conditionValue;
  const policy = await admin.createDenyPolicy(input.conditionType, value);
  const res = await db.query(
    `INSERT INTO nexo.block (deny_policy_id, condition_type, condition_value, reason, expires_at, created_by)
     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), $6) RETURNING *`,
    [policy.conditionId, input.conditionType, input.conditionValue, input.reason, input.ttlMinutes, input.createdBy],
  );
  return res.rows[0] as Record<string, unknown>;
}

/** Levanta el bloqueo en el gateway (tolera que la deny policy ya no exista) y lo marca liberado. */
export async function releaseBlock(db: Db, admin: DenyPolicyAdmin, blockId: string, releasedBy: string): Promise<Record<string, unknown> | undefined> {
  const block = (await db.query("SELECT * FROM nexo.block WHERE id = $1", [blockId])).rows[0];
  if (!block) return undefined;
  if (block.active && block.deny_policy_id) {
    await admin.deleteDenyPolicy(String(block.deny_policy_id)).catch((e: unknown) => {
      if (!(e instanceof Error && /\b404\b/.test(e.message))) throw e;
    });
  }
  const upd = await db.query("UPDATE nexo.block SET active = false, released_by = $1, released_at = now() WHERE id = $2 RETURNING *", [releasedBy, blockId]);
  await db.query("UPDATE nexo.anomaly_event SET status = 'resuelta' WHERE block_id = $1 AND status = 'bloqueada'", [blockId]);
  return upd.rows[0] as Record<string, unknown>;
}
