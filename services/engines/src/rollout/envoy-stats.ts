/**
 * Métricas por versión desde nexo-division (Envoy, formato Prometheus): llamadas completadas, respuestas 5xx,
 * fallas de conexión y el histograma de latencia de cada clúster (estable y candidato). Las compuertas usan
 * la diferencia entre el inicio del paso y ahora, sumando todas las réplicas de Envoy.
 */
export interface ClusterCounters {
  completed: number;
  errors5xx: number;
  connectFail: number;
  timeouts: number;
  /** Histograma acumulado de latencia: límite superior (ms) → cantidad acumulada. */
  buckets: Record<string, number>;
  /** Hosts resueltos del clúster (0 si Envoy todavía no lo tiene listo). */
  members: number;
}

export type StatsSnapshot = Record<string, ClusterCounters>;

const LINE = /^(envoy_cluster_[a-z_]+)\{([^}]*)\}\s+([0-9.eE+-]+|NaN)$/;

function labels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const empty = (): ClusterCounters => ({ completed: 0, errors5xx: 0, connectFail: 0, timeouts: 0, buckets: {}, members: 0 });

export function parseEnvoyStats(text: string, clusters: readonly string[]): StatsSnapshot {
  const wanted = new Set(clusters);
  const snap: StatsSnapshot = {};
  for (const c of clusters) snap[c] = empty();
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, metric, rawLabels, rawValue] = m;
    const l = labels(rawLabels!);
    const cluster = l.envoy_cluster_name;
    if (!cluster || !wanted.has(cluster)) continue;
    const v = Number(rawValue);
    if (!Number.isFinite(v)) continue;
    const c = snap[cluster]!;
    if (metric === "envoy_cluster_upstream_rq_completed") c.completed += v;
    else if (metric === "envoy_cluster_upstream_rq_xx" && l.envoy_response_code_class === "5") c.errors5xx += v;
    else if (metric === "envoy_cluster_upstream_cx_connect_fail") c.connectFail += v;
    else if (metric === "envoy_cluster_upstream_rq_timeout") c.timeouts += v;
    else if (metric === "envoy_cluster_upstream_rq_time_bucket" && l.le) c.buckets[l.le] = (c.buckets[l.le] ?? 0) + v;
    else if (metric === "envoy_cluster_membership_total") c.members += v;
  }
  return snap;
}

/** Suma instantáneas de varias réplicas de Envoy. */
export function mergeSnapshots(snaps: readonly StatsSnapshot[]): StatsSnapshot {
  const out: StatsSnapshot = {};
  for (const s of snaps) {
    for (const [name, c] of Object.entries(s)) {
      const o = (out[name] ??= empty());
      o.completed += c.completed;
      o.errors5xx += c.errors5xx;
      o.connectFail += c.connectFail;
      o.timeouts += c.timeouts;
      for (const [le, n] of Object.entries(c.buckets)) o.buckets[le] = (o.buckets[le] ?? 0) + n;
      o.members += c.members;
    }
  }
  return out;
}

/** El clúster está listo cuando todas las réplicas de Envoy lo tienen con al menos un host resuelto. */
export function clusterReady(snaps: readonly StatsSnapshot[], name: string): boolean {
  return snaps.length > 0 && snaps.every((s) => (s[name]?.members ?? 0) >= 1);
}

/** Diferencia entre dos instantáneas; si Envoy se reinició (contadores menores), se toma desde cero. */
export function delta(now: ClusterCounters | undefined, base: ClusterCounters | undefined): ClusterCounters {
  const n = now ?? empty();
  const b = base ?? empty();
  const reset = n.completed < b.completed;
  const sub = (x: number, y: number) => (reset ? x : Math.max(0, x - y));
  const buckets: Record<string, number> = {};
  for (const [le, v] of Object.entries(n.buckets)) buckets[le] = sub(v, b.buckets[le] ?? 0);
  return {
    completed: sub(n.completed, b.completed),
    errors5xx: sub(n.errors5xx, b.errors5xx),
    connectFail: sub(n.connectFail, b.connectFail),
    timeouts: sub(n.timeouts, b.timeouts),
    buckets,
    members: n.members,
  };
}

/** Percentil desde un histograma acumulado (como histogram_quantile de Prometheus). */
export function quantileMs(buckets: Record<string, number>, q: number): number | undefined {
  const entries = Object.entries(buckets)
    .map(([le, n]) => [le === "+Inf" ? Number.POSITIVE_INFINITY : Number(le), n] as const)
    .filter(([le]) => !Number.isNaN(le))
    .sort((a, b) => a[0] - b[0]);
  const total = entries.at(-1)?.[1] ?? 0;
  if (!total) return undefined;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of entries) {
    if (count >= rank) {
      if (!Number.isFinite(le)) return prevLe;
      const inBucket = count - prevCount;
      return inBucket > 0 ? prevLe + ((le - prevLe) * (rank - prevCount)) / inBucket : le;
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

/** Llamadas y errores de un clúster en el intervalo (las fallas de conexión y timeouts cuentan como error). */
export function toVersionMetrics(d: ClusterCounters) {
  const errors = d.errors5xx + d.connectFail + d.timeouts;
  return { requests: d.completed + d.connectFail, errors, p99Ms: quantileMs(d.buckets, 0.99) };
}
