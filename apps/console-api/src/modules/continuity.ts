import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import {
  approveFailback,
  FailbackError,
  getFailbackRequest,
  listFailbackRequests,
  rejectFailback,
  requestFailback,
  type Db,
  type FailbackRequest,
} from "@nexo/console-db";
import {
  assertFourEyes,
  CurrentUser,
  fourEyesError,
  RequirePermission,
  type AuthUser,
} from "../auth/auth.js";
import { AuditAction } from "../common/audit-failures.js";
import { AuditService } from "../common/audit.service.js";
import { DB } from "../common/tokens.js";
import { parse } from "../common/validation.js";
import { config } from "../config.js";

/**
 * Continuidad CPD ↔ Google Cloud (BT-036 manual, D-05 automática). Los agentes nexo-failover de cada sitio
 * escriben su salud y voto; el agente líder ejecuta conmutaciones, simulacros y retornos aprobados.
 */
const ModeSchema = z.object({ mode: z.enum(["manual", "automatico"]) });
/** Motivo obligatorio para pedir o rechazar un retorno; opcional al aprobarlo. */
const RequiredReasonSchema = z.object({ reason: z.string().trim().min(5).max(1000) });
const OptionalReasonSchema = z.object({ reason: z.string().trim().max(1000).optional() }).default({});

/** Traduce los rechazos del retorno a respuestas HTTP (409 o 404; la misma persona, 403 de cuatro ojos). */
function failbackHttpError(e: unknown): unknown {
  if (!(e instanceof FailbackError)) return e;
  if (e.code === "no_existe") return new NotFoundException({ statusCode: 404, message: e.message });
  if (e.code === "misma_persona") return fourEyesError("el retorno");
  return new ConflictException({
    statusCode: 409,
    message: e.message,
    code: e.code,
    ...(e.requestId ? { requestId: e.requestId } : {}),
  });
}

/**
 * Paso de una conmutación según el contrato ({name, status, detail, ts}). Los agentes de continuidad lo
 * registran como {paso, ok, detalle} (y «pendiente» cuando queda una tarea manual); ambos formatos se aceptan.
 */
export function failoverStep(s: unknown) {
  const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const status =
    typeof x.status === "string"
      ? x.status
      : x.pendiente === true
        ? "pendiente"
        : x.ok === true
          ? "completado"
          : x.ok === false
            ? "fallido"
            : undefined;
  return {
    name: (typeof x.name === "string" ? x.name : typeof x.paso === "string" ? x.paso : undefined) as
      string | undefined,
    status,
    detail: (typeof x.detail === "string"
      ? x.detail
      : typeof x.detalle === "string"
        ? x.detalle
        : undefined) as string | undefined,
    ts: typeof x.ts === "string" ? x.ts : undefined,
  };
}

export const failoverRow = (r: Record<string, unknown>) => ({
  id: r.id,
  kind: r.kind,
  trigger: r.trigger,
  from: r.from_site,
  to: r.to_site,
  startedAt: r.started_at,
  finishedAt: r.finished_at ?? undefined,
  rtoSeconds: r.rto_seconds == null ? undefined : Number(r.rto_seconds),
  rpoSecondsEstimated: r.rpo_seconds_estimated == null ? undefined : Number(r.rpo_seconds_estimated),
  steps: Array.isArray(r.steps) ? r.steps.map(failoverStep) : [],
  status: r.status,
  requestedBy: r.requested_by ?? undefined,
  approvedBy: r.approved_by ?? undefined,
});

@Controller("continuity")
export class ContinuityController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission("continuity:read")
  async state() {
    const settings = (await this.db.query("SELECT * FROM nexo.continuity_settings WHERE id = 1")).rows[0];
    const sites = (
      await this.db.query(
        "SELECT * FROM nexo.site_status ORDER BY CASE role WHEN 'primario' THEN 1 WHEN 'respaldo' THEN 2 ELSE 3 END",
      )
    ).rows;
    const votesDown = sites.filter((s) => s.vote === "primario_caido").length;
    const pending = (await listFailbackRequests(this.db, 5)).find((r) => r.status === "pendiente");
    return {
      mode: settings?.mode ?? "manual",
      activeSite: settings?.active_site ?? "cpd",
      quorum: `2 de ${Math.max(sites.length, 3)}`,
      votosPrimarioCaido: votesDown,
      rtoObjetivoMin: Number(settings?.rto_objetivo_min ?? 15),
      rpoObjetivoMin: Number(settings?.rpo_objetivo_min ?? 1),
      sites: sites.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        active: s.id === (settings?.active_site ?? "cpd"),
        checks: s.checks,
        vote: s.vote,
        lastSeen: s.last_seen ?? undefined,
      })),
      pendingFailback: pending,
    };
  }

  @Put("mode")
  @RequirePermission("admin:settings:write")
  @AuditAction("continuidad.modo")
  async mode(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { mode } = parse(ModeSchema, body);
    await this.db.query(
      "UPDATE nexo.continuity_settings SET mode = $1, updated_at = now(), updated_by = $2 WHERE id = 1",
      [mode, user.username],
    );
    await this.audit.record(user, "continuidad.modo", "continuidad", "exito", { mode });
    return this.state();
  }

  @Post("drill")
  @HttpCode(202)
  @RequirePermission("continuity:drill")
  @AuditAction("continuidad.simulacro")
  async drill(@CurrentUser() user: AuthUser) {
    const active = await this.db.query("SELECT 1 FROM nexo.failover_event WHERE status = 'en_curso'");
    if (active.rowCount)
      throw new ConflictException({ statusCode: 409, message: "Ya hay una conmutación en curso" });
    const s = (await this.db.query("SELECT active_site FROM nexo.continuity_settings WHERE id = 1")).rows[0];
    const from = String(s?.active_site ?? "cpd");
    const to = from === "cpd" ? "gcp" : "cpd";
    const res = await this.db.query(
      `INSERT INTO nexo.failover_event (kind, trigger, from_site, to_site, requested_by, steps) VALUES ('simulacro','simulacro',$1,$2,$3,'[]') RETURNING *`,
      [from, to, user.username],
    );
    await this.audit.record(user, "continuidad.simulacro", `conmutacion/${res.rows[0].id}`, "exito", {
      from,
      to,
    });
    return failoverRow(res.rows[0]);
  }

  // ---------------------------------------------------------------- retorno al sitio principal con dos personas
  // El retorno siempre es guiado (evita rebotes entre sitios): una persona lo solicita con un motivo, otra distinta
  // lo aprueba antes de que la solicitud venza, y solo entonces se crea el evento que ejecutan los agentes.

  @Get("failback/requests")
  @RequirePermission("continuity:read")
  async failbackRequests(): Promise<FailbackRequest[]> {
    return listFailbackRequests(this.db, 50);
  }

  @Post("failback/requests")
  @HttpCode(201)
  @RequirePermission("continuity:failback:request")
  @AuditAction("continuidad.retorno.solicitar")
  async requestFailback(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<FailbackRequest> {
    const { reason } = parse(RequiredReasonSchema, body ?? {});
    const out = await requestFailback(this.db, {
      actor: { username: user.username, sub: user.sub },
      reason,
      ttlMinutes: config.continuity.failbackRequestTtlMin,
      primarySite: config.continuity.primarySite,
    }).catch((e: unknown) => {
      throw failbackHttpError(e);
    });
    await this.auditExpired(out.expired);
    const r = out.request;
    await this.audit.record(user, "continuidad.retorno.solicitar", `retorno/${r.id}`, "exito", {
      desde: r.fromSite,
      hacia: r.toSite,
      motivo: reason,
      vence: r.expiresAt,
    });
    return r;
  }

  @Post("failback/requests/:id/approve")
  @HttpCode(202)
  @RequirePermission("continuity:failback:approve")
  @AuditAction("continuidad.retorno.aprobar")
  async approveFailback(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(OptionalReasonSchema, body ?? {});
    const current = await getFailbackRequest(this.db, id);
    if (!current)
      throw new NotFoundException({ statusCode: 404, message: "La solicitud de retorno no existe" });
    assertFourEyes(user, [current.requestedBy, current.requestedBySub], "el retorno");
    try {
      const { request, failoverEvent } = await approveFailback(this.db, {
        id,
        actor: { username: user.username, sub: user.sub },
        reason,
        primarySite: config.continuity.primarySite,
      });
      await this.audit.record(user, "continuidad.retorno.aprobar", `retorno/${id}`, "exito", {
        solicitadoPor: request.requestedBy,
        conmutacion: failoverEvent.id,
        desde: request.fromSite,
        hacia: request.toSite,
        motivo: reason,
      });
      return { request, event: failoverRow(failoverEvent) };
    } catch (e) {
      if (e instanceof FailbackError && e.code === "vencida") {
        const expired = await getFailbackRequest(this.db, id);
        if (expired) await this.auditExpired([expired]);
      }
      throw failbackHttpError(e);
    }
  }

  @Post("failback/requests/:id/reject")
  @HttpCode(200)
  @RequirePermission("continuity:failback:approve")
  @AuditAction("continuidad.retorno.rechazar")
  async rejectFailback(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<FailbackRequest> {
    const { reason } = parse(RequiredReasonSchema, body ?? {});
    try {
      const r = await rejectFailback(this.db, {
        id,
        actor: { username: user.username, sub: user.sub },
        reason,
      });
      await this.audit.record(user, "continuidad.retorno.rechazar", `retorno/${id}`, "exito", {
        solicitadoPor: r.requestedBy,
        motivo: reason,
      });
      return r;
    } catch (e) {
      if (e instanceof FailbackError && e.code === "vencida") {
        const expired = await getFailbackRequest(this.db, id);
        if (expired) await this.auditExpired([expired]);
      }
      throw failbackHttpError(e);
    }
  }

  /** Una solicitud que vence sin aprobación queda en la auditoría como rechazada por plazo. */
  private async auditExpired(rows: readonly FailbackRequest[]) {
    for (const r of rows) {
      await this.audit.append({
        actor: "nexo-consola",
        actorType: "tecnico",
        action: "continuidad.retorno.vencida",
        resource: `retorno/${r.id}`,
        result: "rechazado",
        details: {
          solicitadoPor: r.requestedBy,
          vencio: r.expiresAt,
          motivo: "venció sin la aprobación de otra persona",
        },
      });
    }
  }

  @Get("events")
  @RequirePermission("continuity:read")
  async events() {
    return (
      await this.db.query("SELECT * FROM nexo.failover_event ORDER BY started_at DESC LIMIT 50")
    ).rows.map(failoverRow);
  }
}
