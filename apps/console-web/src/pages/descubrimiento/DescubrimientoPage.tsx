import { Download, Plus, ShieldAlert, Tags } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  fetchDiscoveryReportCsv,
  keys,
  useFindings,
  useRefreshWhenFinished,
  useScans,
} from "../../api/queries";
import type { DiscoveryFinding, DiscoveryScan, FindingStatus } from "../../api/types";
import { describeError } from "../../api/errors";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatTile } from "../../components/StatTile";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { Field, Select } from "../../components/ui/Input";
import { DataTable, type Column } from "../../components/ui/Table";
import { toast } from "../../components/ui/toast-store";
import { downloadCsv } from "../../lib/download";
import { fileTimestamp, formatDateTime, formatNumber } from "../../lib/format";
import { AUTH_DETECTED_LABELS, DISCOVERY_SOURCE_LABELS, labelOf } from "../../lib/labels";
import { NewScanDialog } from "./NewScanDialog";
import { TriageDialog } from "./TriageDialog";

const FINDING_STATUSES: Array<{ value: FindingStatus; label: string }> = [
  { value: "nuevo", label: "Nuevos" },
  { value: "en_migracion", label: "En migración" },
  { value: "riesgo_aceptado", label: "Riesgo aceptado" },
  { value: "gobernado", label: "Gobernados" },
  { value: "descartado", label: "Descartados" },
];

const isFindingStatus = (v: string | null): v is FindingStatus => FINDING_STATUSES.some((s) => s.value === v);

function scoreTone(score: number): { tone: BadgeTone; label: string } {
  if (score >= 70) return { tone: "bad", label: "Alto" };
  if (score >= 40) return { tone: "warn", label: "Medio" };
  return { tone: "ok", label: "Bajo" };
}

const scanColumns: Column<DiscoveryScan>[] = [
  {
    id: "startedAt",
    header: "Inicio",
    sortValue: (s) => s.startedAt,
    cell: (s) => formatDateTime(s.startedAt),
  },
  { id: "finishedAt", header: "Término", cell: (s) => formatDateTime(s.finishedAt) },
  {
    id: "status",
    header: "Estado",
    cell: (s) => <StatusBadge kind="scan" status={s.status} testId={`scan-status-${s.id}`} />,
  },
  {
    id: "sources",
    header: "Fuentes",
    cell: (s) => (s.sources ?? []).map((src) => labelOf(DISCOVERY_SOURCE_LABELS, src)).join(", ") || "—",
  },
  { id: "endpoints", header: "Endpoints", align: "right", cell: (s) => formatNumber(s.totals?.endpoints) },
  { id: "governed", header: "Gobernados", align: "right", cell: (s) => formatNumber(s.totals?.gobernados) },
  {
    id: "ungoverned",
    header: "No gobernados",
    align: "right",
    cell: (s) => formatNumber(s.totals?.noGobernados),
  },
  {
    id: "high",
    header: "Riesgo alto",
    align: "right",
    cell: (s) => (
      <span className={(s.totals?.riesgoAlto ?? 0) > 0 ? "font-semibold text-bad" : undefined}>
        {formatNumber(s.totals?.riesgoAlto)}
      </span>
    ),
  },
];

export default function DescubrimientoPage() {
  const [params, setParams] = useSearchParams();
  const statusParam = params.get("estado");
  const status = isFindingStatus(statusParam) ? statusParam : undefined;
  const scans = useScans();
  const findings = useFindings(status);
  const [scanOpen, setScanOpen] = useState(false);
  const [triage, setTriage] = useState<DiscoveryFinding | null>(null);
  const [downloading, setDownloading] = useState(false);

  const scanning = (scans.data ?? []).some((s) => s.status === "en_curso");
  useRefreshWhenFinished(scanning, keys.discovery, keys.overview);

  const latest = [...(scans.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  const download = async () => {
    setDownloading(true);
    try {
      const csv = await fetchDiscoveryReportCsv();
      downloadCsv(`reporte-exposicion-${fileTimestamp()}.csv`, csv);
    } catch (error) {
      const { title, description } = describeError(error);
      toast.error(title, description);
    } finally {
      setDownloading(false);
    }
  };

  const findingColumns: Column<DiscoveryFinding>[] = [
    {
      id: "score",
      header: "Exposición",
      sortValue: (f) => f.exposureScore,
      cell: (f) => {
        const { tone, label } = scoreTone(f.exposureScore);
        return (
          <Badge tone={tone} data-testid={`finding-score-${f.id}`}>
            <span className="tabular">{f.exposureScore}</span> · {label}
          </Badge>
        );
      },
    },
    {
      id: "endpoint",
      header: "Endpoint",
      sortValue: (f) => `${f.host}${f.path}`,
      cell: (f) => (
        <div className="max-w-72">
          <p className="font-mono text-xs break-all text-fg">
            {f.host}
            {f.port ? `:${f.port}` : ""}
            {f.path}
          </p>
          <p className="text-xs text-fg-muted">
            {labelOf(DISCOVERY_SOURCE_LABELS, f.source)} · {f.protocol ?? "—"} · TLS {f.tls ?? "—"}
          </p>
        </div>
      ),
    },
    {
      id: "auth",
      header: "Autenticación",
      sortValue: (f) => f.authDetected,
      cell: (f) => (
        <span className={f.authDetected === "ninguna" ? "font-medium text-bad" : undefined}>
          {labelOf(AUTH_DETECTED_LABELS, f.authDetected)}
        </span>
      ),
    },
    {
      id: "spec",
      header: "Especificación",
      cell: (f) => (f.specFound ? "Encontrada" : "No"),
    },
    {
      id: "pii",
      header: "Datos personales",
      sortValue: (f) => f.personalDataSuspected,
      cell: (f) => (f.personalDataSuspected ? <Badge tone="warn">Posibles</Badge> : "No detectados"),
    },
    {
      id: "reasons",
      header: "Motivos del puntaje",
      cell: (f) =>
        f.reasons && f.reasons.length > 0 ? (
          <ul className="max-w-80 list-disc space-y-0.5 pl-4 text-xs text-fg-muted">
            {f.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          "—"
        ),
    },
    {
      id: "status",
      header: "Estado",
      sortValue: (f) => f.status,
      cell: (f) => <StatusBadge kind="finding" status={f.status} testId={`finding-status-${f.id}`} />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Acciones</span>,
      printHidden: true,
      cell: (f) => (
        <GuardedButton
          permission="discovery:triage"
          size="sm"
          icon={<Tags className="size-4" aria-hidden="true" />}
          onClick={() => setTriage(f)}
          data-testid={`btn-triage-${f.id}`}
        >
          Clasificar
        </GuardedButton>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Descubrimiento de APIs no gobernadas"
        reference="D-01"
        description="Compara lo que exponen APISIX, NGINX, la red autorizada y Google Cloud con el catálogo de WSO2. Lo que no aparece en el catálogo es una API no gobernada, ordenada por su puntaje de exposición."
        actions={
          <>
            <GuardedButton
              permission="discovery:read"
              icon={<Download className="size-4" aria-hidden="true" />}
              loading={downloading}
              onClick={() => void download()}
              data-testid="btn-download-discovery-report"
            >
              Descargar reporte
            </GuardedButton>
            <GuardedButton
              permission="discovery:scan"
              variant="primary"
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => setScanOpen(true)}
              data-testid="btn-new-scan"
            >
              Nuevo escaneo
            </GuardedButton>
          </>
        }
      />

      <section
        aria-label="Resumen del último escaneo"
        className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatTile
          label="Endpoints encontrados"
          loading={scans.isLoading}
          value={formatNumber(latest?.totals?.endpoints)}
          detail="Último escaneo"
        />
        <StatTile
          label="Gobernados"
          loading={scans.isLoading}
          value={formatNumber(latest?.totals?.gobernados)}
          detail="Publicados en WSO2"
        />
        <StatTile
          label="No gobernados"
          loading={scans.isLoading}
          value={formatNumber(latest?.totals?.noGobernados)}
          detail="Fuera del catálogo"
          testId="kpi-ungoverned"
        />
        <StatTile
          label="Riesgo alto"
          icon={<ShieldAlert className="size-4" />}
          loading={scans.isLoading}
          value={formatNumber(latest?.totals?.riesgoAlto)}
          detail="Puntaje de exposición de 70 o más"
        />
      </section>

      <Card
        title="Escaneos"
        description="Se actualiza solo mientras hay un escaneo en curso."
        className="mb-6"
        flush
      >
        {scans.isError ? (
          <QueryError compact error={scans.error} onRetry={() => void scans.refetch()} />
        ) : (
          <DataTable
            rows={scans.data}
            columns={scanColumns}
            rowKey={(s) => s.id}
            caption="Escaneos de descubrimiento"
            loading={scans.isLoading}
            testId="table-scans"
            initialSort={{ id: "startedAt", direction: "desc" }}
            emptyTitle="Aún no hay escaneos"
          />
        )}
      </Card>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">Hallazgos</h2>
        <Field id="filtro-hallazgos" label="Estado" className="w-56">
          {(control) => (
            <Select
              {...control}
              value={status ?? ""}
              onChange={(e) =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (e.target.value) next.set("estado", e.target.value);
                    else next.delete("estado");
                    return next;
                  },
                  { replace: true },
                )
              }
              data-testid="findings-filter-status"
            >
              <option value="">Todos</option>
              {FINDING_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {findings.isError ? (
        <QueryError error={findings.error} onRetry={() => void findings.refetch()} />
      ) : (
        <DataTable
          rows={findings.data}
          columns={findingColumns}
          rowKey={(f) => f.id}
          caption="Hallazgos de descubrimiento ordenados por puntaje de exposición"
          loading={findings.isLoading}
          testId="table-findings"
          rowTestId={(f) => `finding-row-${f.id}`}
          initialSort={{ id: "score", direction: "desc" }}
          emptyTitle="No hay hallazgos con este estado"
        />
      )}

      <NewScanDialog open={scanOpen} onClose={() => setScanOpen(false)} />
      <TriageDialog finding={triage} onClose={() => setTriage(null)} />
    </>
  );
}
