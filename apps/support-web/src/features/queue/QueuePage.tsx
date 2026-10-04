import { useMemo, useState } from "react";
import { Link } from "react-router";
import { SeverityBadge, StatusBadge, Tag } from "../../components/badges";
import { SlaClocks } from "../../components/SlaClock";
import { Alert, EmptyState, PageTitle, SelectField, Spinner } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { STATUS_LABEL, STATUS_ORDER } from "../../lib/labels";
import { useDirectory, useTickets } from "../../lib/queries";
import { sortQueue, type SortKey } from "../../lib/queue";
import { isBreached } from "../../lib/sla";
import { friendlyError } from "../../lib/supabase";
import type { Severity, TicketStatus } from "../../lib/types";
import { useNow } from "../../lib/useNow";

/** Bandeja de Yago: todos los tickets abiertos de todas las organizaciones. */
export function QueuePage() {
  const { data, isLoading, error } = useTickets(false);
  const { data: people = [] } = useDirectory();
  const now = useNow(1000);
  const [severity, setSeverity] = useState<Severity | "">("");
  const [status, setStatus] = useState<TicketStatus | "">("");
  const [org, setOrg] = useState("");
  const [sort, setSort] = useState<SortKey>("vencimiento");

  const all = useMemo(() => data ?? [], [data]);
  const quarantine = all.filter((t) => t.intake_status === "cuarentena");
  const accepted = all.filter((t) => t.intake_status === "aceptado");
  const orgs = Array.from(
    new Map(accepted.filter((t) => t.org).map((t) => [t.org!.id, t.org!.name])).entries(),
  );
  const filtered = sortQueue(
    accepted.filter(
      (t) =>
        (!severity || t.severity === severity) &&
        (!status || t.status === status) &&
        (!org || t.org_id === org),
    ),
    sort,
  );
  const nameOf = (userId: string | null) =>
    userId ? (people.find((p) => p.user_id === userId)?.display_name ?? "—") : "Sin asignar";

  return (
    <div>
      <PageTitle description="Tickets abiertos de todas las organizaciones, ordenados por el próximo vencimiento.">
        Bandeja
      </PageTitle>
      {quarantine.length > 0 ? (
        <div className="mb-4">
          <Alert tone="alerta">
            Hay {quarantine.length} {quarantine.length === 1 ? "mensaje" : "mensajes"} en cuarentena por
            revisar:{" "}
            {quarantine.map((t, i) => (
              <span key={t.id}>
                {i > 0 ? ", " : ""}
                <Link to={`/tickets/${t.id}`} className="font-semibold underline">
                  {t.number}
                </Link>
              </span>
            ))}
          </Alert>
        </div>
      ) : null}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <SelectField
          label="Severidad"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity | "")}
        >
          <option value="">Todas</option>
          {(["S1", "S2", "S3", "S4"] as Severity[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Estado"
          value={status}
          onChange={(e) => setStatus(e.target.value as TicketStatus | "")}
        >
          <option value="">Todos los abiertos</option>
          {STATUS_ORDER.filter((s) => s !== "cerrado").map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Organización" value={org} onChange={(e) => setOrg(e.target.value)}>
          <option value="">Todas</option>
          {orgs.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Ordenar por" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="vencimiento">Próximo vencimiento</option>
          <option value="severidad">Severidad</option>
          <option value="recepcion">Más recientes</option>
        </SelectField>
      </div>
      {isLoading ? <Spinner label="Cargando la bandeja" /> : null}
      {error ? <Alert>{friendlyError(error)}</Alert> : null}
      {!isLoading && !error && filtered.length === 0 ? (
        <EmptyState>No hay tickets con esos filtros.</EmptyState>
      ) : null}
      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <caption className="sr-only">Bandeja de tickets abiertos</caption>
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Ticket
                </th>
                <th scope="col" className="px-3 py-2">
                  Sev.
                </th>
                <th scope="col" className="px-3 py-2">
                  Estado
                </th>
                <th scope="col" className="px-3 py-2">
                  Organización
                </th>
                <th scope="col" className="px-3 py-2">
                  Responsable
                </th>
                <th scope="col" className="px-3 py-2">
                  Plazos
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((t) => (
                <tr key={t.id} className={`align-top ${isBreached(t.clocks, now) ? "bg-red-50" : ""}`}>
                  <td className="px-3 py-2">
                    <Link to={`/tickets/${t.id}`} className="font-semibold text-blue-800 underline">
                      {t.number}
                    </Link>
                    <div className="max-w-xs text-slate-800">{t.title}</div>
                    <div className="text-xs text-slate-500">{formatDateTime(t.created_at)}</div>
                    {t.is_security_incident ? <Tag tone="peligro">Seguridad</Tag> : null}
                    {t.escalation_level > 1 ? (
                      <Tag tone="alerta">{`Escalado a nivel ${t.escalation_level}`}</Tag>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <SeverityBadge severity={t.severity} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2">{t.org?.name ?? "—"}</td>
                  <td className="px-3 py-2">{nameOf(t.assignee_id)}</td>
                  <td className="min-w-[22rem] px-3 py-2">
                    <SlaClocks clocks={t.clocks} now={now} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
