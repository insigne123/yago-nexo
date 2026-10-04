import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { createBlock, releaseBlock, type Db } from "@nexo/console-db";
import type { Wso2Client } from "@nexo/wso2-client";
import { assertFourEyes, CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB, WSO2 } from "../common/tokens.js";
import { parse } from "../common/validation.js";

/**
 * El guardián filtra la analítica del gateway por el id de la API en WSO2. La Consola identifica las APIs del
 * catálogo como «api:<id de WSO2>»; se aceptan ambas formas y se guarda siempre el id de WSO2.
 */
export const wso2ApiId = (id: string | undefined) => (id ? id.replace(/^api:/, "") : id) || undefined;

/** Guardián de anomalías (D-02): reglas, eventos y bloqueos en el gateway. */
const RuleSchema = z.object({
  name: z.string().min(3).max(120),
  apiId: z.string().max(200).optional().transform(wso2ApiId),
  consumerId: z.string().max(200).optional(),
  metric: z.enum(["volumen", "errores", "latencia", "tamano", "ips_distintas", "fuera_de_horario"]),
  sensitivity: z.number().min(1).max(10),
  minVolume: z.number().int().min(1).max(1_000_000).default(30),
  action: z.enum(["alertar", "bloquear_automatico", "bloquear_con_aprobacion"]),
  blockTtlMinutes: z.number().int().min(1).max(10_080).default(30),
  enabled: z.boolean().default(true),
});

const ReasonSchema = z.object({ reason: z.string().max(1000).optional() }).default({});

export const ruleRow = (r: Record<string, unknown>) => ({
  id: r.id,
  name: r.name,
  apiId: r.api_id ?? undefined,
  consumerId: r.consumer_id ?? undefined,
  metric: r.metric,
  sensitivity: Number(r.sensitivity),
  minVolume: r.min_volume,
  action: r.action,
  blockTtlMinutes: r.block_ttl_minutes,
  enabled: r.enabled,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

export const eventRow = (r: Record<string, unknown>) => ({
  id: r.id,
  ts: r.ts,
  ruleId: r.rule_id,
  apiName: r.api_name ?? undefined,
  consumer: r.consumer ?? undefined,
  sourceIp: r.source_ip ?? undefined,
  metric: r.metric,
  observed: Number(r.observed),
  baseline: Number(r.baseline),
  score: Number(r.score),
  actionTaken: r.action_taken ?? undefined,
  blockId: r.block_id ?? undefined,
  status: r.status,
  approvedBy: r.approved_by ?? undefined,
});

export const blockRow = (r: Record<string, unknown>) => ({
  id: r.id,
  denyPolicyId: r.deny_policy_id ?? undefined,
  conditionType: r.condition_type,
  conditionValue: r.condition_value,
  reason: r.reason ?? undefined,
  active: r.active,
  createdAt: r.created_at,
  expiresAt: r.expires_at ?? undefined,
  createdBy: r.created_by,
  releasedBy: r.released_by ?? undefined,
});

@Controller()
export class AnomaliesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WSO2) private readonly wso2: Wso2Client,
    private readonly audit: AuditService,
  ) {}

  @Get("anomaly-rules")
  @RequirePermission("anomaly:read")
  async rules() {
    return (await this.db.query("SELECT * FROM nexo.anomaly_rule ORDER BY name")).rows.map(ruleRow);
  }

  @Post("anomaly-rules")
  @RequirePermission("anomaly:rules:write")
  async createRule(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = parse(RuleSchema, body);
    const res = await this.db.query(
      `INSERT INTO nexo.anomaly_rule (name, api_id, consumer_id, metric, sensitivity, min_volume, action, block_ttl_minutes, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [r.name, r.apiId ?? null, r.consumerId ?? null, r.metric, r.sensitivity, r.minVolume, r.action, r.blockTtlMinutes, r.enabled, user.username],
    );
    await this.audit.record(user, "anomalias.regla.crear", `regla/${res.rows[0].id}`, "exito", r);
    return ruleRow(res.rows[0]);
  }

  @Patch("anomaly-rules/:id")
  @RequirePermission("anomaly:rules:write")
  async updateRule(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = parse(RuleSchema, body);
    const res = await this.db.query(
      `UPDATE nexo.anomaly_rule SET name=$1, api_id=$2, consumer_id=$3, metric=$4, sensitivity=$5, min_volume=$6, action=$7, block_ttl_minutes=$8, enabled=$9, updated_at=now()
       WHERE id = $10 RETURNING *`,
      [r.name, r.apiId ?? null, r.consumerId ?? null, r.metric, r.sensitivity, r.minVolume, r.action, r.blockTtlMinutes, r.enabled, id],
    );
    if (!res.rows[0]) throw new NotFoundException({ statusCode: 404, message: "La regla no existe" });
    await this.audit.record(user, "anomalias.regla.actualizar", `regla/${id}`, "exito", r);
    return ruleRow(res.rows[0]);
  }

  @Get("anomalies")
  @RequirePermission("anomaly:read")
  async events(@Query("status") status?: string) {
    const res = await this.db.query(
      `SELECT * FROM nexo.anomaly_event ${status ? "WHERE status = $1" : ""} ORDER BY ts DESC LIMIT 200`,
      status ? [status] : [],
    );
    return res.rows.map(eventRow);
  }

  /** Aprobación de un bloqueo propuesto (bloquear_con_aprobacion). Cuatro ojos: el motor propone, una persona aprueba. */
  @Post("anomalies/:id/approve-block")
  @HttpCode(200)
  @RequirePermission("anomaly:block:approve")
  async approveBlock(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    const ev = (await this.db.query("SELECT e.*, r.block_ttl_minutes FROM nexo.anomaly_event e LEFT JOIN nexo.anomaly_rule r ON r.id = e.rule_id WHERE e.id = $1", [id])).rows[0];
    if (!ev) throw new NotFoundException({ statusCode: 404, message: "La anomalía no existe" });
    if (ev.status !== "bloqueo_propuesto") throw new ConflictException({ statusCode: 409, message: `La anomalía está en estado ${ev.status}` });
    assertFourEyes(user, ev.detected_by as string | undefined, "el bloqueo");
    const target = ev.consumer ? { type: "APPLICATION" as const, value: String(ev.consumer) } : { type: "IP" as const, value: String(ev.source_ip) };
    const block = await createBlock(this.db, this.wso2.admin, {
      conditionType: target.type,
      conditionValue: target.value,
      reason: `Anomalía ${ev.metric} aprobada por ${user.username}`,
      ttlMinutes: Number(ev.block_ttl_minutes ?? 30),
      createdBy: user.username,
    });
    const upd = (
      await this.db.query(
        "UPDATE nexo.anomaly_event SET status = 'bloqueada', block_id = $1, approved_by = $2, action_taken = 'bloqueo_aprobado' WHERE id = $3 RETURNING *",
        [block.id, user.username, id],
      )
    ).rows[0];
    await this.audit.record(user, "anomalias.bloqueo.aprobar", `anomalia/${id}`, "exito", { bloqueo: block.id, objetivo: target.value, tipoObjetivo: target.type });
    return eventRow(upd);
  }

  @Post("anomalies/:id/dismiss")
  @HttpCode(200)
  @RequirePermission("anomaly:block:approve")
  async dismiss(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(ReasonSchema, body ?? {});
    const res = await this.db.query("UPDATE nexo.anomaly_event SET status = 'descartada', dismissed_by = $1, reason = $2 WHERE id = $3 RETURNING *", [
      user.username,
      reason ?? null,
      id,
    ]);
    if (!res.rows[0]) throw new NotFoundException({ statusCode: 404, message: "La anomalía no existe" });
    await this.audit.record(user, "anomalias.descartar", `anomalia/${id}`, "exito", { reason });
    return eventRow(res.rows[0]);
  }

  @Get("blocks")
  @RequirePermission("anomaly:read")
  async blocks() {
    return (await this.db.query("SELECT * FROM nexo.block ORDER BY active DESC, created_at DESC LIMIT 200")).rows.map(blockRow);
  }

  @Post("blocks/:id/release")
  @HttpCode(200)
  @RequirePermission("anomaly:block:release")
  async release(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(ReasonSchema, body ?? {});
    const block = await releaseBlock(this.db, this.wso2.admin, id, user.username);
    if (!block) throw new NotFoundException({ statusCode: 404, message: "El bloqueo no existe" });
    await this.audit.record(user, "anomalias.bloqueo.liberar", `bloqueo/${id}`, "exito", { reason });
    return blockRow(block);
  }
}
