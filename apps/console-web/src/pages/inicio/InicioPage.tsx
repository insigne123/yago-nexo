import {
  Activity,
  Gauge,
  Library,
  Radar,
  Rocket,
  ServerCog,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import {
  useAnomalies,
  useFailoverEvents,
  useOverview,
  useRollouts,
  useScans,
  useUsage,
} from "../../api/queries";
import type { SiteSummary, UsageRow } from "../../api/types";
import { useSession } from "../../auth/session";
import {
  BAR_MAX_WIDTH,
  axisTooltip,
  barItemStyle,
  categoryAxis,
  chartGrid,
  valueAxis,
} from "../../components/charts/options";
import { Chart } from "../../components/charts/Chart";
import { useVizPalette, type VizPalette } from "../../components/charts/palette";
import type { ChartOption } from "../../components/charts/types";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatTile } from "../../components/StatTile";
import { StatusBadge, statusLabel } from "../../components/StatusBadge";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Meter } from "../../components/ui/Meter";
import { Skeleton } from "../../components/ui/Skeleton";
import { useRuntime } from "../../config/RuntimeContext";
import { eachDay, lastDays, shortDayLabel } from "../../lib/dates";
import {
  formatCompact,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatRelative,
  plural,
} from "../../lib/format";
import { FAILOVER_KIND_LABELS, METRIC_LABELS, labelOf } from "../../lib/labels";
import { useNow } from "../../lib/useNow";

function SiteCard({ site }: { site: SiteSummary }) {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface p-4"
      data-testid={`site-card-${site.id}`}
    >
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{site.id}</p>
        <p className="mt-0.5 truncate text-sm font-semibold text-fg">{site.name}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <StatusBadge kind="site" status={site.status} testId={`site-status-${site.id}`} />
          {site.active && (
            <Badge tone="accent" data-testid={`site-active-${site.id}`}>
              Sitio activo
            </Badge>
          )}
        </div>
      </div>
      <ServerCog className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
    </div>
  );
}

interface DailyPoint {
  day: string;
  llamadas: number;
  errores: number;
}

function dailySeries(rows: UsageRow[] | undefined, from: string, to: string): DailyPoint[] {
  const byDay = new Map<string, UsageRow>();
  for (const row of rows ?? []) {
    const day = row.key ?? row.label;
    if (day) byDay.set(day, row);
  }
  return eachDay(from, to).map((day) => ({
    day,
    llamadas: byDay.get(day)?.llamadas ?? 0,
    errores: byDay.get(day)?.errores ?? 0,
  }));
}

function columnOption(
  palette: VizPalette,
  points: DailyPoint[],
  metric: "llamadas" | "errores",
): ChartOption {
  const color = metric === "llamadas" ? palette.series[0] : palette.critical;
  return {
    animation: false,
    grid: chartGrid(16),
    tooltip: {
      ...axisTooltip(palette),
      valueFormatter: (value) => formatNumber(Number(value)),
    },
    xAxis: categoryAxis(
      palette,
      points.map((p) => shortDayLabel(p.day)),
    ),
    yAxis: valueAxis(palette, (v) => formatCompact(v)),
    series: [
      {
        type: "bar",
        name: metric === "llamadas" ? "Llamadas" : "Errores",
        data: points.map((p) => p[metric]),
        itemStyle: barItemStyle(color),
        barMaxWidth: BAR_MAX_WIDTH,
        emphasis: { itemStyle: { opacity: 0.85 } },
      },
    ],
  };
}

interface FeedItem {
  id: string;
  ts: string;
  icon: LucideIcon;
  text: string;
  to: string;
  tone: "neutral" | "warn" | "bad" | "ok" | "accent";
}

function useRecentEvents(): { items: FeedItem[]; loading: boolean } {
  const session = useSession();
  const anomalies = useAnomalies(undefined, session.can("anomaly:read"));
  const rollouts = useRollouts(session.can("rollout:read"));
  const failovers = useFailoverEvents(session.can("continuity:read"));
  const scans = useScans(session.can("discovery:read"));

  const items = useMemo(() => {
    const feed: FeedItem[] = [];
    for (const a of anomalies.data ?? []) {
      feed.push({
        id: `anomalia-${a.id}`,
        ts: a.ts,
        icon: ShieldAlert,
        text: `Anomalía de ${labelOf(METRIC_LABELS, a.metric).toLowerCase()} en ${a.apiName ?? "una API"}${a.consumer ? ` (${a.consumer})` : ""}`,
        to: "/anomalias",
        tone: a.status === "bloqueada" || a.status === "bloqueo_propuesto" ? "bad" : "warn",
      });
    }
    for (const r of rollouts.data ?? []) {
      if (!r.createdAt) continue;
      feed.push({
        id: `despliegue-${r.id}`,
        ts: r.stepsDone?.at(-1)?.startedAt ?? r.createdAt,
        icon: Rocket,
        text: `Despliegue ${r.strategy === "canary" ? "canary" : "blue-green"} de ${r.apiName ?? r.apiId}: ${statusLabel("rollout", r.status).toLowerCase()}`,
        to: `/despliegues/${r.id}`,
        tone: r.status === "revertido" ? "bad" : r.status === "completado" ? "ok" : "accent",
      });
    }
    for (const f of failovers.data ?? []) {
      if (!f.startedAt) continue;
      feed.push({
        id: `continuidad-${f.id ?? f.startedAt}`,
        ts: f.startedAt,
        icon: ServerCog,
        text: `${labelOf(FAILOVER_KIND_LABELS, f.kind)} ${f.from ?? ""} → ${f.to ?? ""}`,
        to: "/continuidad",
        tone: f.status === "fallido" ? "bad" : "neutral",
      });
    }
    for (const s of scans.data ?? []) {
      feed.push({
        id: `escaneo-${s.id}`,
        ts: s.finishedAt ?? s.startedAt,
        icon: Radar,
        text: `Escaneo de descubrimiento ${s.status === "en_curso" ? "en curso" : "terminado"}${s.totals?.noGobernados ? `: ${s.totals.noGobernados} endpoints no gobernados` : ""}`,
        to: "/descubrimiento",
        tone: (s.totals?.riesgoAlto ?? 0) > 0 ? "warn" : "neutral",
      });
    }
    return feed.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
  }, [anomalies.data, rollouts.data, failovers.data, scans.data]);

  return { items, loading: anomalies.isLoading || rollouts.isLoading };
}

const TONE_CLASS: Record<FeedItem["tone"], string> = {
  neutral: "text-fg-subtle",
  warn: "text-warn",
  bad: "text-bad",
  ok: "text-ok",
  accent: "text-accent",
};

export default function InicioPage() {
  const { config } = useRuntime();
  const session = useSession();
  const palette = useVizPalette();
  const overview = useOverview();
  const range = useMemo(() => lastDays(7), []);
  const canUsage = session.canAny(["usage:read:all", "usage:read:own"]);
  const usage = useUsage({ groupBy: "day", from: range.from, to: range.to }, canUsage);
  const recent = useRecentEvents();
  const now = useNow();

  const points = useMemo(() => dailySeries(usage.data, range.from, range.to), [usage.data, range]);
  const callsOption = useMemo(() => columnOption(palette, points, "llamadas"), [palette, points]);
  const errorsOption = useMemo(() => columnOption(palette, points, "errores"), [palette, points]);

  const o = overview.data;
  const llamadas = o?.consumoHoy?.llamadas;
  const errores = o?.consumoHoy?.errores;
  const totalCalls = points.reduce((sum, p) => sum + p.llamadas, 0);

  return (
    <>
      <PageHeader
        title="Inicio"
        description={`Estado general de la plataforma en ${config.environmentLabel}: salud de los sitios, catálogo, alertas y consumo.`}
      />

      {overview.isError ? (
        <QueryError error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <>
          <section aria-labelledby="titulo-sitios" className="mb-6">
            <h2 id="titulo-sitios" className="mb-2 text-sm font-semibold text-fg">
              Salud por sitio
            </h2>
            <div className="grid gap-3 sm:grid-cols-3" data-testid="site-health">
              {overview.isLoading
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24" />)
                : (o?.sites ?? []).map((site) => <SiteCard key={site.id} site={site} />)}
            </div>
          </section>

          <section
            aria-label="Indicadores"
            className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
            data-testid="kpis"
          >
            <StatTile
              label="APIs en el catálogo"
              icon={<Library className="size-4" />}
              loading={overview.isLoading}
              value={formatNumber(o?.apis?.total)}
              detail={`${plural(o?.apis?.publicadas, "publicada", "publicadas")} · ${plural(o?.apis?.deprecadas, "deprecada", "deprecadas")}`}
              testId="kpi-apis"
            />
            <StatTile
              label="Completitud promedio"
              icon={<Activity className="size-4" />}
              loading={overview.isLoading}
              value={`${formatNumber(o?.apis?.completitudPromedio)} %`}
              detail={
                <Meter
                  value={o?.apis?.completitudPromedio ?? 0}
                  label="Completitud promedio del catálogo"
                  showValue={false}
                  tone="auto"
                />
              }
              testId="kpi-completitud"
            />
            <StatTile
              label="Alertas abiertas"
              icon={<TriangleAlert className="size-4" />}
              loading={overview.isLoading}
              value={formatNumber(o?.alertas?.abiertas)}
              detail={`${plural(o?.alertas?.anomalias, "anomalía", "anomalías")} · ${plural(o?.alertas?.hallazgos, "hallazgo", "hallazgos")} · ${plural(o?.alertas?.mensajesFallidos, "mensaje fallido", "mensajes fallidos")}`}
              testId="kpi-alertas"
            />
            <StatTile
              label="Consumo de hoy"
              icon={<Activity className="size-4" />}
              loading={overview.isLoading}
              value={formatCompact(llamadas)}
              detail={`${plural(errores, "error", "errores")} (${formatPercent(llamadas ? (errores ?? 0) / llamadas : null, 2)})`}
              testId="kpi-consumo"
            />
            <StatTile
              label="Latencia p95 de hoy"
              icon={<Gauge className="size-4" />}
              loading={overview.isLoading}
              value={formatMs(o?.consumoHoy?.latenciaP95Ms)}
              detail={`${plural(o?.despliegues?.enCurso, "despliegue en curso", "despliegues en curso")} · ${plural(o?.despliegues?.revertidos7d, "revertido", "revertidos")} en 7 días`}
              testId="kpi-p95"
            />
          </section>
        </>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card
          title="Llamadas por día"
          description="Últimos 7 días, todas las APIs. Fuente: consumo atribuido (BT-021)."
        >
          {!canUsage ? (
            <EmptyState compact title="Sin permiso para ver el consumo" />
          ) : usage.isError ? (
            <QueryError compact error={usage.error} />
          ) : (
            <>
              <Chart
                option={callsOption}
                label={`Gráfico de columnas: ${formatNumber(totalCalls)} llamadas en los últimos 7 días.`}
                height={200}
                testId="chart-calls"
              />
              <DataDetails points={points} />
            </>
          )}
        </Card>
        <Card title="Errores por día" description="Respuestas con error (4xx y 5xx) en los últimos 7 días.">
          {!canUsage ? (
            <EmptyState compact title="Sin permiso para ver el consumo" />
          ) : usage.isError ? (
            <QueryError compact error={usage.error} />
          ) : (
            <Chart
              option={errorsOption}
              label={`Gráfico de columnas: ${formatNumber(points.reduce((s, p) => s + p.errores, 0))} errores en los últimos 7 días.`}
              height={200}
              testId="chart-errors"
            />
          )}
        </Card>
      </div>

      <Card
        title="Eventos recientes"
        description="Anomalías, despliegues, conmutaciones y escaneos según sus permisos."
      >
        {recent.loading && recent.items.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
          </div>
        ) : recent.items.length === 0 ? (
          <EmptyState compact title="Sin eventos recientes visibles para su rol" />
        ) : (
          <ul className="divide-y divide-line" data-testid="recent-events">
            {recent.items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.id} className="flex items-start gap-3 py-2.5">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[item.tone]}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <Link to={item.to} className="text-sm text-fg hover:text-accent hover:underline">
                      {item.text}
                    </Link>
                    <p className="text-xs text-fg-muted">
                      <time dateTime={item.ts} title={formatDateTime(item.ts)}>
                        {formatRelative(item.ts, now)}
                      </time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function DataDetails({ points }: { points: DailyPoint[] }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg">Ver datos en tabla</summary>
      <table className="mt-2 w-full text-left text-xs">
        <caption className="sr-only">Llamadas y errores por día</caption>
        <thead className="text-fg-muted">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Día
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Llamadas
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Errores
            </th>
          </tr>
        </thead>
        <tbody className="tabular">
          {points.map((p) => (
            <tr key={p.day} className="border-t border-line">
              <td className="py-1">{shortDayLabel(p.day)}</td>
              <td className="py-1 text-right">{formatNumber(p.llamadas)}</td>
              <td className="py-1 text-right">{formatNumber(p.errores)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
