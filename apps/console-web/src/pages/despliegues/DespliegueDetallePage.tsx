import { ArrowLeft, CircleCheck, Clock, OctagonX, RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  keys,
  useAbortRollout,
  useApproveRollout,
  useRefreshWhenFinished,
  useRollout,
} from "../../api/queries";
import type { Rollout, RolloutStep } from "../../api/types";
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
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { ReasonDialog } from "../../components/ReasonDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { Card } from "../../components/ui/Card";
import { Meter } from "../../components/ui/Meter";
import { Skeleton } from "../../components/ui/Skeleton";
import { DataTable, type Column } from "../../components/ui/Table";
import { formatDateTime, formatMs, formatNumber, formatPercent, formatTime } from "../../lib/format";
import { ENVIRONMENT_LABELS, STRATEGY_LABELS, labelOf } from "../../lib/labels";
import { useNow } from "../../lib/useNow";

const stepName = (step: RolloutStep, index: number) => `Paso ${index + 1} · ${step.weight ?? 0} %`;

function weightOption(palette: VizPalette, rollout: Rollout, now: number): ChartOption {
  const points: Array<[number, number]> = [];
  const steps = rollout.stepsDone ?? [];
  for (const step of steps) {
    if (step.startedAt) points.push([Date.parse(step.startedAt), step.weight ?? 0]);
  }
  const last = steps.at(-1);
  if (rollout.status === "en_curso") points.push([now, rollout.currentWeight]);
  else if (last?.endedAt) points.push([Date.parse(last.endedAt), rollout.currentWeight]);
  return {
    animation: false,
    grid: chartGrid(16),
    tooltip: { ...axisTooltip(palette), valueFormatter: (v) => `${formatNumber(Number(v))} %` },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: palette.axis } },
      axisLabel: {
        color: palette.label,
        fontSize: 11,
        formatter: (v: number) => formatTime(v),
        hideOverlap: true,
      },
      splitLine: { show: false },
    },
    yAxis: { ...valueAxis(palette, (v) => `${v} %`), min: 0, max: 100 },
    series: [
      {
        type: "line",
        name: "Peso de la versión nueva",
        step: "end",
        data: points,
        showSymbol: true,
        symbolSize: 8,
        lineStyle: { width: 2, color: palette.series[0] },
        itemStyle: { color: palette.series[0], borderColor: palette.surface, borderWidth: 2 },
        areaStyle: { color: palette.series[0], opacity: 0.1 },
      },
    ],
  };
}

function metricOption(
  palette: VizPalette,
  steps: RolloutStep[],
  metric: "errorRate" | "p99Ms",
  threshold: number | undefined,
): ChartOption {
  const format = metric === "errorRate" ? (v: number) => formatPercent(v, 1) : (v: number) => formatMs(v);
  return {
    animation: false,
    grid: chartGrid(16),
    tooltip: { ...axisTooltip(palette), trigger: "axis", valueFormatter: (v) => format(Number(v)) },
    xAxis: categoryAxis(palette, steps.map(stepName)),
    yAxis: {
      ...valueAxis(palette, format),
      min: 0,
      // El umbral siempre queda dentro del eje, aunque todos los pasos estén muy por debajo.
      ...(threshold === undefined
        ? {}
        : { max: (extent: { max: number }) => Math.max(extent.max, threshold) * 1.15 }),
    },
    series: [
      {
        type: "bar",
        name: metric === "errorRate" ? "Tasa de errores" : "Latencia p99",
        barMaxWidth: BAR_MAX_WIDTH,
        data: steps.map((s) => {
          const value = s[metric] ?? 0;
          const over = threshold !== undefined && value > threshold;
          const color = over
            ? palette.critical
            : s.decision === "pendiente"
              ? palette.axis
              : palette.series[0];
          return { value, itemStyle: barItemStyle(color) };
        }),
        markLine:
          threshold === undefined
            ? undefined
            : {
                symbol: "none",
                silent: true,
                lineStyle: { color: palette.critical, width: 1, type: "solid" },
                label: {
                  formatter: `Umbral ${format(threshold)}`,
                  color: palette.label,
                  fontSize: 11,
                  position: "insideEndTop",
                },
                data: [{ yAxis: threshold }],
              },
      },
    ],
  };
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children}</dd>
    </div>
  );
}

export default function DespliegueDetallePage() {
  const { id = "" } = useParams();
  const rollout = useRollout(id);
  const approve = useApproveRollout();
  const abort = useAbortRollout();
  const session = useSession();
  const palette = useVizPalette();
  const now = useNow();
  const [aborting, setAborting] = useState(false);

  const data = rollout.data;
  const live = data?.status === "en_curso";
  useRefreshWhenFinished(live, keys.rollouts, keys.overview);
  const steps = useMemo(() => data?.stepsDone ?? [], [data]);
  // El reloj solo importa mientras el despliegue avanza (extiende la línea hasta "ahora").
  const tick = live ? now : 0;
  const weightChart = useMemo(() => (data ? weightOption(palette, data, tick) : null), [palette, data, tick]);
  const errorChart = useMemo(
    () => metricOption(palette, steps, "errorRate", data?.thresholds?.maxErrorRate),
    [palette, steps, data?.thresholds?.maxErrorRate],
  );
  const p99Chart = useMemo(
    () => metricOption(palette, steps, "p99Ms", data?.thresholds?.maxP99Ms),
    [palette, steps, data?.thresholds?.maxP99Ms],
  );

  const breadcrumb = (
    <Link to="/despliegues" className="inline-flex items-center gap-1 hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden="true" />
      Despliegues
    </Link>
  );

  if (rollout.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (rollout.isError || !data) {
    return (
      <>
        <PageHeader title="Despliegue" breadcrumb={breadcrumb} />
        <QueryError error={rollout.error} onRetry={() => void rollout.refetch()} />
      </>
    );
  }

  const pendingApproval = data.status === "pendiente_aprobacion";
  const selfCreated = session.isSelf(data.createdBy);
  const canAbort = data.status === "en_curso" || pendingApproval;

  const stepColumns: Column<RolloutStep>[] = [
    { id: "step", header: "Paso", cell: (s) => stepName(s, steps.indexOf(s)) },
    { id: "start", header: "Inicio", cell: (s) => formatTime(s.startedAt) },
    { id: "end", header: "Término", cell: (s) => formatTime(s.endedAt) },
    { id: "requests", header: "Solicitudes", align: "right", cell: (s) => formatNumber(s.requests) },
    {
      id: "errors",
      header: "Errores",
      align: "right",
      cell: (s) => {
        const over = (s.errorRate ?? 0) > (data.thresholds?.maxErrorRate ?? Number.POSITIVE_INFINITY);
        return (
          <span className={over ? "font-semibold text-bad" : undefined}>{formatPercent(s.errorRate, 2)}</span>
        );
      },
    },
    {
      id: "p99",
      header: "p99",
      align: "right",
      cell: (s) => {
        const over = (s.p99Ms ?? 0) > (data.thresholds?.maxP99Ms ?? Number.POSITIVE_INFINITY);
        return <span className={over ? "font-semibold text-bad" : undefined}>{formatMs(s.p99Ms)}</span>;
      },
    },
    {
      id: "decision",
      header: "Decisión",
      cell: (s) => (
        <StatusBadge kind="decision" status={s.decision} testId={`step-decision-${steps.indexOf(s)}`} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={`${data.apiName ?? data.apiId}: despliegue ${labelOf(STRATEGY_LABELS, data.strategy).toLowerCase()}`}
        reference="D-04"
        breadcrumb={breadcrumb}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="rollout" status={data.status} testId="rollout-status" />
            <span>{labelOf(ENVIRONMENT_LABELS, data.environment)}</span>
            {live && <span className="text-xs text-fg-muted">Actualización automática cada 2 segundos</span>}
          </span>
        }
        actions={
          <>
            {pendingApproval && (
              <GuardedButton
                permission="rollout:approve"
                variant="primary"
                icon={<ShieldCheck className="size-4" aria-hidden="true" />}
                blockedReason={
                  selfCreated
                    ? "Regla de cuatro ojos: usted creó este despliegue; debe aprobarlo otra persona con rol aprobador."
                    : null
                }
                loading={approve.isPending}
                onClick={() => approve.mutate(data.id)}
                data-testid="btn-approve-rollout"
              >
                Aprobar inicio
              </GuardedButton>
            )}
            {canAbort && (
              <GuardedButton
                permission="rollout:abort"
                variant="danger"
                icon={<OctagonX className="size-4" aria-hidden="true" />}
                onClick={() => setAborting(true)}
                data-testid="btn-abort-rollout"
              >
                Detener y revertir
              </GuardedButton>
            )}
          </>
        }
      />

      {(data.status === "revertido" || data.status === "abortado") && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-bad/40 bg-bad-soft p-4 text-sm text-fg"
          data-testid="rollback-banner"
        >
          <RotateCcw className="mt-0.5 size-5 shrink-0 text-bad" aria-hidden="true" />
          <div>
            <p className="font-semibold text-bad">
              {data.status === "revertido"
                ? "El despliegue se revirtió"
                : "El despliegue se abortó antes de iniciar"}
            </p>
            <p className="mt-0.5">{data.rollbackReason ?? "Sin motivo informado."}</p>
          </div>
        </div>
      )}
      {data.status === "completado" && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-ok/40 bg-ok-soft p-4 text-sm"
          data-testid="rollout-completed"
        >
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <p className="text-fg">
            La versión nueva recibe el 100 % del tráfico y cumplió los umbrales en todos los pasos.
          </p>
        </div>
      )}
      {pendingApproval && (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-warn/40 bg-warn-soft p-4 text-sm"
          data-testid="rollout-pending"
        >
          <Clock className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          <p className="text-fg">
            Esperando la aprobación de una persona con rol aprobador. Quien creó el despliegue (
            {data.createdBy ?? "—"}) no puede aprobarlo.
          </p>
        </div>
      )}

      <Card className="mb-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Tráfico hacia la versión nueva">
            <Meter value={data.currentWeight} label="Peso actual" testId="rollout-weight" />
          </Info>
          <Info label="Endpoint candidato">
            <code className="font-mono text-xs break-all">{data.candidateEndpoint}</code>
          </Info>
          <Info label="Endpoint estable">
            <code className="font-mono text-xs break-all">{data.stableEndpoint ?? "—"}</code>
          </Info>
          <Info label="Plan de pasos">{(data.steps ?? []).map((s) => `${s} %`).join(" → ")}</Info>
          <Info label="Umbrales">
            Errores ≤ {formatPercent(data.thresholds?.maxErrorRate, 1)} · p99 ≤{" "}
            {formatMs(data.thresholds?.maxP99Ms)} · mínimo {formatNumber(data.thresholds?.minRequests)}{" "}
            solicitudes
          </Info>
          <Info label="Duración de cada paso">{formatNumber(data.stepDurationSec)} s</Info>
          <Info label="Creado por">
            {data.createdBy ?? "—"} · {formatDateTime(data.createdAt)}
          </Info>
          <Info label="Aprobado por">{data.approvedBy ?? "Sin aprobación"}</Info>
        </dl>
      </Card>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card title="Peso en el tiempo" description="Porcentaje del tráfico enviado a la versión nueva.">
          {weightChart && steps.length > 0 ? (
            <Chart
              option={weightChart}
              label={`Peso actual ${data.currentWeight} % en ${steps.length} pasos.`}
              height={220}
              testId="chart-weight"
            />
          ) : (
            <p className="py-16 text-center text-sm text-fg-muted">El despliegue aún no comienza.</p>
          )}
        </Card>
        <Card
          title="Tasa de errores por paso"
          description="Comparada con el umbral; en rojo, los pasos que lo superan."
        >
          {steps.length > 0 ? (
            <Chart
              option={errorChart}
              label="Tasa de errores por paso (los valores están en la tabla de pasos)."
              height={220}
              testId="chart-errors"
            />
          ) : (
            <p className="py-16 text-center text-sm text-fg-muted">Sin datos todavía.</p>
          )}
        </Card>
        <Card title="Latencia p99 por paso" description="Comparada con el umbral de latencia.">
          {steps.length > 0 ? (
            <Chart
              option={p99Chart}
              label="Latencia p99 por paso (los valores están en la tabla de pasos)."
              height={220}
              testId="chart-p99"
            />
          ) : (
            <p className="py-16 text-center text-sm text-fg-muted">Sin datos todavía.</p>
          )}
        </Card>
      </div>

      <Card title="Pasos ejecutados" flush>
        <DataTable
          rows={steps}
          columns={stepColumns}
          rowKey={(s) => `${s.weight}-${s.startedAt}`}
          caption="Pasos ejecutados del despliegue"
          testId="table-rollout-steps"
          emptyTitle="Ningún paso ejecutado"
        />
      </Card>

      <ReasonDialog
        open={aborting}
        onClose={() => setAborting(false)}
        title="Detener y revertir"
        description="El tráfico vuelve de inmediato al backend estable. La acción queda auditada con su motivo."
        confirmLabel="Detener y revertir"
        confirmVariant="danger"
        minLength={10}
        pending={abort.isPending}
        testId="abort-dialog"
        onConfirm={(reason) => abort.mutate({ id: data.id, reason }, { onSuccess: () => setAborting(false) })}
      />
    </>
  );
}
