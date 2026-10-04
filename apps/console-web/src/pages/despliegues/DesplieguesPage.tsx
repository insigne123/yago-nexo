import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useRollouts } from "../../api/queries";
import type { Rollout } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatusBadge } from "../../components/StatusBadge";
import { Meter } from "../../components/ui/Meter";
import { DataTable, type Column } from "../../components/ui/Table";
import { formatDateTime } from "../../lib/format";
import { ENVIRONMENT_LABELS, STRATEGY_LABELS, labelOf } from "../../lib/labels";

const columns: Column<Rollout>[] = [
  {
    id: "api",
    header: "API",
    sortValue: (r) => r.apiName ?? r.apiId,
    cell: (r) => (
      <div>
        <Link
          to={`/despliegues/${encodeURIComponent(r.id)}`}
          className="font-medium text-accent hover:underline"
        >
          {r.apiName ?? r.apiId}
        </Link>
        <p className="font-mono text-xs break-all text-fg-muted">{r.candidateEndpoint}</p>
      </div>
    ),
  },
  {
    id: "strategy",
    header: "Estrategia",
    sortValue: (r) => r.strategy,
    cell: (r) => labelOf(STRATEGY_LABELS, r.strategy),
  },
  {
    id: "env",
    header: "Ambiente",
    sortValue: (r) => r.environment,
    cell: (r) => labelOf(ENVIRONMENT_LABELS, r.environment),
  },
  {
    id: "status",
    header: "Estado",
    sortValue: (r) => r.status,
    cell: (r) => <StatusBadge kind="rollout" status={r.status} testId={`rollout-status-${r.id}`} />,
  },
  {
    id: "weight",
    header: "Tráfico a la versión nueva",
    sortValue: (r) => r.currentWeight,
    cell: (r) => (
      <Meter value={r.currentWeight} label={`Peso actual de ${r.apiName ?? r.apiId}`} className="min-w-36" />
    ),
  },
  {
    id: "people",
    header: "Creó / aprobó",
    cell: (r) => (
      <div className="text-xs">
        <p>{r.createdBy ?? "—"}</p>
        <p className="text-fg-muted">{r.approvedBy ?? "Sin aprobación"}</p>
      </div>
    ),
  },
  {
    id: "created",
    header: "Creado",
    sortValue: (r) => r.createdAt,
    cell: (r) => formatDateTime(r.createdAt),
  },
];

export default function DesplieguesPage() {
  const rollouts = useRollouts();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Despliegues progresivos"
        reference="D-04"
        description="Canary y blue-green con reversa automática: el controlador avanza por pasos solo si la tasa de errores y la latencia p99 de la versión nueva están dentro de los umbrales; si no, vuelve atrás sin corte."
        actions={
          <GuardedButton
            permission="rollout:create"
            variant="primary"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => void navigate("/despliegues/nuevo")}
            data-testid="btn-new-rollout"
          >
            Nuevo despliegue
          </GuardedButton>
        }
      />
      {rollouts.isError ? (
        <QueryError error={rollouts.error} onRetry={() => void rollouts.refetch()} />
      ) : (
        <DataTable
          rows={rollouts.data}
          columns={columns}
          rowKey={(r) => r.id}
          caption="Despliegues progresivos"
          loading={rollouts.isLoading}
          testId="table-rollouts"
          rowTestId={(r) => `rollout-row-${r.id}`}
          initialSort={{ id: "created", direction: "desc" }}
          emptyTitle="No hay despliegues registrados"
        />
      )}
    </>
  );
}
