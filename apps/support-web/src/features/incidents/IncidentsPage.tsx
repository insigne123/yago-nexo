import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Tag } from "../../components/badges";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageTitle,
  SelectField,
  Spinner,
  TextArea,
  TextField,
} from "../../components/ui";
import { createIncident, fetchIncidents, fetchSettings, updateIncident } from "../../lib/api";
import { formatDateTime, fromDatetimeLocal, toDatetimeLocal } from "../../lib/format";
import { keys, useOrganizations } from "../../lib/queries";
import { formatDuration } from "../../lib/sla";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { SecurityIncidentRow } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";
import { useNow } from "../../lib/useNow";

type Milestone = "early_alert_sent_at" | "second_report_at" | "final_report_at";

const MILESTONES: Array<{ field: Milestone; due: keyof SecurityIncidentRow; label: string; base: string }> = [
  {
    field: "early_alert_sent_at",
    due: "early_alert_due_at",
    label: "Alerta temprana al CSIRT",
    base: "desde que se toma conocimiento",
  },
  {
    field: "second_report_at",
    due: "second_report_due_at",
    label: "Segundo reporte",
    base: "desde que se toma conocimiento",
  },
  {
    field: "final_report_at",
    due: "final_report_due_at",
    label: "Informe final",
    base: "desde la alerta temprana",
  },
];

const CLASSIFICATION_LABEL: Record<SecurityIncidentRow["classification"], string> = {
  por_clasificar: "Por clasificar",
  significativo: "Con efecto significativo",
  no_significativo: "Sin efecto significativo",
};

function MilestoneRow({
  incident,
  milestone,
  now,
}: {
  incident: SecurityIncidentRow;
  milestone: (typeof MILESTONES)[number];
  now: Date;
}) {
  const supabase = useSupabase();
  const action = useRunAction([keys.incidents]);
  const done = incident[milestone.field];
  const due = new Date(String(incident[milestone.due]));
  const remaining = (due.getTime() - now.getTime()) / 1000;
  const notApplicable = incident.classification === "no_significativo";
  return (
    <tr className="align-top">
      <th scope="row" className="px-2 py-2 text-left font-medium">
        {milestone.label}
        <div className="text-xs font-normal text-slate-500">{milestone.base}</div>
      </th>
      <td className="px-2 py-2">{formatDateTime(due)}</td>
      <td className="px-2 py-2">
        {done ? (
          <Tag tone="info">{`Enviado ${formatDateTime(done)}`}</Tag>
        ) : notApplicable ? (
          <Tag>No aplica</Tag>
        ) : remaining > 0 ? (
          <span className={remaining < 3600 ? "font-semibold text-amber-800" : ""}>
            Quedan {formatDuration(remaining)}
          </span>
        ) : (
          <span className="font-semibold text-red-700">Vencido hace {formatDuration(remaining)}</span>
        )}
      </td>
      <td className="px-2 py-2">
        {!done && incident.status === "abierto" ? (
          <Button
            variant="secundario"
            className="text-xs"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => updateIncident(supabase, incident.id, { [milestone.field]: new Date().toISOString() }),
                "Envío registrado.",
              )
            }
          >
            Registrar envío ahora
          </Button>
        ) : null}
        {action.error ? <Alert>{action.error}</Alert> : null}
      </td>
    </tr>
  );
}

function IncidentCard({ incident, now }: { incident: SecurityIncidentRow; now: Date }) {
  const supabase = useSupabase();
  const action = useRunAction([keys.incidents]);
  const [csirt, setCsirt] = useState(incident.csirt_reference ?? "");
  const [classification, setClassification] = useState(incident.classification);
  return (
    <Card
      title={incident.title}
      actions={
        <div className="flex items-center gap-2">
          <Tag tone={incident.status === "abierto" ? "peligro" : "neutro"}>
            {incident.status === "abierto" ? "Abierto" : "Cerrado"}
          </Tag>
          {incident.ticket_id ? (
            <Link to={`/tickets/${incident.ticket_id}`} className="text-sm text-blue-800 underline">
              Ver ticket
            </Link>
          ) : null}
        </div>
      }
    >
      <p className="text-sm text-slate-700">
        Detectado {formatDateTime(incident.detected_at)}
        {incident.affected_services.length
          ? ` · Servicios afectados: ${incident.affected_services.join(", ")}`
          : ""}
      </p>
      {incident.description ? (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{incident.description}</p>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Hitos de la Ley 21.663</caption>
          <thead className="text-left text-xs font-semibold uppercase text-slate-600">
            <tr>
              <th scope="col" className="px-2 py-1">
                Hito
              </th>
              <th scope="col" className="px-2 py-1">
                Vence
              </th>
              <th scope="col" className="px-2 py-1">
                Estado
              </th>
              <th scope="col" className="px-2 py-1">
                Acción
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {MILESTONES.map((m) => (
              <MilestoneRow key={m.field} incident={incident} milestone={m} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(
            () =>
              updateIncident(supabase, incident.id, {
                csirt_reference: csirt.trim() || null,
                classification,
              }),
            "Incidente actualizado.",
          );
        }}
      >
        <SelectField
          label="Clasificación"
          value={classification}
          onChange={(e) => setClassification(e.target.value as SecurityIncidentRow["classification"])}
        >
          {Object.entries(CLASSIFICATION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField label="Referencia del CSIRT" value={csirt} onChange={(e) => setCsirt(e.target.value)} />
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={action.busy}>
            Guardar
          </Button>
          {incident.status === "abierto" ? (
            <Button
              variant="secundario"
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () => updateIncident(supabase, incident.id, { status: "cerrado" }),
                  "Incidente cerrado.",
                )
              }
            >
              Cerrar incidente
            </Button>
          ) : null}
        </div>
      </form>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}

function NewIncidentForm() {
  const supabase = useSupabase();
  const { data: orgs = [] } = useOrganizations();
  const action = useRunAction([keys.incidents]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [detected, setDetected] = useState(() => toDatetimeLocal(new Date()));
  const [services, setServices] = useState("");
  const [orgId, setOrgId] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run(
      () =>
        createIncident(supabase, {
          title: title.trim(),
          description: description.trim() || null,
          detected_at: fromDatetimeLocal(detected) ?? new Date().toISOString(),
          affected_services: services
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          org_id: orgId || null,
          ticket_id: null,
        }),
      "Incidente registrado: se avisó al nivel 3 y corren los plazos.",
    );
    if (ok) {
      setTitle("");
      setDescription("");
      setServices("");
    }
  }

  return (
    <Card title="Registrar incidente">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Título" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <SelectField label="Organización afectada" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          <option value="">Sin organización</option>
          {orgs
            .filter((o) => !o.is_provider)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </SelectField>
        <TextField
          label="Detectado (toma de conocimiento)"
          type="datetime-local"
          value={detected}
          onChange={(e) => setDetected(e.target.value)}
          required
        />
        <TextField
          label="Servicios afectados"
          value={services}
          onChange={(e) => setServices(e.target.value)}
          help="Separados por comas."
        />
        <div className="sm:col-span-2">
          <TextArea
            label="Descripción"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" variant="peligro" disabled={action.busy || title.trim().length < 3}>
            Registrar incidente
          </Button>
        </div>
      </form>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}

/** Panel de incidentes de seguridad con los hitos de reporte de la Ley 21.663. */
export function IncidentsPage() {
  const supabase = useSupabase();
  const now = useNow(1000);
  const incidents = useQuery({ queryKey: keys.incidents, queryFn: () => fetchIncidents(supabase) });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchSettings(supabase),
    staleTime: 10 * 60_000,
  });
  const open = (incidents.data ?? []).filter((i) => i.status === "abierto");
  const closed = (incidents.data ?? []).filter((i) => i.status === "cerrado");

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        description={
          settings.data
            ? `Plazos configurados: alerta temprana ${settings.data.security_early_alert_hours} horas, segundo reporte ${settings.data.security_second_report_hours} horas e informe final ${settings.data.security_final_report_days} días. Verificar con el procedimiento institucional.`
            : "Hitos de reporte de la Ley 21.663."
        }
      >
        Incidentes de seguridad
      </PageTitle>
      <NewIncidentForm />
      {incidents.isLoading ? <Spinner label="Cargando incidentes" /> : null}
      {incidents.error ? <Alert>{friendlyError(incidents.error)}</Alert> : null}
      {!incidents.isLoading && open.length === 0 ? (
        <EmptyState>No hay incidentes abiertos.</EmptyState>
      ) : null}
      {open.map((i) => (
        <IncidentCard key={i.id} incident={i} now={now} />
      ))}
      {closed.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            Incidentes cerrados ({closed.length})
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {closed.map((i) => (
              <IncidentCard key={i.id} incident={i} now={now} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
