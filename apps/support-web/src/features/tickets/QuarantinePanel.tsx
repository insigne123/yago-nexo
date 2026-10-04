import { useState } from "react";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import { actions } from "../../lib/api";
import { ticketKeys, useOrganizations } from "../../lib/queries";
import { classify, toAnswers, type PartialAnswers } from "../../lib/severity";
import { useSupabase } from "../../lib/supabase";
import type { DirectoryEntry, TicketDetail } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";
import { SeverityWizard } from "../wizard/SeverityWizard";

/** Revisión de un mensaje de remitente no registrado: aceptarlo (inicia el SLA) o descartarlo. */
export function QuarantinePanel({
  ticket,
  directory,
}: {
  ticket: TicketDetail;
  directory: DirectoryEntry[];
}) {
  const supabase = useSupabase();
  const { data: orgs = [] } = useOrganizations();
  const action = useRunAction([...ticketKeys(ticket.id)]);
  const [orgId, setOrgId] = useState("");
  const [reporterId, setReporterId] = useState("");
  const [answers, setAnswers] = useState<PartialAnswers>({});
  const [reason, setReason] = useState("");
  const result = classify(answers);
  const reporters = directory.filter(
    (d) => d.org_id === orgId && (d.role === "reportante" || d.role === "contraparte"),
  );

  return (
    <Card title="Mensaje en cuarentena">
      <p className="mb-3 text-sm text-slate-700">
        Llegó por {ticket.channel === "whatsapp" ? "WhatsApp" : "correo"} desde{" "}
        <strong>{ticket.channel_sender ?? "remitente desconocido"}</strong>, que no está registrado. El SLA
        empieza a correr cuando se acepta.
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              () =>
                actions.acceptQuarantine(
                  supabase,
                  ticket.id,
                  orgId,
                  reporterId || null,
                  result ? toAnswers(answers) : null,
                ),
              "Ticket aceptado: corren los plazos del SLA.",
            );
          }}
        >
          <SelectField label="Organización" value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
            <option value="">Seleccione…</option>
            {orgs
              .filter((o) => !o.is_provider && o.active)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </SelectField>
          <SelectField label="Reportante" value={reporterId} onChange={(e) => setReporterId(e.target.value)}>
            <option value="">Sin reportante registrado</option>
            {reporters.map((r) => (
              <option key={r.user_id} value={r.user_id}>
                {r.display_name}
              </option>
            ))}
          </SelectField>
          <details className="rounded-md border border-slate-200 p-2">
            <summary className="cursor-pointer text-sm font-semibold">
              Clasificar con el asistente (si no, queda la severidad provisional)
            </summary>
            <div className="mt-2">
              <SeverityWizard value={answers} onChange={setAnswers} />
            </div>
          </details>
          <Button type="submit" disabled={action.busy || !orgId}>
            Aceptar como ticket
          </Button>
        </form>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              () => actions.discardQuarantine(supabase, ticket.id, reason.trim()),
              "Mensaje descartado.",
            );
          }}
        >
          <TextField
            label="Motivo del descarte"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          <Button type="submit" variant="peligro" disabled={action.busy || reason.trim().length < 5}>
            Descartar
          </Button>
        </form>
      </div>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}
