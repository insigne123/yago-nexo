import { ArrowLeft, CircleCheck, CircleX, Network, Pencil } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useApiDetail, useGraph } from "../../api/queries";
import type { ApiAssetDetail, GraphNode } from "../../api/types";
import { useSession } from "../../auth/session";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Meter } from "../../components/ui/Meter";
import { Skeleton } from "../../components/ui/Skeleton";
import { DataTable, type Column } from "../../components/ui/Table";
import { Tabs } from "../../components/ui/Tabs";
import { governanceChecklist, missingFieldLabel } from "../../features/catalog/governance";
import { formatDateTime } from "../../lib/format";
import {
  AUDIENCE_LABELS,
  CLASSIFICATION_LABELS,
  EDGE_SOURCE_LABELS,
  NODE_TYPE_LABELS,
  RELATION_LABELS,
  labelOf,
} from "../../lib/labels";
import { ApiEditForm } from "./ApiEditForm";

type TabId = "resumen" | "consumidores" | "dependencias" | "historial";
const TAB_IDS: readonly TabId[] = ["resumen", "consumidores", "dependencias", "historial"];
const isTab = (v: string | null): v is TabId => TAB_IDS.includes(v as TabId);

function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-fg-muted">{term}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

const Missing = () => <span className="text-warn">No informado</span>;

function Summary({ api }: { api: ApiAssetDetail }) {
  return (
    <dl className="divide-y divide-line" data-testid="api-summary">
      <DefinitionRow term="Propósito">{api.purpose || <Missing />}</DefinitionRow>
      <DefinitionRow term="Equipo dueño">{api.ownerTeam || <Missing />}</DefinitionRow>
      <DefinitionRow term="Contacto del dueño">{api.ownerContact || <Missing />}</DefinitionRow>
      <DefinitionRow term="Audiencia">{labelOf(AUDIENCE_LABELS, api.audience)}</DefinitionRow>
      <DefinitionRow term="Clasificación de los datos">
        {api.classification ? labelOf(CLASSIFICATION_LABELS, api.classification) : <Missing />}
      </DefinitionRow>
      <DefinitionRow term="Contrato">
        {api.contractRef ? (
          <code className="font-mono text-xs break-all">{api.contractRef}</code>
        ) : (
          <Missing />
        )}
      </DefinitionRow>
      <DefinitionRow term="Autenticación">{api.authType || <Missing />}</DefinitionRow>
      <DefinitionRow term="Contexto y tipo">
        <code className="font-mono text-xs">{api.context}</code> · {api.type ?? "—"}
      </DefinitionRow>
      <DefinitionRow term="Identificador en WSO2">
        {api.wso2ApiId ? <code className="font-mono text-xs break-all">{api.wso2ApiId}</code> : "—"}
      </DefinitionRow>
      <DefinitionRow term="Última actualización">{formatDateTime(api.updatedAt)}</DefinitionRow>
    </dl>
  );
}

type Consumer = NonNullable<ApiAssetDetail["consumers"]>[number];

const consumerColumns: Column<Consumer>[] = [
  { id: "name", header: "Aplicación", sortValue: (c) => c.name, cell: (c) => c.name ?? "—" },
  { id: "org", header: "Organización", sortValue: (c) => c.organization, cell: (c) => c.organization ?? "—" },
  { id: "plan", header: "Plan (sin cobro)", sortValue: (c) => c.plan, cell: (c) => c.plan ?? "—" },
  {
    id: "status",
    header: "Suscripción",
    sortValue: (c) => c.status,
    cell: (c) => (
      <Badge tone={c.status === "activa" || c.status === "ACTIVE" ? "ok" : "neutral"}>
        {c.status ?? "—"}
      </Badge>
    ),
  },
];

type Dependency = NonNullable<ApiAssetDetail["dependencies"]>[number];

function DependencyTable({ api, nodes }: { api: ApiAssetDetail; nodes: Map<string, GraphNode> }) {
  const label = (id: string) => {
    const node = nodes.get(id);
    return node ? (
      <span>
        {node.label} <span className="text-xs text-fg-muted">({labelOf(NODE_TYPE_LABELS, node.type)})</span>
      </span>
    ) : (
      <code className="font-mono text-xs">{id}</code>
    );
  };
  const columns: Column<Dependency>[] = [
    { id: "from", header: "Origen", cell: (d) => label(d.from) },
    { id: "relation", header: "Relación", cell: (d) => labelOf(RELATION_LABELS, d.relation) },
    { id: "to", header: "Destino", cell: (d) => label(d.to) },
    { id: "source", header: "Fuente del dato", cell: (d) => labelOf(EDGE_SOURCE_LABELS, d.source) },
  ];
  return (
    <div className="space-y-3">
      <DataTable
        rows={api.dependencies ?? []}
        columns={columns}
        rowKey={(d) => `${d.from}->${d.to}:${d.relation}`}
        caption={`Dependencias de ${api.name}`}
        testId="table-api-dependencies"
        emptyTitle="Sin dependencias registradas"
      />
      <Link
        to={`/dependencias?nodo=${encodeURIComponent(api.id)}`}
        className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
      >
        <Network className="size-4" aria-hidden="true" />
        Ver en el grafo de dependencias
      </Link>
    </div>
  );
}

function History({ api }: { api: ApiAssetDetail }) {
  const items = [...(api.history ?? [])].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  if (items.length === 0) return <EmptyState compact title="Sin historial registrado" />;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5" data-testid="api-history">
      {items.map((h, i) => (
        <li key={`${h.ts}-${i}`}>
          <span
            className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-surface bg-accent"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">{h.action ?? "Cambio"}</p>
          {h.detail && <p className="text-sm text-fg-muted">{h.detail}</p>}
          <p className="text-xs text-fg-subtle">
            {formatDateTime(h.ts)} · {h.actor ?? "sistema"}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Checklist({ api }: { api: ApiAssetDetail }) {
  const items = governanceChecklist(api, api.missingFields);
  const complete = items.filter((i) => i.complete).length;
  const extra = (api.missingFields ?? []).filter((f) => !items.some((i) => missingFieldLabel(f) === i.label));
  return (
    <Card
      title="Campos de gobierno"
      description={`${complete} de ${items.length} campos completos`}
      data-testid="missing-fields"
    >
      <Meter value={api.completeness} label="Completitud de la ficha" tone="auto" className="mb-3" />
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-2 text-sm"
            data-testid={`field-${item.key}`}
            data-complete={item.complete}
          >
            {item.complete ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
            ) : (
              <CircleX className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
            )}
            <span className={item.complete ? "text-fg" : "font-medium text-fg"}>
              {item.label}
              <span className="sr-only">{item.complete ? ": completo" : ": falta"}</span>
            </span>
          </li>
        ))}
        {extra.map((field) => (
          <li key={field} className="flex items-start gap-2 text-sm">
            <CircleX className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
            <span className="font-medium text-fg">
              {missingFieldLabel(field)}
              <span className="sr-only">: falta</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function CatalogoDetallePage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("pestana");
  const tab: TabId = isTab(tabParam) ? tabParam : "resumen";
  const detail = useApiDetail(id);
  const session = useSession();
  const graph = useGraph(session.can("catalog:read"));
  const [editing, setEditing] = useState(false);

  const nodes = useMemo(() => new Map((graph.data?.nodes ?? []).map((n) => [n.id, n])), [graph.data]);

  const breadcrumb = (
    <Link to="/catalogo" className="inline-flex items-center gap-1 hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden="true" />
      Catálogo
    </Link>
  );

  if (detail.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <>
        <PageHeader title="Ficha de API" breadcrumb={breadcrumb} />
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
      </>
    );
  }
  const api = detail.data;

  return (
    <>
      <PageHeader
        title={`${api.name} ${api.version}`}
        breadcrumb={breadcrumb}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="apiState" status={api.state} testId="api-state" />
            <Badge>{labelOf(AUDIENCE_LABELS, api.audience)}</Badge>
            {api.classification && (
              <Badge tone="neutral">{labelOf(CLASSIFICATION_LABELS, api.classification)}</Badge>
            )}
            <span className="font-mono text-xs">{api.context}</span>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <Tabs<TabId>
            label="Secciones de la ficha"
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
              {
                id: "resumen",
                label: "Resumen",
                testId: "tab-resumen",
                content: editing ? (
                  <ApiEditForm key={api.updatedAt ?? api.id} api={api} onDone={() => setEditing(false)} />
                ) : (
                  <>
                    <div className="mb-2 flex justify-end">
                      <GuardedButton
                        permission="catalog:write"
                        size="sm"
                        icon={<Pencil className="size-4" aria-hidden="true" />}
                        onClick={() => setEditing(true)}
                        data-testid="btn-edit-api"
                      >
                        Editar metadatos
                      </GuardedButton>
                    </div>
                    <Summary api={api} />
                  </>
                ),
              },
              {
                id: "consumidores",
                label: `Consumidores (${api.consumers?.length ?? api.consumersCount ?? 0})`,
                testId: "tab-consumidores",
                content: (
                  <DataTable
                    rows={api.consumers ?? []}
                    columns={consumerColumns}
                    rowKey={(c) => c.id ?? `${c.organization}-${c.name}`}
                    caption={`Consumidores de ${api.name}`}
                    testId="table-api-consumers"
                    emptyTitle="Esta API no tiene consumidores suscritos"
                  />
                ),
              },
              {
                id: "dependencias",
                label: `Dependencias (${api.dependencies?.length ?? api.dependenciesCount ?? 0})`,
                testId: "tab-dependencias",
                content: <DependencyTable api={api} nodes={nodes} />,
              },
              {
                id: "historial",
                label: "Historial",
                testId: "tab-historial",
                content: <History api={api} />,
              },
            ]}
          />
        </Card>
        <Checklist api={api} />
      </div>
    </>
  );
}
