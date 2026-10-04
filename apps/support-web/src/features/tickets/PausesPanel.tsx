import { useState } from "react";
import { Tag } from "../../components/badges";
import { Alert, Button, Card, EmptyState, TextField } from "../../components/ui";
import { actions } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { PAUSE_REASON_LABEL } from "../../lib/labels";
import { can, type SessionContext } from "../../lib/permissions";
import { ticketKeys } from "../../lib/queries";
import { formatDuration } from "../../lib/sla";
import { useSupabase } from "../../lib/supabase";
import type { PauseRow, TicketDetail } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";

function AcknowledgeForm({ pause, ticketId }: { pause: PauseRow; ticketId: string }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticketId));
  const [note, setNote] = useState("");
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
      <TextField
        label="Comentario para Yago (obligatorio si objeta)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(
              () => actions.acknowledgePause(supabase, pause.id, true, note.trim() || null),
              "Pausa acusada.",
            )
          }
        >
          Acusar pausa
        </Button>
        <Button
          variant="peligro"
          disabled={action.busy || note.trim().length < 10}
          onClick={() =>
            void action.run(
              () => actions.acknowledgePause(supabase, pause.id, false, note.trim()),
              "Pausa objetada.",
            )
          }
        >
          Objetar pausa
        </Button>
      </div>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </div>
  );
}

/** Pausas del reloj: motivo tipificado, justificación, duración y acuse de SUBTEL (BT-061). */
export function PausesPanel({ ticket, ctx, now }: { ticket: TicketDetail; ctx: SessionContext; now: Date }) {
  const pauses = [...ticket.pauses].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const canAck = can(ctx, "pause:acknowledge", ticket.org_id);
  return (
    <Card title="Pausas del reloj">
      {pauses.length === 0 ? <EmptyState>El reloj de este ticket no se ha pausado.</EmptyState> : null}
      <ul className="flex flex-col gap-3">
        {pauses.map((p) => {
          const end = p.ended_at ? new Date(p.ended_at) : now;
          const seconds = (end.getTime() - new Date(p.started_at).getTime()) / 1000;
          return (
            <li key={p.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{PAUSE_REASON_LABEL[p.reason]}</strong>
                {p.ended_at ? <Tag>Cerrada</Tag> : <Tag tone="alerta">En curso</Tag>}
                {p.subtel_ack_status === "aceptada" ? <Tag tone="info">Acusada por SUBTEL</Tag> : null}
                {p.subtel_ack_status === "objetada" ? <Tag tone="peligro">Objetada por SUBTEL</Tag> : null}
                {!p.subtel_ack_status ? <Tag>Sin acuse de SUBTEL</Tag> : null}
              </div>
              <p className="mt-1 text-slate-700">{p.justification}</p>
              <p className="mt-1 text-xs text-slate-600">
                Desde {formatDateTime(p.started_at)}
                {p.ended_at ? ` hasta ${formatDateTime(p.ended_at)}` : ""} · {formatDuration(seconds)}
              </p>
              {p.subtel_ack_note ? (
                <p className="mt-1 text-xs text-slate-600">Nota de SUBTEL: {p.subtel_ack_note}</p>
              ) : null}
              {canAck && !p.subtel_ack_at ? <AcknowledgeForm pause={p} ticketId={ticket.id} /> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
