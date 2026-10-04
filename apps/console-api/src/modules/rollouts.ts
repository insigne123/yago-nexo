import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { Db } from "@nexo/console-db";
import { assertFourEyes, CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB } from "../common/tokens.js";
import { parse } from "../common/validation.js";

/** Despliegues progresivos canary y blue-green (D-04). El motor nexo-rollout los ejecuta una vez aprobados. */
const RolloutSchema = z.object({
  apiId: z.string().min(1),
  strategy: z.enum(["canary", "blue_green"]),
  candidateEndpoint: z.string().url(),
  steps: z.array(z.number().int().min(1).max(100)).min(1).max(10).default([5, 25, 50, 100]),
  stepDurationSec: z.number().int().min(10).max(3600).default(60),
  thresholds: z
    .object({
      maxErrorRate: z.number().min(0).max(1).default(0.02),
      maxP99Ms: z.number().min(1).max(60_000).default(800),
      minRequests: z.number().int().min(1).max(100_000).default(20),
    })
    .default({ maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 20 }),
  environment: z.enum(["dev", "qa", "prod"]).default("prod"),
});

const ReasonSchema = z.object({ reason: z.string().max(1000).optional() }).default({});

export function rolloutRow(r: Record<string, unknown>, steps: Array<Record<string, unknown>> = []) {
  return {
    id: r.id,
    apiId: r.api_id,
    apiName: r.api_name ?? undefined,
    strategy: r.strategy,
    candidateEndpoint: r.candidate_endpoint,
    stableEndpoint: r.stable_endpoint ?? undefined,
    steps: r.steps,
    stepDurationSec: r.step_duration_sec,
    thresholds: r.thresholds,
    environment: r.environment,
    status: r.status,
    currentWeight: r.current_weight,
    rollbackReason: r.rollback_reason ?? undefined,
    createdBy: r.created_by,
    approvedBy: r.approved_by ?? undefined,
    createdAt: r.created_at,
    stepsDone: steps.map((s) => ({
      weight: s.weight,
      startedAt: s.started_at,
      endedAt: s.ended_at ?? undefined,
      requests: s.requests,
      errorRate: s.error_rate == null ? undefined : Number(s.error_rate),
      p99Ms: s.p99_ms == null ? undefined : Number(s.p99_ms),
      decision: s.decision,
    })),
  };
}

@Controller("rollouts")
export class RolloutsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async load(id: string) {
    const r = (await this.db.query("SELECT * FROM nexo.rollout WHERE id = $1", [id])).rows[0];
    if (!r) throw new NotFoundException({ statusCode: 404, message: "El despliegue no existe" });
    const steps = (await this.db.query("SELECT * FROM nexo.rollout_step WHERE rollout_id = $1 ORDER BY id", [id])).rows;
    return rolloutRow(r, steps);
  }

  @Get()
  @RequirePermission("rollout:read")
  async list() {
    const rows = (await this.db.query("SELECT * FROM nexo.rollout ORDER BY created_at DESC LIMIT 100")).rows;
    return rows.map((r) => rolloutRow(r));
  }

  @Get(":id")
  @RequirePermission("rollout:read")
  get(@Param("id") id: string) {
    return this.load(id);
  }

  @Post()
  @RequirePermission("rollout:create")
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = parse(RolloutSchema, body);
    const api = (await this.db.query("SELECT * FROM nexo.api_asset WHERE id = $1 OR wso2_api_id = $1", [r.apiId])).rows[0];
    if (!api) throw new NotFoundException({ statusCode: 404, message: "La API no existe en el catálogo" });
    const active = await this.db.query("SELECT 1 FROM nexo.rollout WHERE api_id = $1 AND status IN ('pendiente_aprobacion','en_curso')", [api.wso2_api_id]);
    if (active.rowCount) throw new ConflictException({ statusCode: 409, message: "Ya hay un despliegue en curso para esta API" });
    const steps = r.strategy === "blue_green" ? [100] : r.steps;
    const res = await this.db.query(
      `INSERT INTO nexo.rollout (api_id, api_name, strategy, candidate_endpoint, steps, step_duration_sec, thresholds, environment, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [api.wso2_api_id, `${api.name} ${api.version}`, r.strategy, r.candidateEndpoint, steps, r.stepDurationSec, JSON.stringify(r.thresholds), r.environment, user.username],
    );
    await this.audit.record(user, "despliegue.crear", `rollout/${res.rows[0].id}`, "exito", { api: api.name, ...r });
    return rolloutRow(res.rows[0]);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("rollout:approve")
  async approve(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    const r = (await this.db.query("SELECT * FROM nexo.rollout WHERE id = $1", [id])).rows[0];
    if (!r) throw new NotFoundException({ statusCode: 404, message: "El despliegue no existe" });
    if (r.status !== "pendiente_aprobacion") throw new ConflictException({ statusCode: 409, message: `El despliegue está ${r.status}` });
    assertFourEyes(user, r.created_by as string, "el despliegue");
    await this.db.query("UPDATE nexo.rollout SET status = 'en_curso', approved_by = $1, updated_at = now() WHERE id = $2", [user.username, id]);
    await this.audit.record(user, "despliegue.aprobar", `rollout/${id}`, "exito");
    return this.load(id);
  }

  @Post(":id/abort")
  @HttpCode(200)
  @RequirePermission("rollout:abort")
  async abort(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(ReasonSchema, body ?? {});
    const res = await this.db.query(
      `UPDATE nexo.rollout SET status = CASE WHEN status = 'en_curso' THEN 'abortado' ELSE status END,
         rollback_reason = COALESCE($1, 'Detenido manualmente por ' || $2), updated_at = now()
       WHERE id = $3 AND status IN ('pendiente_aprobacion','en_curso') RETURNING *`,
      [reason ?? null, user.username, id],
    );
    if (!res.rows[0]) throw new ConflictException({ statusCode: 409, message: "El despliegue no está activo" });
    if (res.rows[0].status === "pendiente_aprobacion") {
      await this.db.query("UPDATE nexo.rollout SET status = 'abortado' WHERE id = $1", [id]);
    }
    await this.audit.record(user, "despliegue.abortar", `rollout/${id}`, "exito", { reason });
    return this.load(id);
  }
}
