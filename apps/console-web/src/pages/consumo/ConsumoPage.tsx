import { Download, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { fetchUsageCsv, useUsage } from "../../api/queries";
import { describeError } from "../../api/errors";
import type { UsageGroupBy, UsageRow } from "../../api/types";
import { useSession } from "../../auth/session";
import { Chart } from "../../components/charts/Chart";
import {
  BAR_MAX_WIDTH,
  axisTooltip,
  barItemStyle,
  categoryAxis,
  chartGrid,
  legend,
  valueAxis,
} from "../../components/charts/options";
import { useVizPalette, type VizPalette } from "../../components/charts/palette";
import type { ChartOption } from "../../components/charts/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatTile } from "../../components/StatTile";
import { Card } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Input";
import { DataTable, type Column } from "../../components/ui/Table";
import { toast } from "../../components/ui/toast-store";
import { lastDays, shortDayLabel } from "../../lib/dates";
import { downloadCsv } from "../../lib/download";
import {
  fileTimestamp,
  formatBytes,
  formatCompact,
  formatMs,
  formatNumber,
  formatPercent,
} from "../../lib/format";

const GROUPS: Array<{ value: UsageGroupBy; label: string }> = [
  { value: "consumer", label: "Consumidor" },
  { value: "api", label: "API" },
  { value: "endpoint", label: "Endpoint" },
  { value: "day", label: "Día" },
];

const TOP = 12;

function chartOption(palette: VizPalette, rows: UsageRow[], groupBy: UsageGroupBy): ChartOption {
  const data =
    groupBy === "day"
      ? [...rows].sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""))
      : [...rows].sort((a, b) => (b.llamadas ?? 0) - (a.llamadas ?? 0)).slice(0, TOP);
  const labels = data.map((r) =>
    groupBy === "day" ? shortDayLabel(r.key ?? r.label ?? "") : (r.label ?? r.key ?? "—"),
  );
  const ok = data.map((r) => Math.max(0, (r.llamadas ?? 0) - (r.errores ?? 0)));
  const errors = data.map((r) => r.errores ?? 0);
  const horizontal = groupBy !== "day";
  const category = { ...categoryAxis(palette, labels), ...(horizontal ? { inverse: true } : {}) };
  const value = valueAxis(palette, (v) => formatCompact(v));
  return {
    animation: false,
    grid: chartGrid(32),
    legend: legend(palette),
    tooltip: {
      ...axisTooltip(palette),
      axisPointer: { type: "shadow" },
      valueFormatter: (v) => formatNumber(Number(v)),
    },
    xAxis: horizontal ? value : category,
    yAxis: horizontal
      ? { ...category, axisLabel: { ...category.axisLabel, width: 180, overflow: "truncate" } }
      : value,
    series: [
      {
        type: "bar",
        name: "Llamadas exitosas",
        stack: "total",
        data: ok,
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: { color: palette.series[0], borderColor: palette.surface, borderWidth: 1 },
      },
      {
        type: "bar",
        name: "Llamadas con error",
        stack: "total",
        data: errors,
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: {
          ...barItemStyle(palette.critical, horizontal),
          borderColor: palette.surface,
          borderWidth: 1,
        },
      },
    ],
  };
}

export default function ConsumoPage() {
  const session = useSession();
  const palette = useVizPalette();
  const initial = useMemo(() => lastDays(30), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("consumer");
  const [exporting, setExporting] = useState(false);
  const validRange = Boolean(from && to && from <= to);
  const usage = useUsage({ from, to, groupBy }, validRange);
  const rows = useMemo(() => usage.data ?? [], [usage.data]);
  const option = useMemo(() => chartOption(palette, rows, groupBy), [palette, rows, groupBy]);
  const ownOnly = !session.can("usage:read:all");

  const totals = rows.reduce<{ llamadas: number; errores: number; bytes: number }>(
    (acc, r) => ({
      llamadas: acc.llamadas + (r.llamadas ?? 0),
      errores: acc.errores + (r.errores ?? 0),
      bytes: acc.bytes + (r.bytes ?? 0),
    }),
    { llamadas: 0, errores: 0, bytes: 0 },
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await fetchUsageCsv(from, to);
      downloadCsv(`consumo-${from}-a-${to}-${fileTimestamp()}.csv`, csv);
    } catch (error) {
      const { title, description } = describeError(error);
      toast.error(title, description);
    } finally {
      setExporting(false);
    }
  };

  const groupLabel = GROUPS.find((g) => g.value === groupBy)?.label ?? "Grupo";
  const columns: Column<UsageRow>[] = [
    {
      id: "label",
      header: groupLabel,
      sortValue: (r) => (groupBy === "day" ? r.key : r.label),
      cell: (r) =>
        groupBy === "endpoint" ? (
          <code className="font-mono text-xs break-all">{r.label ?? r.key}</code>
        ) : groupBy === "day" ? (
          (r.key ?? r.label)
        ) : (
          (r.label ?? r.key)
        ),
    },
    ...(groupBy === "consumer"
      ? [
          {
            id: "plan",
            header: "Plan (sin cobro)",
            sortValue: (r: UsageRow) => r.plan,
            cell: (r: UsageRow) => r.plan ?? "—",
          },
        ]
      : []),
    {
      id: "calls",
      header: "Llamadas",
      align: "right",
      sortValue: (r) => r.llamadas,
      cell: (r) => <span className="tabular">{formatNumber(r.llamadas)}</span>,
    },
    {
      id: "errors",
      header: "Errores",
      align: "right",
      sortValue: (r) => r.errores,
      cell: (r) => <span className="tabular">{formatNumber(r.errores)}</span>,
    },
    {
      id: "rate",
      header: "% de error",
      align: "right",
      sortValue: (r) => (r.llamadas ? (r.errores ?? 0) / r.llamadas : 0),
      cell: (r) => (
        <span className="tabular">{formatPercent(r.llamadas ? (r.errores ?? 0) / r.llamadas : null, 2)}</span>
      ),
    },
    {
      id: "bytes",
      header: "Datos",
      align: "right",
      sortValue: (r) => r.bytes,
      cell: (r) => <span className="tabular">{formatBytes(r.bytes)}</span>,
    },
    {
      id: "p95",
      header: "Latencia p95",
      align: "right",
      sortValue: (r) => r.latenciaP95Ms,
      cell: (r) => <span className="tabular">{formatMs(r.latenciaP95Ms)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Consumo"
        reference="BT-021"
        description="Llamadas atribuidas por consumidor, API, endpoint y día, a partir de la analítica del gateway. Los planes se asocian a cada consumidor solo como referencia."
        actions={
          <GuardedButton
            anyOf={["usage:read:all", "usage:read:own"]}
            icon={<Download className="size-4" aria-hidden="true" />}
            loading={exporting}
            disabled={!validRange}
            onClick={() => void exportCsv()}
            data-testid="btn-export-usage"
          >
            Exportar CSV
          </GuardedButton>
        }
      />

      <div
        role="note"
        className="mb-4 flex items-start gap-3 rounded-lg border border-accent/30 bg-accent-soft p-4 text-sm text-fg"
        data-testid="billing-disabled-notice"
      >
        <Info className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden="true" />
        <div>
          <p className="font-semibold">Medición sin facturación: los cobros están desactivados</p>
          <p className="mt-0.5 text-fg-muted">
            La monetización de WSO2 está apagada. Estos datos sirven para atribuir el uso y planificar
            capacidad.
            {ownOnly ? " Su rol solo ve el consumo de su propia organización." : ""}
          </p>
        </div>
      </div>

      <form
        className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4"
        aria-label="Filtros de consumo"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field
          id="consumo-desde"
          label="Desde"
          className="w-44"
          error={!validRange ? "Rango no válido" : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="usage-from"
            />
          )}
        </Field>
        <Field id="consumo-hasta" label="Hasta" className="w-44">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              data-testid="usage-to"
            />
          )}
        </Field>
        <Field id="consumo-agrupar" label="Agrupar por" className="w-48">
          {(control) => (
            <Select
              {...control}
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as UsageGroupBy)}
              data-testid="usage-group-by"
            >
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>

      {usage.isError ? (
        <QueryError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <section aria-label="Totales del período" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Llamadas"
              loading={usage.isLoading}
              value={formatCompact(totals.llamadas)}
              detail={formatNumber(totals.llamadas)}
            />
            <StatTile
              label="Errores"
              loading={usage.isLoading}
              value={formatCompact(totals.errores)}
              detail={formatNumber(totals.errores)}
            />
            <StatTile
              label="Tasa de error"
              loading={usage.isLoading}
              value={formatPercent(totals.llamadas ? totals.errores / totals.llamadas : null, 2)}
            />
            <StatTile
              label="Datos transferidos"
              loading={usage.isLoading}
              value={formatBytes(totals.bytes)}
            />
          </section>
          <Card
            title={
              groupBy === "day"
                ? "Llamadas por día"
                : `Llamadas por ${groupLabel.toLowerCase()} (${Math.min(TOP, rows.length)} principales)`
            }
            description="Barras apiladas: llamadas exitosas y con error. La tabla muestra todos los valores."
            className="mb-4"
          >
            <div className={usage.isFetching ? "opacity-60 transition-opacity" : undefined}>
              <Chart
                option={option}
                label={`Gráfico de barras: ${formatNumber(totals.llamadas)} llamadas entre ${from} y ${to}.`}
                height={groupBy === "day" ? 260 : Math.max(220, Math.min(TOP, rows.length) * 30 + 60)}
                testId="chart-usage"
              />
            </div>
          </Card>
          <DataTable
            key={groupBy}
            rows={rows}
            columns={columns}
            rowKey={(r) => r.key ?? r.label ?? ""}
            caption={`Consumo agrupado por ${groupLabel.toLowerCase()}`}
            loading={usage.isLoading}
            testId="table-usage"
            initialSort={
              groupBy === "day" ? { id: "label", direction: "asc" } : { id: "calls", direction: "desc" }
            }
            emptyTitle="Sin consumo en el período"
          />
        </>
      )}
    </>
  );
}
