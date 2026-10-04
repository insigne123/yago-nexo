import { Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { Db } from "@nexo/console-db";
import { CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB } from "../common/tokens.js";
import { parse } from "../common/validation.js";

/** Descubrimiento de APIs no gobernadas (D-01). El motor nexo-discovery ejecuta los escaneos pendientes. */
const ScanSchema = z.object({
  sources: z.array(z.enum(["apisix", "nginx", "red", "gcp"])).min(1).default(["apisix", "nginx", "red"]),
  targets: z.array(z.string().max(200)).max(256).default([]),
});

const TriageSchema = z.object({
  status: z.enum(["nuevo", "gobernado", "riesgo_aceptado", "en_migracion", "descartado"]),
  note: z.string().max(1000).optional(),
});

const scanRow = (r: Record<string, unknown>) => ({
  id: r.id,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at ?? undefined,
  sources: r.sources,
  targets: r.targets,
  totals: r.totals,
  error: r.error ?? undefined,
  requestedBy: r.requested_by,
});

const findingRow = (r: Record<string, unknown>) => ({
  id: r.id,
  scanId: r.scan_id ?? undefined,
  source: r.source,
  host: r.host,
  port: r.port ?? undefined,
  path: r.path,
  protocol: r.protocol ?? undefined,
  specFound: r.spec_found,
  authDetected: r.auth_detected,
  tls: r.tls ?? undefined,
  personalDataSuspected: r.personal_data_suspected,
  matchedApiId: r.matched_api_id ?? undefined,
  exposureScore: r.exposure_score,
  reasons: r.reasons,
  status: r.status,
  note: r.note ?? undefined,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

@Controller("discovery")
export class DiscoveryController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get("scans")
  @RequirePermission("discovery:read")
  async scans() {
    const res = await this.db.query("SELECT * FROM nexo.discovery_scan ORDER BY started_at DESC LIMIT 100");
    return res.rows.map(scanRow);
  }

  @Post("scans")
  @HttpCode(202)
  @RequirePermission("discovery:scan")
  async scan(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const req = parse(ScanSchema, body ?? {});
    const res = await this.db.query(
      "INSERT INTO nexo.discovery_scan (sources, targets, requested_by) VALUES ($1, $2, $3) RETURNING *",
      [req.sources, req.targets, user.username],
    );
    await this.audit.record(user, "descubrimiento.escanear", `scan/${res.rows[0].id}`, "exito", req);
    return scanRow(res.rows[0]);
  }

  @Get("findings")
  @RequirePermission("discovery:read")
  async findings(@Query("status") status?: string) {
    const res = await this.db.query(
      `SELECT * FROM nexo.discovery_finding ${status ? "WHERE status = $1" : ""} ORDER BY exposure_score DESC, last_seen DESC`,
      status ? [status] : [],
    );
    return res.rows.map(findingRow);
  }

  @Patch("findings/:id")
  @RequirePermission("discovery:triage")
  async triage(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const req = parse(TriageSchema, body);
    const res = await this.db.query("UPDATE nexo.discovery_finding SET status = $1, note = $2 WHERE id = $3 RETURNING *", [req.status, req.note ?? null, id]);
    if (!res.rows[0]) throw new NotFoundException({ statusCode: 404, message: "El hallazgo no existe" });
    await this.audit.record(user, "descubrimiento.clasificar", `hallazgo/${id}`, "exito", req);
    return findingRow(res.rows[0]);
  }

  @Get("report")
  @RequirePermission("discovery:read")
  @Header("cache-control", "no-store")
  async report(@Query("format") format = "json") {
    const res = await this.db.query("SELECT * FROM nexo.discovery_finding ORDER BY exposure_score DESC");
    const rows = res.rows.map(findingRow);
    if (format !== "csv") {
      return {
        generadoEn: new Date().toISOString(),
        total: rows.length,
        noGobernados: rows.filter((r) => !r.matchedApiId).length,
        riesgoAlto: rows.filter((r) => Number(r.exposureScore) >= 70).length,
        hallazgos: rows,
      };
    }
    const head = ["fuente", "host", "puerto", "ruta", "autenticacion", "tls", "datos_personales", "api_gobernada", "puntaje", "motivos", "estado"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.source, r.host, r.port, r.path, r.authDetected, r.tls, r.personalDataSuspected ? "si" : "no", r.matchedApiId ?? "", r.exposureScore, (r.reasons as string[]).join("; "), r.status]
        .map(esc)
        .join(","),
    );
    return [head.join(","), ...lines].join("\n");
  }
}
