import { useRef, useState, type FormEvent } from "react";
import { Tag } from "../../components/badges";
import { Alert, Button, Card, EmptyState, TextArea } from "../../components/ui";
import { addComment, signedUrl, uploadAttachment } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { EVENT_LABEL, PAUSE_REASON_LABEL, REMOTE_STATUS_LABEL, STATUS_LABEL } from "../../lib/labels";
import { can, type SessionContext } from "../../lib/permissions";
import { ticketKeys } from "../../lib/queries";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type {
  PauseReason,
  RemoteAccessStatus,
  TicketDetail,
  TicketEventRow,
  TicketStatus,
  Visibility,
} from "../../lib/types";
import { useRunAction } from "../../lib/useAction";

const MAX_BYTES = 25 * 1024 * 1024;

function eventText(event: TicketEventRow): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "status_change":
      if (p["de"] && p["a"]) {
        return `Estado: ${STATUS_LABEL[p["de"] as TicketStatus] ?? String(p["de"])} → ${STATUS_LABEL[p["a"] as TicketStatus] ?? String(p["a"])}`;
      }
      return event.body ?? "Cambio de estado";
    case "pause":
      if (p["acuse_cliente"])
        return `El cliente ${p["acuse_cliente"] === "aceptada" ? "acusó" : "objetó"} la pausa`;
      return `Reloj en pausa: ${PAUSE_REASON_LABEL[p["motivo"] as PauseReason] ?? String(p["motivo"] ?? "")}`;
    case "resume":
      return "Reloj reanudado";
    case "assignment":
      return p["nombre"] ? `Responsable: ${String(p["nombre"])}` : "Sin responsable";
    case "reclassification":
      return `Reclasificado de ${String(p["de"])} a ${String(p["a"])}: ${String(p["regla"] ?? "")}`;
    case "remote_access":
      return `Acceso remoto: ${REMOTE_STATUS_LABEL[p["estado"] as RemoteAccessStatus] ?? String(p["estado"] ?? "")}`;
    default:
      return EVENT_LABEL[event.type];
  }
}

function AttachmentLink({ path, name }: { path: string; name: string }) {
  const supabase = useSupabase();
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setError(null);
    try {
      window.open(await signedUrl(supabase, path, name), "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(friendlyError(err));
    }
  }
  return (
    <span>
      <Button variant="fantasma" className="px-1 py-0" onClick={() => void open()}>
        Descargar {name}
      </Button>
      {error ? <span className="text-xs text-red-700"> {error}</span> : null}
    </span>
  );
}

function CommentForm({ ticket, ctx }: { ticket: TicketDetail; ctx: SessionContext }) {
  const supabase = useSupabase();
  const action = useRunAction(ticketKeys(ticket.id));
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const canInternal = can(ctx, "ticket:note_internal");
  const visibility: Visibility = canInternal && internal ? "interno" : "publico";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text && !file) return;
    if (file && file.size > MAX_BYTES) {
      await action.run(() => Promise.reject(new Error("El archivo supera los 25 MB")), "");
      return;
    }
    const ok = await action.run(
      async () => {
        if (text) await addComment(supabase, ticket.id, text, visibility);
        if (file) await uploadAttachment(supabase, ticket.id, file, visibility);
      },
      visibility === "interno" ? "Nota interna agregada." : "Comentario agregado.",
    );
    if (ok) {
      setBody("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 border-t border-slate-200 pt-4">
      <TextArea
        label={visibility === "interno" ? "Nota interna" : "Comentario"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        help={
          visibility === "interno"
            ? "Solo la ven agentes y supervisores de Yago."
            : "Visible para la organización y para Yago."
        }
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="adjunto" className="text-sm font-medium text-slate-800">
          Adjunto (opcional, máximo 25 MB)
        </label>
        <input
          id="adjunto"
          ref={fileInput}
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.log,.csv,.json,.xml,.zip,.gz,.docx,.xlsx"
          className="text-sm"
        />
      </div>
      {canInternal ? (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
            className="h-4 w-4"
          />
          Nota interna (no visible para el cliente)
        </label>
      ) : null}
      <div>
        <Button type="submit" disabled={action.busy || (!body.trim() && !file)}>
          {action.busy ? "Guardando…" : "Agregar"}
        </Button>
      </div>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </form>
  );
}

/** Línea de tiempo del ticket (las notas internas solo llegan a quien puede verlas). */
export function Timeline({
  ticket,
  events,
  ctx,
}: {
  ticket: TicketDetail;
  events: TicketEventRow[];
  ctx: SessionContext;
}) {
  const canComment =
    can(ctx, "ticket:comment", ticket.org_id) && (ticket.status !== "cerrado" || ctx.isStaff);
  return (
    <Card title="Línea de tiempo">
      {events.length === 0 ? <EmptyState>Sin eventos.</EmptyState> : null}
      <ol className="flex flex-col gap-3">
        {events.map((e) => {
          const path = typeof e.payload?.["path"] === "string" ? (e.payload["path"] as string) : null;
          return (
            <li
              key={e.id}
              className={`rounded-md border p-3 text-sm ${e.visibility === "interno" ? "border-amber-200 bg-amber-50" : "border-slate-200"}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">{e.author_name ?? "Sistema"}</span>
                <span>{formatDateTime(e.created_at)}</span>
                <Tag>{EVENT_LABEL[e.type]}</Tag>
                {e.visibility === "interno" ? <Tag tone="alerta">Interno</Tag> : null}
              </div>
              {e.type === "comment" ? (
                <p className="mt-1 whitespace-pre-wrap text-slate-900">{e.body}</p>
              ) : e.type === "attachment" && path ? (
                <p className="mt-1">
                  <AttachmentLink path={path} name={String(e.payload["name"] ?? e.body ?? "adjunto")} />
                </p>
              ) : (
                <>
                  <p className="mt-1 text-slate-900">{eventText(e)}</p>
                  {e.body && e.type !== "status_change" ? (
                    <p className="mt-1 whitespace-pre-wrap text-slate-700">{e.body}</p>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {canComment ? <CommentForm ticket={ticket} ctx={ctx} /> : null}
    </Card>
  );
}
