import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  Headers as ReqHeaders,
} from "@nestjs/common";
import type { Response } from "express";
import { zipSync, strToU8 } from "fflate";
import { collectDefaultMetrics, register } from "@prometheus-io/client";
import { permissionMatrix } from "@nexo/shared";
import type { Db } from "@nexo/console-db";
import type { Wso2Client, MiManagementClient } from "@nexo/wso2-client";
import { CurrentUser, Public, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB, MI, WSO2 } from "../common/tokens.js";
import { config } from "../config.js";
import { OpenSearchService, RabbitService, TlsProbeService } from "../integrations/integrations.js";

collectDefaultMetrics({ prefix: "nexo_consola_" });

// ------------------------------------------------------------------ sesión e inicio

@Controller()
export class SessionController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly os: OpenSearchService,
    private readonly mq: RabbitService,
  ) {}

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return { sub: user.sub, name: user.name, email: user.email, username: user.username, roles: user.roles, permissions: user.permissions };
  }

  @Get("overview")
  async overview() {
    const q = async (sql: string) => (await this.db.query(sql)).rows[0] ?? {};
    const settings = await q("SELECT active_site FROM nexo.continuity_settings WHERE id = 1");
    const sites = (await this.db.query("SELECT id, name, role, checks, last_seen FROM nexo.site_status")).rows;
    const apis = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'PUBLISHED')::int AS publicadas,
      count(*) FILTER (WHERE state = 'DEPRECATED')::int AS deprecadas FROM nexo.api_asset`);
    const comp = (await this.db.query("SELECT purpose, owner_team, contract_ref, version, auth_type, consumers_count, dependencies_count, state FROM nexo.api_asset")).rows;
    const pct = comp.length
      ? Math.round(
          comp.reduce((acc, r) => acc + Object.values(r).filter((v) => (typeof v === "number" ? v > 0 : v != null && String(v) !== "")).length / 8, 0) /
            comp.length *
            100,
        )
      : 0;
    const alerts = await q(`SELECT
      (SELECT count(*)::int FROM nexo.alert WHERE status = 'firing' AND received_at > now() - interval '24 hours') AS abiertas,
      (SELECT count(*)::int FROM nexo.anomaly_event WHERE status IN ('abierta','bloqueo_propuesto')) AS anomalias,
      (SELECT count(*)::int FROM nexo.discovery_finding WHERE status = 'nuevo') AS hallazgos,
      (SELECT count(*)::int FROM nexo.dead_letter WHERE status = 'pendiente') AS "mensajesFallidos"`);
    // La cola real manda: el registro local puede ir atrasado respecto de RabbitMQ.
    const dlq = await this.mq.queueInfo(config.rabbitmq.dlq).catch(() => undefined);
    if (dlq) alerts.mensajesFallidos = Math.max(Number(alerts.mensajesFallidos ?? 0), dlq.messages);
    const rollouts = await q(`SELECT count(*) FILTER (WHERE status = 'en_curso')::int AS "enCurso",
      count(*) FILTER (WHERE status = 'revertido' AND updated_at > now() - interval '7 days')::int AS "revertidos7d" FROM nexo.rollout`);
    let consumoHoy = { llamadas: 0, errores: 0, latenciaP95Ms: 0 };
    try {
      const res = await this.os.search<{
        hits: { total: { value: number } };
        aggregations: { errores: { doc_count: number }; p95: { values: Record<string, number | null> } };
      }>(config.opensearchMetricsIndex, {
        size: 0,
        track_total_hits: true,
        query: { range: { "@timestamp": { gte: "now/d" } } },
        aggs: {
          errores: { filter: { range: { proxyResponseCode: { gte: 500 } } } },
          p95: { percentiles: { field: "responseLatency", percents: [95] } },
        },
      });
      consumoHoy = {
        llamadas: res.hits.total.value,
        errores: res.aggregations.errores.doc_count,
        latenciaP95Ms: Math.round(Number(res.aggregations.p95.values["95.0"] ?? 0)),
      };
    } catch {
      /* sin analítica disponible */
    }
    const active = String(settings.active_site ?? "cpd");
    return {
      sites: sites.map((s) => {
        const checks = Object.values((s.checks ?? {}) as Record<string, string>);
        const stale = !s.last_seen || Date.now() - new Date(String(s.last_seen)).getTime() > 60_000;
        const status = stale ? "desconocido" : checks.every((c) => c === "ok") ? "ok" : checks.some((c) => c === "ok") ? "degradado" : "caido";
        return { id: s.id, name: s.name, status, active: s.id === active };
      }),
      apis: { ...apis, completitudPromedio: pct },
      alertas: alerts,
      consumoHoy,
      despliegues: rollouts,
    };
  }
}

// ------------------------------------------------------------------ auditoría

@Controller("audit-events")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission("audit:read")
  list(@Query("from") from?: string, @Query("to") to?: string, @Query("actor") actor?: string, @Query("action") action?: string, @Query("limit") limit?: string) {
    return this.audit.store.list({ from, to, actor, action, limit: limit ? Number(limit) : undefined });
  }

  @Get("verify")
  @RequirePermission("audit:verify")
  async verify(@CurrentUser() user: AuthUser) {
    const result = await this.audit.store.verify();
    await this.audit.record(user, "auditoria.verificar", "cadena", result.ok ? "exito" : "error", { ...result });
    return result;
  }
}

// ------------------------------------------------------------------ cumplimiento

@Controller("compliance")
export class ComplianceController {
  constructor(private readonly tls: TlsProbeService) {}

  @Get("role-matrix")
  @RequirePermission("compliance:read")
  roleMatrix() {
    return permissionMatrix();
  }

  @Get("tls-channels")
  @RequirePermission("compliance:read")
  tlsChannels() {
    return this.tls.matrix();
  }
}

// ------------------------------------------------------------------ exportación (BT-049, BT-060)

@Controller("exports")
export class ExportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WSO2) private readonly wso2: Wso2Client,
    @Inject(MI) private readonly mi: MiManagementClient,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  @RequirePermission("export:create")
  async create(@CurrentUser() user: AuthUser) {
    const job = (await this.db.query("INSERT INTO nexo.export_job (created_by) VALUES ($1) RETURNING *", [user.username])).rows[0];
    void this.run(String(job.id), user);
    return { id: job.id, status: job.status, createdAt: job.created_at };
  }

  /** Paquete con APIs (formato de proyecto WSO2, compatible con apictl), flujos MI, catálogo y grafo, más manifiesto con hashes. */
  private async run(id: string, user: AuthUser) {
    try {
      const files: Record<string, Uint8Array> = {};
      const items: Array<{ tipo: string; nombre: string; archivo: string; sha256: string }> = [];
      const add = (tipo: string, nombre: string, archivo: string, data: Uint8Array) => {
        files[archivo] = data;
        items.push({ tipo, nombre, archivo, sha256: createHash("sha256").update(data).digest("hex") });
      };
      for (const a of (await this.wso2.publisher.listApis(undefined, 500)).list) {
        add("api", `${a.name} ${a.version}`, `apis/${a.name}-${a.version}.zip`, new Uint8Array(await this.wso2.publisher.exportApi(a.id)));
      }
      for (const f of (await this.mi.apis().catch(() => ({ list: [] }))).list) {
        const d = await this.mi.api(f.name).catch(() => undefined);
        if (d?.configuration) add("flujo", f.name, `flujos/${f.name}.xml`, strToU8(d.configuration));
      }
      const catalog = (await this.db.query("SELECT * FROM nexo.api_asset ORDER BY name")).rows;
      add("metadatos", "catálogo de APIs", "metadatos/catalogo.json", strToU8(JSON.stringify(catalog, null, 2)));
      const nodes = (await this.db.query("SELECT * FROM nexo.graph_node")).rows;
      const edges = (await this.db.query("SELECT * FROM nexo.graph_edge")).rows;
      add("metadatos", "grafo de dependencias", "metadatos/grafo.json", strToU8(JSON.stringify({ nodes, edges }, null, 2)));
      const manifest = { version: config.version, generadoEn: new Date().toISOString(), origen: config.wso2.url, items };
      files["manifiesto.json"] = strToU8(JSON.stringify(manifest, null, 2));
      mkdirSync(config.exportDir, { recursive: true });
      const path = join(config.exportDir, `nexo-export-${id}.zip`);
      writeFileSync(path, zipSync(files));
      await this.db.query("UPDATE nexo.export_job SET status = 'listo', manifest = $1, file_path = $2 WHERE id = $3", [JSON.stringify(manifest), path, id]);
      await this.audit.record(user, "exportacion.generar", `export/${id}`, "exito", { items: items.length });
    } catch (e) {
      await this.db.query("UPDATE nexo.export_job SET status = 'fallido', error = $1 WHERE id = $2", [e instanceof Error ? e.message : String(e), id]);
      await this.audit.record(user, "exportacion.generar", `export/${id}`, "error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  @Get(":id")
  @RequirePermission("export:create")
  async get(@Param("id") id: string) {
    const j = (await this.db.query("SELECT * FROM nexo.export_job WHERE id = $1", [id])).rows[0];
    if (!j) throw new NotFoundException({ statusCode: 404, message: "La exportación no existe" });
    return {
      id: j.id,
      status: j.status,
      createdAt: j.created_at,
      manifest: j.manifest ?? undefined,
      downloadUrl: j.status === "listo" ? `/api/v1/exports/${j.id}/download` : undefined,
      error: j.error ?? undefined,
    };
  }

  @Get(":id/download")
  @RequirePermission("export:create")
  async download(@Param("id") id: string, @Res() res: Response) {
    const j = (await this.db.query("SELECT file_path FROM nexo.export_job WHERE id = $1 AND status = 'listo'", [id])).rows[0];
    if (!j) throw new NotFoundException({ statusCode: 404, message: "La exportación no está lista" });
    res.download(String(j.file_path), `nexo-export-${id}.zip`);
  }
}

// ------------------------------------------------------------------ alertas (webhook de Alertmanager)

@Controller("alerts")
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Post("alertmanager")
  @HttpCode(204)
  async alertmanager(@Body() body: { alerts?: Array<{ status: string; labels: Record<string, string>; annotations?: Record<string, string>; fingerprint?: string }> }, @ReqHeaders("authorization") auth?: string) {
    const expected = process.env.NEXO_ALERTS_TOKEN;
    if (expected && auth !== `Bearer ${expected}`) throw new UnauthorizedException();
    for (const a of body.alerts ?? []) {
      await this.db.query("INSERT INTO nexo.alert (status, name, severity, summary, labels, fingerprint) VALUES ($1,$2,$3,$4,$5,$6)", [
        a.status,
        a.labels.alertname ?? "alerta",
        a.labels.severidad ?? null,
        a.annotations?.resumen ?? null,
        JSON.stringify(a.labels),
        a.fingerprint ?? null,
      ]);
    }
  }
}

// ------------------------------------------------------------------ motores (latido y liderazgo)

@Controller("engines")
export class EnginesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Estado de cada motor: réplica líder, último latido y lo que reporta (p. ej. rezago del SIEM). */
  @Get()
  @RequirePermission("rollout:read")
  async list() {
    const rows = (await this.db.query("SELECT * FROM nexo.engine_heartbeat ORDER BY engine, leader DESC, last_seen DESC")).rows;
    return rows.map((r) => {
      const ageSec = (Date.now() - new Date(String(r.last_seen)).getTime()) / 1000;
      return {
        engine: r.engine,
        instance: r.instance,
        leader: r.leader,
        lastSeen: r.last_seen,
        status: ageSec > 60 ? "sin_latido" : String((r.info as Record<string, unknown>)?.estado ?? "activo"),
        info: r.info,
      };
    });
  }
}

// ------------------------------------------------------------------ salud y métricas

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get("health")
  async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", version: config.version, ambiente: config.environmentLabel };
  }

  @Public()
  @Get("metrics")
  @Header("content-type", register.contentType)
  metrics() {
    return register.metrics();
  }
}
