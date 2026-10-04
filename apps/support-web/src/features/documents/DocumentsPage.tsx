import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useSessionContext } from "../../auth/session";
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
import { fetchPatches, fetchRcas, signedUrl } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { can } from "../../lib/permissions";
import { keys, useOrganizations, useTickets } from "../../lib/queries";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { RcaReportRow } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";
import { PatchList } from "../patches/PatchesPage";

function RcaItem({ rca, ticketNumber }: { rca: RcaReportRow; ticketNumber: string | undefined }) {
  const ctx = useSessionContext();
  const supabase = useSupabase();
  const action = useRunAction([keys.rcas]);
  const [error, setError] = useState<string | null>(null);
  async function download(path: string) {
    try {
      window.open(await signedUrl(supabase, path), "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(friendlyError(err));
    }
  }
  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{rca.title}</strong>
        <Tag tone={rca.status === "publicado" ? "info" : "neutro"}>
          {rca.status === "publicado" ? "Publicado" : "Borrador"}
        </Tag>
        <Link to={`/tickets/${rca.ticket_id}`} className="text-xs text-blue-800 underline">
          {ticketNumber ?? "Ver ticket"}
        </Link>
      </div>
      <p className="mt-1 text-slate-700">{rca.summary}</p>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-xs text-blue-800">Ver análisis completo</summary>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-xs text-slate-700">
          <div>
            <dt className="font-semibold">Causa raíz</dt>
            <dd className="whitespace-pre-wrap">{rca.root_cause}</dd>
          </div>
          {rca.timeline ? (
            <div>
              <dt className="font-semibold">Cronología</dt>
              <dd className="whitespace-pre-wrap">{rca.timeline}</dd>
            </div>
          ) : null}
          {rca.corrective_actions ? (
            <div>
              <dt className="font-semibold">Acciones correctivas</dt>
              <dd className="whitespace-pre-wrap">{rca.corrective_actions}</dd>
            </div>
          ) : null}
          {rca.preventive_actions ? (
            <div>
              <dt className="font-semibold">Acciones preventivas</dt>
              <dd className="whitespace-pre-wrap">{rca.preventive_actions}</dd>
            </div>
          ) : null}
        </dl>
      </details>
      <p className="mt-1 text-xs text-slate-600">
        {rca.published_at
          ? `Publicado ${formatDateTime(rca.published_at)}`
          : `Creado ${formatDateTime(rca.created_at)}`}
      </p>
      <div className="mt-2 flex gap-2">
        {rca.document_path ? (
          <Button variant="secundario" onClick={() => void download(rca.document_path as string)}>
            Descargar documento
          </Button>
        ) : null}
        {ctx.isStaff && rca.status === "borrador" ? (
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const { error: updateError } = await supabase
                  .from("nexo_sd_rca_reports")
                  .update({ status: "publicado" })
                  .eq("id", rca.id);
                if (updateError) throw new Error(updateError.message);
              }, "RCA publicado: la organización ya lo ve.")
            }
          >
            Publicar
          </Button>
        ) : null}
      </div>
      {error || action.error ? <Alert>{error ?? action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </li>
  );
}

function NewRcaForm() {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  const { data: tickets = [] } = useTickets(true);
  const action = useRunAction([keys.rcas]);
  const [form, setForm] = useState({
    ticket_id: "",
    title: "",
    summary: "",
    timeline: "",
    root_cause: "",
    corrective_actions: "",
    preventive_actions: "",
  });
  const candidates = tickets.filter(
    (t) => t.intake_status === "aceptado" && (t.severity === "S1" || t.severity === "S2"),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run(async () => {
      const { error } = await supabase.from("nexo_sd_rca_reports").insert({
        ticket_id: form.ticket_id,
        title: form.title.trim(),
        summary: form.summary.trim(),
        timeline: form.timeline.trim() || null,
        root_cause: form.root_cause.trim(),
        corrective_actions: form.corrective_actions.trim() || null,
        preventive_actions: form.preventive_actions.trim() || null,
      });
      if (error) throw new Error(error.message);
      await queryClient.invalidateQueries({ queryKey: keys.rcas });
    }, "RCA guardado como borrador.");
    if (ok)
      setForm({
        ticket_id: "",
        title: "",
        summary: "",
        timeline: "",
        root_cause: "",
        corrective_actions: "",
        preventive_actions: "",
      });
  }

  return (
    <Card title="Nuevo análisis de causa raíz (después de cada S1 o S2)">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3">
        <SelectField label="Ticket" value={form.ticket_id} onChange={set("ticket_id")} required>
          <option value="">Seleccione…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.number} · {t.severity} · {t.title}
            </option>
          ))}
        </SelectField>
        <TextField label="Título" value={form.title} onChange={set("title")} required />
        <TextArea label="Resumen" value={form.summary} onChange={set("summary")} rows={2} required />
        <TextArea label="Cronología" value={form.timeline} onChange={set("timeline")} rows={2} />
        <TextArea label="Causa raíz" value={form.root_cause} onChange={set("root_cause")} rows={2} required />
        <TextArea
          label="Acciones correctivas"
          value={form.corrective_actions}
          onChange={set("corrective_actions")}
          rows={2}
        />
        <TextArea
          label="Acciones preventivas"
          value={form.preventive_actions}
          onChange={set("preventive_actions")}
          rows={2}
        />
        <div>
          <Button
            type="submit"
            disabled={
              action.busy ||
              !form.ticket_id ||
              form.title.trim().length < 3 ||
              !form.summary.trim() ||
              !form.root_cause.trim()
            }
          >
            Guardar borrador
          </Button>
        </div>
      </form>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}

/** Documentos de la organización: análisis de causa raíz y paquetes de corrección. */
export function DocumentsPage() {
  const ctx = useSessionContext();
  const supabase = useSupabase();
  const rcas = useQuery({ queryKey: keys.rcas, queryFn: () => fetchRcas(supabase) });
  const patches = useQuery({ queryKey: keys.patches, queryFn: () => fetchPatches(supabase) });
  const { data: tickets = [] } = useTickets(true);
  const { data: orgs = [] } = useOrganizations();
  const orgNames = new Map(orgs.map((o) => [o.id, o.name]));
  const numbers = new Map(tickets.map((t) => [t.id, t.number]));
  const pendingApproval = (patches.data ?? []).filter(
    (p) => p.status === "pendiente_aprobacion" && can(ctx, "patch:approve", p.org_id),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageTitle description="Análisis de causa raíz publicados y paquetes de corrección con su plan de reversa.">
        Documentos
      </PageTitle>
      {pendingApproval.length > 0 ? (
        <Alert tone="alerta">
          Hay {pendingApproval.length} {pendingApproval.length === 1 ? "paquete" : "paquetes"} de corrección
          esperando su aprobación.
        </Alert>
      ) : null}
      {ctx.isStaff ? <NewRcaForm /> : null}
      <Card title="Análisis de causa raíz (RCA)">
        {rcas.isLoading ? <Spinner label="Cargando RCA" /> : null}
        {rcas.error ? <Alert>{friendlyError(rcas.error)}</Alert> : null}
        {rcas.data && rcas.data.length === 0 ? (
          <EmptyState>No hay análisis de causa raíz publicados.</EmptyState>
        ) : null}
        <ul className="flex flex-col gap-3">
          {(rcas.data ?? []).map((r) => (
            <RcaItem key={r.id} rca={r} ticketNumber={numbers.get(r.ticket_id)} />
          ))}
        </ul>
      </Card>
      <Card title="Paquetes de corrección">
        {patches.isLoading ? <Spinner label="Cargando paquetes" /> : null}
        {patches.error ? <Alert>{friendlyError(patches.error)}</Alert> : null}
        {patches.data ? <PatchList patches={patches.data} orgNames={orgNames} /> : null}
      </Card>
    </div>
  );
}
