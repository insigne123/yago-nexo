import { useState } from "react";
import { Tag } from "../../components/badges";
import { Alert, Button, Card, TextField } from "../../components/ui";
import { actions } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { REMOTE_STATUS_LABEL } from "../../lib/labels";
import { can, type SessionContext } from "../../lib/permissions";
import { ticketKeys } from "../../lib/queries";
import { useSupabase } from "../../lib/supabase";
import type { RemoteAccessRow, TicketDetail } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";

function RequestItem({
  request,
  ticket,
  ctx,
}: {
  request: RemoteAccessRow;
  ticket: TicketDetail;
  ctx: SessionContext;
}) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [note, setNote] = useState("");
  const [logRef, setLogRef] = useState(request.session_log_ref ?? "");
  const canDecide = can(ctx, "remote:decide", ticket.org_id) && request.status === "pendiente";
  const canRevoke =
    can(ctx, "remote:revoke", ticket.org_id) &&
    (request.status === "pendiente" || request.status === "habilitado");

  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{request.scope}</strong>
        <Tag
          tone={
            request.status === "pendiente" ? "alerta" : request.status === "habilitado" ? "info" : "neutro"
          }
        >
          {REMOTE_STATUS_LABEL[request.status]}
        </Tag>
      </div>
      <p className="mt-1 text-slate-700">{request.justification}</p>
      <p className="mt-1 text-xs text-slate-600">
        Solicitado {formatDateTime(request.requested_at)}
        {request.enabled_at ? ` · habilitado ${formatDateTime(request.enabled_at)}` : ""}
        {request.revoked_at ? ` · revocado ${formatDateTime(request.revoked_at)}` : ""}
      </p>
      {request.decision_note ? (
        <p className="mt-1 text-xs text-slate-600">Nota: {request.decision_note}</p>
      ) : null}
      {request.session_log_ref ? (
        <p className="mt-1 text-xs text-slate-600">Registro de la sesión: {request.session_log_ref}</p>
      ) : null}
      {canDecide ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
          <TextField label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () => actions.decideRemoteAccess(supabase, request.id, true, note.trim() || null),
                  "Acceso habilitado.",
                )
              }
            >
              Habilitar acceso
            </Button>
            <Button
              variant="peligro"
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () => actions.decideRemoteAccess(supabase, request.id, false, note.trim() || null),
                  "Acceso rechazado.",
                )
              }
            >
              Rechazar
            </Button>
          </div>
        </div>
      ) : null}
      {canRevoke ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
          <TextField
            label="Referencia del registro de la sesión"
            value={logRef}
            onChange={(e) => setLogRef(e.target.value)}
            help="Ubicación de la grabación o bitácora de la sesión remota."
          />
          <Button
            variant="secundario"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => actions.revokeRemoteAccess(supabase, request.id, logRef.trim() || null),
                "Acceso revocado.",
              )
            }
          >
            Revocar acceso
          </Button>
        </div>
      ) : null}
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </li>
  );
}

/** Solicitudes de acceso remoto (BT-065): mientras están pendientes, el reloj queda en pausa. */
export function RemoteAccessPanel({ ticket, ctx }: { ticket: TicketDetail; ctx: SessionContext }) {
  if (ticket.remote.length === 0) return null;
  const requests = [...ticket.remote].sort((a, b) => b.requested_at.localeCompare(a.requested_at));
  return (
    <Card title="Acceso remoto">
      <ul className="flex flex-col gap-3">
        {requests.map((r) => (
          <RequestItem key={r.id} request={r} ticket={ticket} ctx={ctx} />
        ))}
      </ul>
    </Card>
  );
}
