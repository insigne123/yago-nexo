import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSessionContext } from "../../auth/session";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageTitle,
  SelectField,
  Spinner,
  TextField,
} from "../../components/ui";
import { fetchReports, generateReport, signedUrl } from "../../lib/api";
import { formatDateTime, formatPeriod, previousPeriod } from "../../lib/format";
import { METRIC_LABEL } from "../../lib/labels";
import { can } from "../../lib/permissions";
import { keys, useOrganizations } from "../../lib/queries";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { MonthlyReportRow } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";

function SummaryTable({ report }: { report: MonthlyReportRow }) {
  const rows = report.summary.resumen ?? [];
  if (rows.length === 0) return <p className="text-xs text-slate-600">El informe no tiene resumen.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <caption className="sr-only">Cumplimiento por severidad y métrica</caption>
        <thead className="text-left font-semibold uppercase text-slate-600">
          <tr>
            <th scope="col" className="px-2 py-1">
              Severidad
            </th>
            <th scope="col" className="px-2 py-1">
              Métrica
            </th>
            <th scope="col" className="px-2 py-1">
              Casos
            </th>
            <th scope="col" className="px-2 py-1">
              A tiempo
            </th>
            <th scope="col" className="px-2 py-1">
              Fuera de plazo
            </th>
            <th scope="col" className="px-2 py-1">
              Cumplimiento
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={`${r.severity}-${r.metric}`}>
              <td className="px-2 py-1">{r.severity}</td>
              <td className="px-2 py-1">{METRIC_LABEL[r.metric]}</td>
              <td className="px-2 py-1">{r.total}</td>
              <td className="px-2 py-1">{r.met_on_time}</td>
              <td className="px-2 py-1">{r.breached}</td>
              <td className="px-2 py-1">
                {r.compliance_pct === null ? "Sin casos" : `${String(r.compliance_pct).replace(".", ",")} %`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GenerateForm() {
  const supabase = useSupabase();
  const { data: orgs = [] } = useOrganizations();
  const action = useRunAction([keys.reports]);
  const [period, setPeriod] = useState(previousPeriod());
  const [orgId, setOrgId] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await action.run(
      async () => {
        const result = await generateReport(supabase, period, orgId || null);
        if (result.informes.length === 0) throw new Error("No se generó ningún informe");
      },
      `Informe de ${formatPeriod(period)} generado.`,
    );
  }

  return (
    <Card title="Generar informe">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextField
          label="Mes"
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          required
        />
        <SelectField label="Organización" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          <option value="">Todas las organizaciones cliente</option>
          {orgs
            .filter((o) => !o.is_provider)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </SelectField>
        <div className="flex items-end">
          <Button type="submit" disabled={action.busy || !/^\d{4}-\d{2}$/.test(period)}>
            {action.busy ? "Generando…" : "Generar PDF"}
          </Button>
        </div>
      </form>
      <p className="mt-2 text-xs text-slate-600">
        El informe del mes anterior también se genera solo el día 1 de cada mes.
      </p>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}

function ReportItem({ report, orgName }: { report: MonthlyReportRow; orgName: string }) {
  const supabase = useSupabase();
  const [error, setError] = useState<string | null>(null);
  async function download() {
    if (!report.pdf_path) return;
    setError(null);
    try {
      window.open(
        await signedUrl(supabase, report.pdf_path, `informe-sla-${report.period}.pdf`),
        "_blank",
        "noopener,noreferrer",
      );
    } catch (err) {
      setError(friendlyError(err));
    }
  }
  return (
    <li className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold capitalize text-slate-900">{formatPeriod(report.period)}</p>
          <p className="text-xs text-slate-600">
            {orgName} · generado {formatDateTime(report.generated_at)}
          </p>
        </div>
        <Button variant="secundario" disabled={!report.pdf_path} onClick={() => void download()}>
          Descargar PDF
        </Button>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-blue-800">Ver resumen</summary>
        <div className="mt-2">
          <SummaryTable report={report} />
        </div>
      </details>
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}

/** Informes mensuales de cumplimiento del SLA (PDF en el bucket de la mesa). */
export function ReportsPage() {
  const ctx = useSessionContext();
  const supabase = useSupabase();
  const reports = useQuery({ queryKey: keys.reports, queryFn: () => fetchReports(supabase) });
  const { data: orgs = [] } = useOrganizations();
  const orgNames = new Map(orgs.map((o) => [o.id, o.name]));
  return (
    <div className="flex flex-col gap-4">
      <PageTitle description="Cumplimiento de cada plazo por severidad, pausas e incumplimientos del mes.">
        Informes mensuales
      </PageTitle>
      {can(ctx, "report:generate") ? <GenerateForm /> : null}
      <Card title="Informes">
        {reports.isLoading ? <Spinner label="Cargando informes" /> : null}
        {reports.error ? <Alert>{friendlyError(reports.error)}</Alert> : null}
        {reports.data && reports.data.length === 0 ? <EmptyState>Todavía no hay informes.</EmptyState> : null}
        <ul className="flex flex-col gap-3">
          {(reports.data ?? []).map((r) => (
            <ReportItem key={r.id} report={r} orgName={orgNames.get(r.org_id) ?? ""} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
