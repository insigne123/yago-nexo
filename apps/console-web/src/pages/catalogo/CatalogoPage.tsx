import { RefreshCw, Search } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useApis, useCatalogSync } from "../../api/queries";
import type { ApiAsset, Audience, Classification } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge } from "../../components/ui/Badge";
import { Field, Input, Select } from "../../components/ui/Input";
import { Meter } from "../../components/ui/Meter";
import { DataTable, type Column } from "../../components/ui/Table";
import { formatNumber, plural } from "../../lib/format";
import { AUDIENCE_LABELS, CLASSIFICATION_LABELS, labelOf } from "../../lib/labels";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

const STATES = [
  { value: "CREATED", label: "Borrador" },
  { value: "PUBLISHED", label: "Publicada" },
  { value: "DEPRECATED", label: "Deprecada" },
  { value: "RETIRED", label: "Retirada" },
];

const isAudience = (v: string | null): v is Audience =>
  v === "interna" || v === "operadores" || v === "publica";
const isClassification = (v: string | null): v is Classification =>
  v === "publica" || v === "interna" || v === "reservada" || v === "datos_personales";

const columns: Column<ApiAsset>[] = [
  {
    id: "name",
    header: "API",
    sortValue: (a) => a.name,
    cell: (a) => (
      <div className="min-w-48">
        <Link
          to={`/catalogo/${encodeURIComponent(a.id)}`}
          className="font-medium text-accent hover:underline"
        >
          {a.name}
        </Link>
        <p className="text-xs text-fg-muted">
          <span className="font-mono">{a.context}</span>
          {a.type ? ` · ${a.type}` : ""}
        </p>
      </div>
    ),
  },
  {
    id: "version",
    header: "Versión",
    sortValue: (a) => a.version,
    cell: (a) => <span className="tabular">{a.version}</span>,
  },
  {
    id: "audience",
    header: "Audiencia",
    sortValue: (a) => a.audience,
    cell: (a) => labelOf(AUDIENCE_LABELS, a.audience),
  },
  {
    id: "state",
    header: "Estado",
    sortValue: (a) => a.state,
    cell: (a) => <StatusBadge kind="apiState" status={a.state} testId={`api-state-${a.id}`} />,
  },
  {
    id: "classification",
    header: "Clasificación",
    sortValue: (a) => a.classification,
    cell: (a) =>
      a.classification ? (
        <Badge
          tone={
            a.classification === "datos_personales" || a.classification === "reservada" ? "warn" : "neutral"
          }
        >
          {labelOf(CLASSIFICATION_LABELS, a.classification)}
        </Badge>
      ) : (
        <span className="text-fg-subtle">Sin clasificar</span>
      ),
  },
  {
    id: "owner",
    header: "Equipo dueño",
    sortValue: (a) => a.ownerTeam,
    cell: (a) => a.ownerTeam ?? <span className="text-warn">Sin dueño</span>,
  },
  {
    id: "consumers",
    header: "Consumidores",
    align: "right",
    sortValue: (a) => a.consumersCount,
    cell: (a) => <span className="tabular">{formatNumber(a.consumersCount)}</span>,
  },
  {
    id: "completeness",
    header: "Completitud",
    sortValue: (a) => a.completeness,
    cell: (a) => (
      <Meter value={a.completeness} label={`Completitud de ${a.name}`} tone="auto" className="min-w-28" />
    ),
  },
];

export default function CatalogoPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const audienceParam = params.get("audiencia");
  const stateParam = params.get("estado") ?? "";
  const classParam = params.get("clasificacion");
  const audience = isAudience(audienceParam) ? audienceParam : undefined;
  const classification = isClassification(classParam) ? classParam : undefined;

  const debouncedQ = useDebouncedValue(q, 300);
  const apis = useApis({ q: debouncedQ || undefined, audience, state: stateParam || undefined });
  const sync = useCatalogSync();

  const rows = useMemo(
    () => (apis.data ?? []).filter((a) => !classification || a.classification === classification),
    [apis.data, classification],
  );

  const update = (key: string, value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <>
      <PageHeader
        title="Catálogo de APIs"
        reference="BT-018"
        description="Ficha de gobierno de cada API publicada en WSO2: propósito, dueño, contrato, autenticación, clasificación, consumidores y completitud de los metadatos."
        actions={
          <GuardedButton
            permission="catalog:write"
            variant="primary"
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
            data-testid="btn-sync-wso2"
          >
            Sincronizar con WSO2
          </GuardedButton>
        }
      />

      <form
        role="search"
        aria-label="Filtrar el catálogo"
        className="mb-4 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field id="filtro-q" label="Buscar">
          {(control) => (
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle"
                aria-hidden="true"
              />
              <Input
                {...control}
                type="search"
                value={q}
                onChange={(e) => update("q", e.target.value)}
                placeholder="Nombre, contexto o dueño"
                className="pl-8"
                data-testid="catalog-search"
              />
            </div>
          )}
        </Field>
        <Field id="filtro-audiencia" label="Audiencia">
          {(control) => (
            <Select
              {...control}
              value={audience ?? ""}
              onChange={(e) => update("audiencia", e.target.value)}
              data-testid="catalog-filter-audience"
            >
              <option value="">Todas</option>
              {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="filtro-estado" label="Estado">
          {(control) => (
            <Select
              {...control}
              value={stateParam}
              onChange={(e) => update("estado", e.target.value)}
              data-testid="catalog-filter-state"
            >
              <option value="">Todos</option>
              {STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="filtro-clasificacion" label="Clasificación">
          {(control) => (
            <Select
              {...control}
              value={classification ?? ""}
              onChange={(e) => update("clasificacion", e.target.value)}
              data-testid="catalog-filter-classification"
            >
              <option value="">Todas</option>
              {Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>

      {apis.isError ? (
        <QueryError error={apis.error} onRetry={() => void apis.refetch()} />
      ) : (
        <>
          <p className="mb-2 text-sm text-fg-muted" aria-live="polite">
            {apis.isLoading
              ? "Cargando el catálogo…"
              : plural(rows.length, "API encontrada", "APIs encontradas")}
          </p>
          <div className={apis.isFetching && !apis.isLoading ? "opacity-70 transition-opacity" : undefined}>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(a) => a.id}
              caption="Catálogo de APIs"
              loading={apis.isLoading}
              testId="table-apis"
              rowTestId={(a) => `api-row-${a.id}`}
              initialSort={{ id: "name", direction: "asc" }}
              emptyTitle="No hay APIs que coincidan con los filtros"
            />
          </div>
        </>
      )}
    </>
  );
}
