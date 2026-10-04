import { Link, useLocation, useParams } from "react-router";
import { useSessionContext } from "../../auth/session";
import { SeverityBadge, StatusBadge, Tag } from "../../components/badges";
import { SlaClocks } from "../../components/SlaClock";
import { Alert, Card, Spinner } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { CHANNEL_LABEL, ENVIRONMENT_LABEL, INTAKE_LABEL } from "../../lib/labels";
import { can } from "../../lib/permissions";
import { useDirectory, useTicket, useTicketEvents } from "../../lib/queries";
import { friendlyError } from "../../lib/supabase";
import { useNow } from "../../lib/useNow";
import { PausesPanel } from "./PausesPanel";
import { QuarantinePanel } from "./QuarantinePanel";
import { RemoteAccessPanel } from "./RemoteAccessPanel";
import { TicketActions } from "./TicketActions";
import { Timeline } from "./Timeline";

export function TicketDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const ctx = useSessionContext();
  const ticket = useTicket(id);
  const events = useTicketEvents(id);
  const directory = useDirectory();
  const now = useNow(1000);

  if (ticket.isLoading) return <Spinner label="Cargando el ticket" />;
  if (ticket.error || !ticket.data) {
    return (
      <Alert>
        {ticket.error ? friendlyError(ticket.error) : "El ticket no existe o no tiene acceso a él."}
      </Alert>
    );
  }
  const t = ticket.data;
  const people = directory.data ?? [];
  const nameOf = (userId: string | null) =>
    userId ? (people.find((p) => p.user_id === userId)?.display_name ?? "—") : "—";
  const staff = people.filter((p) => p.is_staff);
  const created = (location.state as { creado?: string } | null)?.creado;

  return (
    <div className="flex flex-col gap-4">
      {created ? (
        <Alert tone="exito">
          Ticket {created} recibido. Yago fue avisado y los plazos del SLA ya corren.
        </Alert>
      ) : null}
      <div>
        <Link to={ctx.isStaff ? "/bandeja" : "/tickets"} className="text-sm text-blue-800 underline">
          Volver
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900">
            {t.number} · {t.title}
          </h1>
          <SeverityBadge severity={t.severity} long />
          <StatusBadge status={t.status} />
          {t.is_security_incident ? <Tag tone="peligro">Incidente de seguridad</Tag> : null}
          {t.intake_status !== "aceptado" ? <Tag tone="alerta">{INTAKE_LABEL[t.intake_status]}</Tag> : null}
        </div>
      </div>

      <Card title="Plazos del SLA">
        <SlaClocks clocks={t.clocks} now={now} />
        <p className="mt-2 text-xs text-slate-600">
          Clasificación: {t.classification_rule}
          {t.classification_source === "provisional" ? " (provisional)" : ""}.
        </p>
      </Card>

      {can(ctx, "quarantine:review") && t.intake_status === "cuarentena" ? (
        <QuarantinePanel ticket={t} directory={people} />
      ) : null}
      <TicketActions ticket={t} ctx={ctx} staff={staff} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card title="Descripción">
            <p className="whitespace-pre-wrap text-sm text-slate-900">
              {t.description || "Sin descripción."}
            </p>
          </Card>
          {events.isLoading ? <Spinner label="Cargando la línea de tiempo" /> : null}
          {events.error ? <Alert>{friendlyError(events.error)}</Alert> : null}
          {events.data ? <Timeline ticket={t} events={events.data} ctx={ctx} /> : null}
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Datos">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <dt className="text-slate-600">Organización</dt>
              <dd>{t.org?.name ?? "—"}</dd>
              <dt className="text-slate-600">Reportante</dt>
              <dd>{nameOf(t.reporter_id)}</dd>
              <dt className="text-slate-600">Responsable</dt>
              <dd>{nameOf(t.assignee_id)}</dd>
              <dt className="text-slate-600">Canal</dt>
              <dd>{CHANNEL_LABEL[t.channel]}</dd>
              <dt className="text-slate-600">Ambiente</dt>
              <dd>{ENVIRONMENT_LABEL[t.environment]}</dd>
              <dt className="text-slate-600">Categoría</dt>
              <dd>{t.category ?? "—"}</dd>
              <dt className="text-slate-600">Componente</dt>
              <dd>{t.component ?? "—"}</dd>
              <dt className="text-slate-600">Recibido</dt>
              <dd>{formatDateTime(t.created_at)}</dd>
              <dt className="text-slate-600">Acuse</dt>
              <dd>{formatDateTime(t.acknowledged_at)}</dd>
              <dt className="text-slate-600">Resuelto</dt>
              <dd>{formatDateTime(t.resolved_at)}</dd>
            </dl>
          </Card>
          <PausesPanel ticket={t} ctx={ctx} now={now} />
          <RemoteAccessPanel ticket={t} ctx={ctx} />
        </div>
      </div>
    </div>
  );
}
