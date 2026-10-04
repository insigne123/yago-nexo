import { useState, type FormEvent } from "react";
import { Alert, Button, Card, SelectField, TextArea, TextField } from "../../components/ui";
import { actions, updateTicket } from "../../lib/api";
import { allowedTransitions, MANUAL_PAUSE_REASONS, PAUSE_REASON_LABEL, STATUS_LABEL } from "../../lib/labels";
import { can, type SessionContext } from "../../lib/permissions";
import { ticketKeys } from "../../lib/queries";
import { classify, toAnswers, type PartialAnswers } from "../../lib/severity";
import { useSupabase } from "../../lib/supabase";
import type { DirectoryEntry, PauseReason, TicketDetail, TicketStatus } from "../../lib/types";
import { useRunAction, type ActionState } from "../../lib/useAction";
import { SeverityWizard } from "../wizard/SeverityWizard";

function Feedback({ state }: { state: ActionState }) {
  if (state.error) return <Alert>{state.error}</Alert>;
  if (state.ok) return <Alert tone="exito">{state.ok}</Alert>;
  return null;
}

function StatusControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const options = allowedTransitions(ticket.status);
  const [next, setNext] = useState<TicketStatus | "">("");
  if (options.length === 0) return <p className="text-sm text-slate-600">El ticket está cerrado.</p>;
  const target = next || options[0]!;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void action.run(
          () => updateTicket(supabase, ticket.id, { status: target }),
          `Estado cambiado a ${STATUS_LABEL[target]}.`,
        );
      }}
    >
      <SelectField
        label="Cambiar estado"
        value={target}
        onChange={(e) => setNext(e.target.value as TicketStatus)}
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </SelectField>
      <Button type="submit" disabled={action.busy}>
        Cambiar estado
      </Button>
      <Feedback state={action} />
    </form>
  );
}

function AssignControl({
  ticket,
  staff,
  ctx,
}: {
  ticket: TicketDetail;
  staff: DirectoryEntry[];
  ctx: SessionContext;
}) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [assignee, setAssignee] = useState<string>(ticket.assignee_id ?? "");
  const assign = (userId: string | null) =>
    void action.run(
      () => updateTicket(supabase, ticket.id, { assignee_id: userId }),
      userId ? "Responsable asignado." : "Responsable quitado.",
    );
  return (
    <div className="flex flex-col gap-2">
      <SelectField label="Responsable" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">Sin responsable</option>
        {staff.map((s) => (
          <option key={s.user_id} value={s.user_id}>
            {s.display_name}
          </option>
        ))}
      </SelectField>
      <div className="flex flex-wrap gap-2">
        <Button disabled={action.busy} onClick={() => assign(assignee || null)}>
          Asignar
        </Button>
        {ticket.assignee_id !== ctx.userId ? (
          <Button variant="secundario" disabled={action.busy} onClick={() => assign(ctx.userId)}>
            Tomar el ticket
          </Button>
        ) : null}
      </div>
      <Feedback state={action} />
    </div>
  );
}

function PauseControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [reason, setReason] = useState<PauseReason>("infraestructura_subtel");
  const [justification, setJustification] = useState("");
  const [note, setNote] = useState("");
  const open = ticket.pauses.find((p) => !p.ended_at);

  if (open) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() => actions.resume(supabase, ticket.id, note.trim() || null), "Reloj reanudado.");
        }}
      >
        <p className="text-sm text-slate-700">
          Reloj en pausa por <strong>{PAUSE_REASON_LABEL[open.reason]}</strong>.
          {open.reason === "acceso_remoto_pendiente" ? " Reanudar retira la solicitud de acceso remoto." : ""}
        </p>
        <TextField
          label="Nota para la línea de tiempo (opcional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button type="submit" disabled={action.busy}>
          Reanudar reloj
        </Button>
        <Feedback state={action} />
      </form>
    );
  }
  const running = ticket.clocks.some((c) => c.status === "en_curso");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(
          () => actions.pause(supabase, ticket.id, reason, justification.trim()),
          "Reloj en pausa. SUBTEL fue avisada para acusarla.",
        );
      }}
    >
      <SelectField
        label="Motivo de la pausa"
        value={reason}
        onChange={(e) => setReason(e.target.value as PauseReason)}
      >
        {MANUAL_PAUSE_REASONS.map((r) => (
          <option key={r} value={r}>
            {PAUSE_REASON_LABEL[r]}
          </option>
        ))}
      </SelectField>
      <TextArea
        label="Justificación"
        value={justification}
        onChange={(e) => setJustification(e.target.value)}
        help="Visible para SUBTEL. Indique la evidencia (al menos 10 caracteres)."
        rows={3}
        required
      />
      <Button type="submit" disabled={action.busy || !running || justification.trim().length < 10}>
        Pausar reloj
      </Button>
      {!running ? <p className="text-xs text-slate-600">No hay plazos en curso que pausar.</p> : null}
      <Feedback state={action} />
    </form>
  );
}

function EscalateControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [level, setLevel] = useState("2");
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(
          () => actions.escalate(supabase, ticket.id, Number(level), reason.trim()),
          `Escalado al nivel ${level}.`,
        );
      }}
    >
      <SelectField label="Escalar al nivel de turno" value={level} onChange={(e) => setLevel(e.target.value)}>
        <option value="1">Nivel 1 · primer contacto</option>
        <option value="2">Nivel 2 · técnico de turno</option>
        <option value="3">Nivel 3 · seguridad y supervisión</option>
      </SelectField>
      <TextField label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <Button type="submit" variant="secundario" disabled={action.busy || reason.trim().length < 5}>
        Escalar
      </Button>
      <Feedback state={action} />
    </form>
  );
}

function RemoteAccessRequestControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [scope, setScope] = useState("");
  const [justification, setJustification] = useState("");
  if (ticket.remote.some((r) => r.status === "pendiente")) {
    return <p className="text-sm text-slate-700">Hay una solicitud de acceso remoto pendiente de SUBTEL.</p>;
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(
          () => actions.requestRemoteAccess(supabase, ticket.id, scope.trim(), justification.trim()),
          "Solicitud enviada. El reloj queda en pausa hasta que SUBTEL habilite el acceso.",
        );
      }}
    >
      <TextField
        label="Alcance del acceso remoto"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        help="Equipos o sistemas, tipo de acceso y duración. Por ejemplo: gw-02 por SSH durante 2 horas."
        required
      />
      <TextArea
        label="Justificación"
        value={justification}
        onChange={(e) => setJustification(e.target.value)}
        rows={2}
        required
      />
      <Button
        type="submit"
        variant="secundario"
        disabled={action.busy || scope.trim().length < 5 || justification.trim().length < 10}
      >
        Solicitar acceso remoto
      </Button>
      <Feedback state={action} />
    </form>
  );
}

function ReclassifyControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [answers, setAnswers] = useState<PartialAnswers>({});
  const [justification, setJustification] = useState("");
  const result = classify(answers);
  return (
    <details className="rounded-md border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">
        Reclasificar con el asistente
      </summary>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(
            () => actions.reclassify(supabase, ticket.id, toAnswers(answers), justification.trim()),
            "Ticket reclasificado; los plazos se recalcularon.",
          );
        }}
      >
        <SeverityWizard value={answers} onChange={setAnswers} />
        <TextArea
          label="Justificación de la reclasificación"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          help="Queda en la línea de tiempo pública."
          rows={2}
          required
        />
        <Button type="submit" disabled={action.busy || !result || justification.trim().length < 10}>
          Reclasificar
        </Button>
        <Feedback state={action} />
      </form>
    </details>
  );
}

function SecurityFlagControl({ ticket }: { ticket: TicketDetail }) {
  const supabase = useSupabase();
  const action = useRunAction([...ticketKeys(ticket.id), ["incidents"]]);
  if (ticket.is_security_incident) {
    return (
      <p className="text-sm text-slate-700">
        Marcado como incidente de seguridad (ver Incidentes de seguridad).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="peligro"
        disabled={action.busy}
        onClick={() =>
          void action.run(
            () => updateTicket(supabase, ticket.id, { is_security_incident: true }),
            "Incidente de seguridad registrado: corren los plazos de la Ley 21.663.",
          )
        }
      >
        Marcar como incidente de seguridad
      </Button>
      <Feedback state={action} />
    </div>
  );
}

/**
 * Ficha de trabajo del agente. Solo se muestra a agentes y supervisores de Yago (la base de
 * datos rechaza estas acciones para cualquier otra persona).
 */
export function TicketActions({
  ticket,
  ctx,
  staff,
}: {
  ticket: TicketDetail;
  ctx: SessionContext;
  staff: DirectoryEntry[];
}) {
  if (!can(ctx, "ticket:change_status") || ticket.intake_status !== "aceptado") return null;
  const closed = ticket.status === "cerrado";
  return (
    <Card title="Ficha de trabajo">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <StatusControl ticket={ticket} />
        {can(ctx, "ticket:assign") && !closed ? (
          <AssignControl ticket={ticket} staff={staff} ctx={ctx} />
        ) : null}
        {can(ctx, "ticket:pause") && !closed && ticket.status !== "resuelto" ? (
          <PauseControl ticket={ticket} />
        ) : null}
        {can(ctx, "ticket:escalate") && !closed ? <EscalateControl ticket={ticket} /> : null}
        {can(ctx, "remote:request") && !closed && ticket.status !== "resuelto" ? (
          <RemoteAccessRequestControl ticket={ticket} />
        ) : null}
        {can(ctx, "ticket:flag_security") && !closed ? <SecurityFlagControl ticket={ticket} /> : null}
      </div>
      {can(ctx, "ticket:reclassify") && !closed ? (
        <div className="mt-4">
          <ReclassifyControl ticket={ticket} />
        </div>
      ) : null}
    </Card>
  );
}
