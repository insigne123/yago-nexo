import { useState } from "react";
import { Link } from "react-router";
import { useSessionContext } from "../../auth/session";
import { SeverityBadge, StatusBadge, Tag } from "../../components/badges";
import { SlaClocks } from "../../components/SlaClock";
import { Alert, EmptyState, PageTitle, Spinner } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { can } from "../../lib/permissions";
import { useTickets } from "../../lib/queries";
import { friendlyError } from "../../lib/supabase";
import { useNow } from "../../lib/useNow";

/** "Mis tickets": los tickets de la organización, con sus relojes en vivo. */
export function TicketsListPage() {
  const ctx = useSessionContext();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const { data, isLoading, error } = useTickets(includeClosed);
  const now = useNow(1000);

  const tickets = (data ?? []).filter((t) => !onlyMine || t.reporter_id === ctx.userId);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle description="Tickets de su organización. Los relojes muestran el tiempo que queda de cada plazo del SLA.">
          Mis tickets
        </PageTitle>
        {can(ctx, "ticket:create") ? (
          <Link
            to="/tickets/nuevo"
            className="rounded-md bg-blue-800 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-900"
          >
            Nuevo ticket
          </Link>
        ) : null}
      </div>
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
            className="h-4 w-4"
          />
          Incluir cerrados
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(e) => setOnlyMine(e.target.checked)}
            className="h-4 w-4"
          />
          Solo los que reporté
        </label>
      </div>
      {isLoading ? <Spinner label="Cargando tickets" /> : null}
      {error ? <Alert>{friendlyError(error)}</Alert> : null}
      {!isLoading && !error && tickets.length === 0 ? (
        <EmptyState>No hay tickets para mostrar.</EmptyState>
      ) : null}
      {tickets.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <caption className="sr-only">Tickets de la organización con sus plazos</caption>
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Ticket
                </th>
                <th scope="col" className="px-3 py-2">
                  Severidad
                </th>
                <th scope="col" className="px-3 py-2">
                  Estado
                </th>
                <th scope="col" className="px-3 py-2">
                  Plazos
                </th>
                <th scope="col" className="px-3 py-2">
                  Recibido
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tickets.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link to={`/tickets/${t.id}`} className="font-semibold text-blue-800 underline">
                      {t.number}
                    </Link>
                    <div className="max-w-xs text-slate-800">{t.title}</div>
                    {t.is_security_incident ? <Tag tone="peligro">Seguridad</Tag> : null}
                  </td>
                  <td className="px-3 py-2">
                    <SeverityBadge severity={t.severity} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="min-w-[22rem] px-3 py-2">
                    <SlaClocks clocks={t.clocks} now={now} compact />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">
                    {formatDateTime(t.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {(data?.length ?? 0) >= 300 ? (
        <p className="mt-2 text-xs text-slate-600">Se muestran los 300 tickets más recientes.</p>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {tickets.length} tickets
      </div>
    </div>
  );
}
