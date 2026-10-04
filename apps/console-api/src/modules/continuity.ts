import { Body, ConflictException, Controller, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import { z } from "zod";
import type { Db } from "@nexo/console-db";
import { CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB } from "../common/tokens.js";
import { parse } from "../common/validation.js";

/**
 * Continuidad CPD ↔ Google Cloud (BT-036 manual, D-05 automática). Los agentes nexo-failover de cada sitio
 * escriben su salud y voto; el agente líder ejecuta conmutaciones, simulacros y retornos aprobados.
 */
const ModeSchema = z.object({ mode: z.enum(["manual", "automatico"]) });
const ReasonSchema = z.object({ reason: z.string().max(1000).optional() }).default({});

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
  steps: r.steps,
  status: r.status,
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
    const sites = (await this.db.query("SELECT * FROM nexo.site_status ORDER BY CASE role WHEN 'primario' THEN 1 WHEN 'respaldo' THEN 2 ELSE 3 END")).rows;
    const votesDown = sites.filter((s) => s.vote === "primario_caido").length;
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
    };
  }

  @Put("mode")
  @RequirePermission("admin:settings:write")
  async mode(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { mode } = parse(ModeSchema, body);
    await this.db.query("UPDATE nexo.continuity_settings SET mode = $1, updated_at = now(), updated_by = $2 WHERE id = 1", [mode, user.username]);
    await this.audit.record(user, "continuidad.modo", "continuidad", "exito", { mode });
    return this.state();
  }

  @Post("drill")
  @HttpCode(202)
  @RequirePermission("continuity:drill")
  async drill(@CurrentUser() user: AuthUser) {
    const active = await this.db.query("SELECT 1 FROM nexo.failover_event WHERE status = 'en_curso'");
    if (active.rowCount) throw new ConflictException({ statusCode: 409, message: "Ya hay una conmutación en curso" });
    const s = (await this.db.query("SELECT active_site FROM nexo.continuity_settings WHERE id = 1")).rows[0];
    const from = String(s?.active_site ?? "cpd");
    const to = from === "cpd" ? "gcp" : "cpd";
    const res = await this.db.query(
      `INSERT INTO nexo.failover_event (kind, trigger, from_site, to_site, requested_by, steps) VALUES ('simulacro','simulacro',$1,$2,$3,'[]') RETURNING *`,
      [from, to, user.username],
    );
    await this.audit.record(user, "continuidad.simulacro", `conmutacion/${res.rows[0].id}`, "exito", { from, to });
    return failoverRow(res.rows[0]);
  }

  /** El retorno al sitio principal siempre es guiado y requiere aprobación (evita rebotes entre sitios). */
  @Post("failback")
  @HttpCode(202)
  @RequirePermission("continuity:failback:approve")
  async failback(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(ReasonSchema, body ?? {});
    const s = (await this.db.query("SELECT active_site FROM nexo.continuity_settings WHERE id = 1")).rows[0];
    if ((s?.active_site ?? "cpd") === "cpd") throw new ConflictException({ statusCode: 409, message: "El CPD ya es el sitio activo" });
    const active = await this.db.query("SELECT 1 FROM nexo.failover_event WHERE status = 'en_curso'");
    if (active.rowCount) throw new ConflictException({ statusCode: 409, message: "Ya hay una conmutación en curso" });
    const res = await this.db.query(
      `INSERT INTO nexo.failover_event (kind, trigger, from_site, to_site, requested_by, approved_by, steps) VALUES ('retorno','manual',$1,'cpd',$2,$2,'[]') RETURNING *`,
      [s?.active_site, user.username],
    );
    await this.audit.record(user, "continuidad.retorno.aprobar", `conmutacion/${res.rows[0].id}`, "exito", { reason });
    return failoverRow(res.rows[0]);
  }

  @Get("events")
  @RequirePermission("continuity:read")
  async events() {
    return (await this.db.query("SELECT * FROM nexo.failover_event ORDER BY started_at DESC LIMIT 50")).rows.map(failoverRow);
  }
}
