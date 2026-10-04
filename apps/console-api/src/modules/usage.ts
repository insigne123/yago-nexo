import { Controller, Get, Header, Inject, Injectable, Query } from "@nestjs/common";
import type { Db } from "@nexo/console-db";
import { CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { DB } from "../common/tokens.js";
import { config } from "../config.js";
import { OpenSearchService } from "../integrations/integrations.js";

/**
 * Medición de consumo sin cobro (BT-021): llamadas, errores, bytes y latencia atribuidos al consumidor,
 * la API y el endpoint, a partir de la analítica del gateway en OpenSearch. La facturación está apagada.
 */
interface Bucket {
  key: string | number;
  key_as_string?: string;
  doc_count: number;
  errores?: { doc_count: number };
  p95?: { values: Record<string, number | null> };
  bytes?: { value: number | null };
}

const FIELD: Record<string, string> = {
  // El id de aplicación es único; el nombre puede repetirse entre dueños distintos.
  consumer: "applicationId.keyword",
  api: "apiName.keyword",
  endpoint: "apiResourceTemplate.keyword",
};

@Injectable()
export class UsageService {
  constructor(
    private readonly os: OpenSearchService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async query(from: string, to: string, groupBy: string, onlyConsumers?: string[]) {
    const filters: unknown[] = [{ range: { "@timestamp": { gte: from, lte: to } } }];
    if (onlyConsumers) filters.push({ terms: { "applicationId.keyword": onlyConsumers } });
    const aggs = {
      errores: { filter: { range: { proxyResponseCode: { gte: 500 } } } },
      p95: { percentiles: { field: "responseLatency", percents: [95] } },
      bytes: { sum: { field: "properties.responseSize" } },
    };
    const group =
      groupBy === "day"
        ? { date_histogram: { field: "@timestamp", calendar_interval: "day", min_doc_count: 0 }, aggs }
        : { terms: { field: FIELD[groupBy] ?? FIELD.consumer, size: 200 }, aggs };
    const res = await this.os.search<{ aggregations?: { grupos?: { buckets: Bucket[] } } }>(config.opensearchMetricsIndex, {
      size: 0,
      query: { bool: { filter: filters, must_not: [{ term: { "applicationName.keyword": "UNKNOWN" } }] } },
      aggs: { grupos: group },
    });
    const buckets = res.aggregations?.grupos?.buckets ?? [];
    const names = new Map<string, string>();
    if (groupBy === "consumer" || !(groupBy in FIELD)) {
      const rows = await this.db.query("SELECT id, name FROM nexo.consumer WHERE id = ANY($1)", [buckets.map((b) => String(b.key))]);
      for (const r of rows.rows) names.set(String(r.id), String(r.name));
    }
    return buckets.map((b) => ({
      key: String(b.key_as_string ?? b.key),
      label: names.get(String(b.key)) ?? String(b.key_as_string ?? b.key),
      llamadas: b.doc_count,
      errores: b.errores?.doc_count ?? 0,
      bytes: Math.round(b.bytes?.value ?? 0),
      latenciaP95Ms: Math.round(Number(b.p95?.values?.["95.0"] ?? 0)),
      plan: "sin cobro",
    }));
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** Celda CSV segura: comillas escapadas y sin fórmulas (inyección en planillas). */
const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

@Controller("usage")
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    @Inject(DB) private readonly db: Db,
  ) {}

  private range(from?: string, to?: string) {
    const f = from ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    return { from: `${f}T00:00:00.000Z`, to: `${to ?? today()}T23:59:59.999Z` };
  }

  /** Un consumidor solo ve su propio consumo (usage:read:own); los demás roles ven todo. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") groupBy = "consumer") {
    const r = this.range(from, to);
    if (user.permissions.includes("usage:read:all")) return this.usage.query(r.from, r.to, groupBy);
    if (user.permissions.includes("usage:read:own")) {
      // Las aplicaciones del consumidor son las que creó en el portal (dueño = su usuario) o las que lo tienen de contacto.
      const ids = [user.username, user.email].filter((v): v is string => !!v);
      const own = await this.db.query("SELECT id FROM nexo.consumer WHERE contact = ANY($1) OR organization = ANY($1)", [ids]);
      if (!own.rows.length) return [];
      return this.usage.query(r.from, r.to, groupBy, own.rows.map((x) => String(x.id)));
    }
    return [];
  }

  @Get("export")
  @RequirePermission("usage:read:all")
  @Header("content-type", "text/csv; charset=utf-8")
  @Header("content-disposition", 'attachment; filename="consumo-nexo.csv"')
  async export(@Query("from") from?: string, @Query("to") to?: string) {
    const r = this.range(from, to);
    const rows = await this.usage.query(r.from, r.to, "consumer");
    const byEndpoint = await this.usage.query(r.from, r.to, "endpoint");
    const lines = ["tipo,clave,llamadas,errores,bytes,latencia_p95_ms,plan"];
    for (const x of rows) lines.push(`consumidor,${cell(x.label)},${x.llamadas},${x.errores},${x.bytes},${x.latenciaP95Ms},${x.plan}`);
    for (const x of byEndpoint) lines.push(`endpoint,${cell(x.key)},${x.llamadas},${x.errores},${x.bytes},${x.latenciaP95Ms},${x.plan}`);
    return lines.join("\n");
  }
}
