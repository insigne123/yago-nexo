import { seededRandom } from "@nexo/shared/browser";
import type { UsageGroupBy, UsageRow } from "../api/types";
import { isoDate } from "../lib/format";
import type { MockState, UsageDaily } from "./types";

const DAY = 86_400_000;
const DAYS = 45;

const BYTES_PER_CALL: Record<string, number> = {
  "api-registro-operadores": 5200,
  "api-reclamos": 2400,
  "api-tramites": 3100,
  "api-estadisticas": 8800,
  "api-calidad": 7600,
};

const P95_BASE: Record<string, number> = {
  "api-registro-operadores": 640,
  "api-portabilidad": 420,
  "api-reclamos": 310,
  "api-tramites": 380,
  "api-espectro": 260,
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Consumo diario determinista de los últimos 45 días (valores de día completo). */
export function generateUsage(
  state: Pick<MockState, "subscriptions" | "endpoints">,
  now: number,
): UsageDaily[] {
  const random = seededRandom(20261004);
  const today = startOfDay(now);
  const rows: UsageDaily[] = [];
  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const date = new Date(today - offset * DAY);
    const day = isoDate(date);
    const weekday = date.getDay();
    const weekFactor = weekday === 0 || weekday === 6 ? 0.42 : 1;
    for (const sub of state.subscriptions) {
      const endpoints = state.endpoints[sub.apiId] ?? ["/"];
      endpoints.forEach((endpoint, index) => {
        const share = endpoints.length === 1 ? 1 : index === 0 ? 0.55 : 0.45 / (endpoints.length - 1);
        const calls = Math.round(sub.dailyBase * share * weekFactor * (0.78 + random() * 0.44));
        const errorRate = sub.errorRate * (0.5 + random() * 1.1);
        rows.push({
          day,
          consumerId: sub.consumerId,
          apiId: sub.apiId,
          endpoint,
          llamadas: calls,
          errores: Math.round(calls * errorRate),
          bytes: Math.round(calls * (BYTES_PER_CALL[sub.apiId] ?? 1800) * (0.85 + random() * 0.3)),
          p95: Math.round((P95_BASE[sub.apiId] ?? 220) * (0.85 + random() * 0.35)),
        });
      });
    }
  }
  return rows;
}

/** Fracción del día transcurrida (el consumo de hoy crece con el reloj). */
export function dayFraction(now: number): number {
  return Math.min(1, Math.max(0.02, (now - startOfDay(now)) / DAY));
}

export interface UsageQuery {
  from?: string;
  to?: string;
  groupBy: UsageGroupBy;
  /** Solo el consumo de este consumidor (permiso usage:read:own). */
  consumerId?: string;
}

export function scaledRows(
  rows: readonly UsageDaily[],
  now: number,
  query: Omit<UsageQuery, "groupBy">,
): UsageDaily[] {
  const today = isoDate(new Date(now));
  const fraction = dayFraction(now);
  return rows
    .filter((r) => (!query.from || r.day >= query.from) && (!query.to || r.day <= query.to) && r.day <= today)
    .filter((r) => !query.consumerId || r.consumerId === query.consumerId)
    .map((r) =>
      r.day === today
        ? {
            ...r,
            llamadas: Math.round(r.llamadas * fraction),
            errores: Math.round(r.errores * fraction),
            bytes: Math.round(r.bytes * fraction),
          }
        : r,
    );
}

export function aggregateUsage(
  rows: readonly UsageDaily[],
  groupBy: UsageGroupBy,
  labels: { consumer: (id: string) => { label: string; plan?: string }; api: (id: string) => string },
): UsageRow[] {
  const groups = new Map<string, { row: UsageRow; p95Weight: number }>();
  for (const r of rows) {
    const key =
      groupBy === "consumer"
        ? r.consumerId
        : groupBy === "api"
          ? r.apiId
          : groupBy === "endpoint"
            ? r.endpoint
            : r.day;
    let entry = groups.get(key);
    if (!entry) {
      const consumer = groupBy === "consumer" ? labels.consumer(r.consumerId) : undefined;
      const label = consumer?.label ?? (groupBy === "api" ? labels.api(r.apiId) : key);
      entry = {
        row: { key, label, llamadas: 0, errores: 0, bytes: 0, latenciaP95Ms: 0, plan: consumer?.plan },
        p95Weight: 0,
      };
      groups.set(key, entry);
    }
    entry.row.llamadas = (entry.row.llamadas ?? 0) + r.llamadas;
    entry.row.errores = (entry.row.errores ?? 0) + r.errores;
    entry.row.bytes = (entry.row.bytes ?? 0) + r.bytes;
    entry.p95Weight += r.p95 * r.llamadas;
  }
  return [...groups.values()].map(({ row, p95Weight }) => ({
    ...row,
    latenciaP95Ms: row.llamadas ? Math.round(p95Weight / row.llamadas) : 0,
  }));
}
