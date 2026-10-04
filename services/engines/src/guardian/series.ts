import type { Metric, WindowSample } from "./detect.js";

/**
 * Consulta de OpenSearch para el guardián: por consumidor (id de aplicación de WSO2), un histograma de
 * ventanas fijas alineadas al reloj con la métrica de la regla. La última ventana es la que se evalúa.
 */
export interface ConsumerSeries {
  applicationId: string;
  name: string;
  owner: string;
  /** IP con más llamadas en la ventana actual. */
  topIp?: string;
  windows: WindowSample[];
}

export function buildQuery(metric: Metric, fromMs: number, toMs: number, windowSec: number, filter: { apiId?: string | null; consumerId?: string | null }) {
  const filters: unknown[] = [{ range: { "@timestamp": { gte: fromMs, lt: toMs, format: "epoch_millis" } } }];
  if (filter.apiId) filters.push({ term: { "apiId.keyword": filter.apiId } });
  if (filter.consumerId) filters.push({ term: { "applicationId.keyword": filter.consumerId } });
  const specific: Record<string, unknown> =
    metric === "latencia"
      ? { p95: { percentiles: { field: "responseLatency", percents: [95] } } }
      : metric === "tamano"
        ? { bytes: { sum: { field: "properties.responseSize" } } }
        : metric === "ips_distintas"
          ? { ips: { cardinality: { field: "userIp.keyword" } } }
          : {};
  return {
    size: 0,
    query: { bool: { filter: filters, must_not: [{ term: { "applicationName.keyword": "UNKNOWN" } }] } },
    aggs: {
      consumidores: {
        terms: { field: "applicationId.keyword", size: 500 },
        aggs: {
          nombre: { terms: { field: "applicationName.keyword", size: 1 } },
          dueno: { terms: { field: "applicationOwner.keyword", size: 1 } },
          ip: { filter: { range: { "@timestamp": { gte: toMs - windowSec * 1000, lt: toMs, format: "epoch_millis" } } }, aggs: { top: { terms: { field: "userIp.keyword", size: 1 } } } },
          ventanas: {
            date_histogram: { field: "@timestamp", fixed_interval: `${windowSec}s`, min_doc_count: 0, extended_bounds: { min: fromMs, max: toMs - 1 } },
            aggs: { errores: { filter: { range: { proxyResponseCode: { gte: 400 } } } }, ...specific },
          },
        },
      },
    },
  };
}

interface Bucket {
  key: number;
  doc_count: number;
  errores?: { doc_count: number };
  p95?: { values: Record<string, number | null> };
  bytes?: { value: number | null };
  ips?: { value: number };
}

export interface SeriesResponse {
  aggregations?: {
    consumidores?: {
      buckets: Array<{
        key: string;
        nombre?: { buckets: Array<{ key: string }> };
        dueno?: { buckets: Array<{ key: string }> };
        ip?: { top?: { buckets: Array<{ key: string }> } };
        ventanas?: { buckets: Bucket[] };
      }>;
    };
  };
}

function valueOf(metric: Metric, b: Bucket | undefined): WindowSample {
  if (!b || b.doc_count === 0) return { value: 0, calls: 0, errors: 0 };
  const errors = b.errores?.doc_count ?? 0;
  const value =
    metric === "errores"
      ? errors / b.doc_count
      : metric === "latencia"
        ? Number(b.p95?.values["95.0"] ?? 0)
        : metric === "tamano"
          ? Number(b.bytes?.value ?? 0)
          : metric === "ips_distintas"
            ? Number(b.ips?.value ?? 0)
            : b.doc_count;
  return { value, calls: b.doc_count, errors };
}

/** Series completas (ventanas sin llamadas incluidas como cero), de la más antigua a la actual. */
export function parseSeries(metric: Metric, res: SeriesResponse, fromMs: number, toMs: number, windowSec: number): ConsumerSeries[] {
  const step = windowSec * 1000;
  const out: ConsumerSeries[] = [];
  for (const c of res.aggregations?.consumidores?.buckets ?? []) {
    const byKey = new Map((c.ventanas?.buckets ?? []).map((b) => [b.key, b]));
    const windows: WindowSample[] = [];
    for (let t = fromMs; t < toMs; t += step) windows.push(valueOf(metric, byKey.get(t)));
    out.push({
      applicationId: c.key,
      name: c.nombre?.buckets[0]?.key ?? c.key,
      owner: c.dueno?.buckets[0]?.key ?? "admin",
      topIp: c.ip?.top?.buckets[0]?.key,
      windows,
    });
  }
  return out;
}
