import { Ban, CircleMinus, LockOpen, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  useAnomalies,
  useAnomalyRules,
  useApis,
  useApproveBlock,
  useBlocks,
  useDismissAnomaly,
  useReleaseBlock,
} from "../../api/queries";
import type { AnomalyEvent, AnomalyRule, AnomalyStatus, Block } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { ReasonDialog } from "../../components/ReasonDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge } from "../../components/ui/Badge";
import { Field, Select } from "../../components/ui/Input";
import { DataTable, type Column } from "../../components/ui/Table";
import { Tabs } from "../../components/ui/Tabs";
import {
  formatBytes,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatRelative,
} from "../../lib/format";
import { ACTION_LABELS, METRIC_LABELS, labelOf } from "../../lib/labels";
import { useNow } from "../../lib/useNow";
import { RuleDialog } from "./RuleDialog";

type TabId = "eventos" | "bloqueos" | "reglas";
const TABS: readonly TabId[] = ["eventos", "bloqueos", "reglas"];

const EVENT_STATUSES: Array<{ value: AnomalyStatus; label: string }> = [
  { value: "abierta", label: "Abiertas" },
  { value: "bloqueo_propuesto", label: "Bloqueo propuesto" },
  { value: "bloqueada", label: "Bloqueadas" },
  { value: "resuelta", label: "Resueltas" },
  { value: "descartada", label: "Descartadas" },
];

/** Valor observado o de línea base con la unidad de su métrica. */
function formatMetricValue(metric: string, value: number): string {
  switch (metric) {
    case "volumen":
      return `${formatNumber(value)} llamadas por ventana`;
    case "errores":
      return formatPercent(value > 1 ? value / 100 : value, 1);
    case "latencia":
      return formatMs(value);
    case "tamano":
      return formatBytes(value);
    case "ips_distintas":
      return `${formatNumber(value)} IPs`;
    case "fuera_de_horario":
      return `${formatNumber(value)} llamadas`;
    default:
      return formatNumber(value, 2);
  }
}

function EventsTab() {
  const [status, setStatus] = useState<AnomalyStatus | "">("");
  const events = useAnomalies(status || undefined);
  const approve = useApproveBlock();
  const [dismissing, setDismissing] = useState<AnomalyEvent | null>(null);
  const dismiss = useDismissAnomaly();

  const columns: Column<AnomalyEvent>[] = [
    { id: "ts", header: "Detectada", sortValue: (e) => e.ts, cell: (e) => formatDateTime(e.ts) },
    {
      id: "who",
      header: "API y consumidor",
      sortValue: (e) => e.apiName,
      cell: (e) => (
        <div>
          <p className="font-medium text-fg">{e.apiName ?? "Todas las APIs"}</p>
          <p className="text-xs text-fg-muted">
            {e.consumer ?? "Consumidor desconocido"}
            {e.sourceIp ? ` · IP ${e.sourceIp}` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "metric",
      header: "Métrica",
      sortValue: (e) => e.metric,
      cell: (e) => labelOf(METRIC_LABELS, e.metric),
    },
    {
      id: "values",
      header: "Observado vs. línea base",
      cell: (e) => (
        <div>
          <p className="font-medium text-fg tabular">{formatMetricValue(e.metric, e.observed)}</p>
          <p className="text-xs text-fg-muted tabular">
            Línea base {formatMetricValue(e.metric, e.baseline)}
            {e.baseline > 0 ? ` · ×${formatNumber(e.observed / e.baseline, 1)}` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "score",
      header: "Puntaje",
      align: "right",
      sortValue: (e) => e.score,
      cell: (e) => (
        <span className="tabular" title="Desviaciones robustas (MAD)">
          {formatNumber(e.score, 1)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Estado",
      sortValue: (e) => e.status,
      cell: (e) => (
        <div className="space-y-1">
          <StatusBadge kind="anomaly" status={e.status} testId={`anomaly-status-${e.id}`} />
          {e.actionTaken && <p className="max-w-56 text-xs text-fg-muted">{e.actionTaken}</p>}
          {e.approvedBy && <p className="text-xs text-fg-subtle">Decidió: {e.approvedBy}</p>}
        </div>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Acciones</span>,
      printHidden: true,
      cell: (e) => {
        const open = e.status === "abierta" || e.status === "bloqueo_propuesto";
        if (!open) return null;
        return (
          <div className="flex flex-wrap gap-2">
            {e.status === "bloqueo_propuesto" && (
              <GuardedButton
                permission="anomaly:block:approve"
                size="sm"
                variant="danger"
                icon={<Ban className="size-4" aria-hidden="true" />}
                loading={approve.isPending && approve.variables === e.id}
                onClick={() => approve.mutate(e.id)}
                data-testid={`btn-approve-block-${e.id}`}
              >
                Aprobar bloqueo
              </GuardedButton>
            )}
            <GuardedButton
              permission="anomaly:block:approve"
              size="sm"
              icon={<CircleMinus className="size-4" aria-hidden="true" />}
              onClick={() => setDismissing(e)}
              data-testid={`btn-dismiss-${e.id}`}
            >
              Descartar
            </GuardedButton>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      <Field id="filtro-anomalias" label="Estado" className="w-56">
        {(control) => (
          <Select
            {...control}
            value={status}
            onChange={(e) => setStatus(e.target.value as AnomalyStatus | "")}
            data-testid="anomalies-filter-status"
          >
            <option value="">Todos</option>
            {EVENT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {events.isError ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <DataTable
          rows={events.data}
          columns={columns}
          rowKey={(e) => e.id}
          caption="Eventos de anomalía"
          loading={events.isLoading}
          testId="table-anomalies"
          rowTestId={(e) => `anomaly-row-${e.id}`}
          initialSort={{ id: "ts", direction: "desc" }}
          emptyTitle="No hay anomalías con este estado"
        />
      )}
      <ReasonDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title="Descartar anomalía"
        description="Márquela como falso positivo. La regla seguirá evaluando el tráfico."
        confirmLabel="Descartar"
        minLength={10}
        pending={dismiss.isPending}
        testId="dismiss-dialog"
        onConfirm={(reason) =>
          dismissing &&
          dismiss.mutate({ id: dismissing.id, reason }, { onSuccess: () => setDismissing(null) })
        }
      />
    </div>
  );
}

function BlocksTab() {
  const blocks = useBlocks();
  const release = useReleaseBlock();
  const [releasing, setReleasing] = useState<Block | null>(null);
  const [showReleased, setShowReleased] = useState(false);
  const now = useNow();
  const rows = (blocks.data ?? []).filter((b) => showReleased || b.active);

  const columns: Column<Block>[] = [
    {
      id: "condition",
      header: "Condición",
      sortValue: (b) => b.conditionValue,
      cell: (b) => (
        <div>
          <Badge>{b.conditionType}</Badge>
          <p className="mt-1 font-mono text-xs break-all text-fg">{b.conditionValue}</p>
        </div>
      ),
    },
    { id: "reason", header: "Motivo", cell: (b) => <span className="text-sm">{b.reason ?? "—"}</span> },
    {
      id: "created",
      header: "Creado",
      sortValue: (b) => b.createdAt,
      cell: (b) => formatDateTime(b.createdAt),
    },
    {
      id: "expires",
      header: "Vence",
      sortValue: (b) => b.expiresAt,
      cell: (b) =>
        b.expiresAt ? (
          <span title={formatDateTime(b.expiresAt)}>
            {b.active ? formatRelative(b.expiresAt, now) : formatDateTime(b.expiresAt)}
          </span>
        ) : (
          "Sin vencimiento"
        ),
    },
    {
      id: "by",
      header: "Creado por",
      cell: (b) => (
        <div className="text-sm">
          {b.createdBy ?? "—"}
          {b.releasedBy && <p className="text-xs text-fg-muted">Liberado por {b.releasedBy}</p>}
        </div>
      ),
    },
    {
      id: "policy",
      header: "Política en WSO2",
      cell: (b) => (b.denyPolicyId ? <code className="font-mono text-xs">{b.denyPolicyId}</code> : "—"),
    },
    {
      id: "state",
      header: "Estado",
      cell: (b) => (
        <StatusBadge kind="block" status={b.active ? "activo" : "liberado"} testId={`block-status-${b.id}`} />
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Acciones</span>,
      printHidden: true,
      cell: (b) =>
        b.active ? (
          <GuardedButton
            permission="anomaly:block:release"
            size="sm"
            icon={<LockOpen className="size-4" aria-hidden="true" />}
            onClick={() => setReleasing(b)}
            data-testid={`btn-release-${b.id}`}
          >
            Liberar
          </GuardedButton>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
        <input
          type="checkbox"
          checked={showReleased}
          onChange={(e) => setShowReleased(e.target.checked)}
          className="size-4 accent-accent"
        />
        Mostrar también los bloqueos liberados o vencidos
      </label>
      {blocks.isError ? (
        <QueryError error={blocks.error} onRetry={() => void blocks.refetch()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(b) => b.id}
          caption="Bloqueos en el gateway"
          loading={blocks.isLoading}
          testId="table-blocks"
          rowTestId={(b) => `block-row-${b.id}`}
          initialSort={{ id: "created", direction: "desc" }}
          emptyTitle="No hay bloqueos activos"
        />
      )}
      <ReasonDialog
        open={releasing !== null}
        onClose={() => setReleasing(null)}
        title="Liberar bloqueo"
        description={
          releasing ? `Se elimina la política de denegación para ${releasing.conditionValue}.` : undefined
        }
        confirmLabel="Liberar bloqueo"
        minLength={10}
        pending={release.isPending}
        testId="release-dialog"
        onConfirm={(reason) =>
          releasing && release.mutate({ id: releasing.id, reason }, { onSuccess: () => setReleasing(null) })
        }
      />
    </div>
  );
}

function RulesTab({ onEdit }: { onEdit: (rule: AnomalyRule | null) => void }) {
  const rules = useAnomalyRules();
  const apis = useApis();
  const apiName = (id?: string) => {
    if (!id) return "Todas las APIs";
    // Las reglas guardan el id de la API en WSO2 (el que usa el guardián); el catálogo, «api:<id>».
    const api = apis.data?.find((a) => a.wso2ApiId === id || a.id === id);
    return api ? `${api.name} ${api.version}` : id;
  };
  const columns: Column<AnomalyRule>[] = [
    {
      id: "name",
      header: "Regla",
      sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <p className="font-medium text-fg">{r.name}</p>
          <p className="text-xs text-fg-muted">
            {apiName(r.apiId)}
            {r.consumerId ? ` · ${r.consumerId}` : ""}
          </p>
        </div>
      ),
    },
    {
      id: "metric",
      header: "Métrica",
      sortValue: (r) => r.metric,
      cell: (r) => labelOf(METRIC_LABELS, r.metric),
    },
    {
      id: "sensitivity",
      header: "Sensibilidad",
      align: "right",
      sortValue: (r) => r.sensitivity,
      cell: (r) => formatNumber(r.sensitivity, 1),
    },
    { id: "minVolume", header: "Volumen mínimo", align: "right", cell: (r) => formatNumber(r.minVolume) },
    {
      id: "action",
      header: "Acción",
      sortValue: (r) => r.action,
      cell: (r) => labelOf(ACTION_LABELS, r.action),
    },
    {
      id: "ttl",
      header: "Duración del bloqueo",
      cell: (r) => (r.action === "alertar" ? "—" : `${formatNumber(r.blockTtlMinutes)} min`),
    },
    {
      id: "enabled",
      header: "Estado",
      sortValue: (r) => r.enabled,
      cell: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "Activa" : "Inactiva"}</Badge>,
    },
    {
      id: "updated",
      header: "Actualizada",
      cell: (r) => (
        <span className="text-xs text-fg-muted">
          {formatDateTime(r.updatedAt)}
          {r.createdBy ? ` · ${r.createdBy}` : ""}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Acciones</span>,
      printHidden: true,
      cell: (r) => (
        <GuardedButton
          permission="anomaly:rules:write"
          size="sm"
          icon={<Pencil className="size-4" aria-hidden="true" />}
          onClick={() => onEdit(r)}
          data-testid={`btn-edit-rule-${r.id}`}
        >
          Editar
        </GuardedButton>
      ),
    },
  ];
  return rules.isError ? (
    <QueryError error={rules.error} onRetry={() => void rules.refetch()} />
  ) : (
    <DataTable
      rows={rules.data}
      columns={columns}
      rowKey={(r) => r.id}
      caption="Reglas de detección de anomalías"
      loading={rules.isLoading}
      testId="table-rules"
      initialSort={{ id: "name", direction: "asc" }}
      emptyTitle="No hay reglas configuradas"
    />
  );
}

export default function AnomaliasPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("pestana") as TabId | null;
  const tab: TabId = tabParam && TABS.includes(tabParam) ? tabParam : "eventos";
  const [editing, setEditing] = useState<{ rule: AnomalyRule | null } | null>(null);

  return (
    <>
      <PageHeader
        title="Guardián de anomalías"
        reference="D-02"
        description="Detecta desvíos de volumen, errores, latencia, tamaño, IPs y horario respecto de la línea base de cada API y consumidor. Los bloqueos se aplican como políticas de denegación en WSO2 y quedan auditados."
        actions={
          tab === "reglas" ? (
            <GuardedButton
              permission="anomaly:rules:write"
              variant="primary"
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => setEditing({ rule: null })}
              data-testid="btn-new-rule"
            >
              Nueva regla
            </GuardedButton>
          ) : undefined
        }
      />
      <Tabs<TabId>
        label="Secciones de anomalías"
        value={tab}
        onChange={(next) =>
          setParams(
            (prev) => {
              const p = new URLSearchParams(prev);
              p.set("pestana", next);
              return p;
            },
            { replace: true },
          )
        }
        items={[
          { id: "eventos", label: "Eventos", testId: "tab-eventos", content: <EventsTab /> },
          { id: "bloqueos", label: "Bloqueos activos", testId: "tab-bloqueos", content: <BlocksTab /> },
          {
            id: "reglas",
            label: "Reglas",
            testId: "tab-reglas",
            content: <RulesTab onEdit={(rule) => setEditing({ rule })} />,
          },
        ]}
      />
      <RuleDialog open={editing !== null} rule={editing?.rule ?? null} onClose={() => setEditing(null)} />
    </>
  );
}
