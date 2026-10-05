import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
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
import { actions, createPatch, fetchPatches, setPatchStatus } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { PATCH_STATUS_LABEL } from "../../lib/labels";
import { can } from "../../lib/permissions";
import { keys, useOrganizations } from "../../lib/queries";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { PatchPackageRow, PatchStatus } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";

const NEXT_STATUS: Partial<Record<PatchStatus, { to: PatchStatus; label: string }[]>> = {
  borrador: [{ to: "pendiente_aprobacion", label: "Enviar a aprobación" }],
  pendiente_aprobacion: [{ to: "borrador", label: "Volver a borrador" }],
  rechazado: [{ to: "borrador", label: "Volver a borrador" }],
  aprobado: [{ to: "aplicado", label: "Marcar como aplicado" }],
  aplicado: [{ to: "revertido", label: "Registrar reversa" }],
};

const patchSchema = z.object({
  org_id: z.uuid({ error: "Seleccione la organización" }),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, "Use versionado semántico, por ejemplo 1.0.2"),
  title: z.string().trim().min(3, "Mínimo 3 caracteres").max(200),
  description: z.string().trim().min(5, "Describa el cambio"),
  rollback_plan: z.string().trim().min(10, "El plan de reversa es obligatorio (mínimo 10 caracteres)"),
  artifact_path: z.string().trim().nullable(),
  checksum_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "SHA-256 en hexadecimal (64 caracteres)")
    .nullable(),
});

function PatchItem({ patch, orgName }: { patch: PatchPackageRow; orgName: string }) {
  const ctx = useSessionContext();
  const supabase = useSupabase();
  const action = useRunAction([keys.patches]);
  const [note, setNote] = useState("");
  const canDecide =
    can(ctx, "patch:approve", patch.org_id) &&
    patch.status === "pendiente_aprobacion" &&
    patch.created_by !== ctx.userId;
  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong>
          {patch.version} · {patch.title}
        </strong>
        <Tag
          tone={
            patch.status === "aprobado" || patch.status === "aplicado"
              ? "info"
              : patch.status === "rechazado"
                ? "peligro"
                : "neutro"
          }
        >
          {PATCH_STATUS_LABEL[patch.status]}
        </Tag>
        <span className="text-xs text-slate-600">{orgName}</span>
      </div>
      <p className="mt-1 text-slate-700">{patch.description}</p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-blue-800">Plan de reversa</summary>
        <p className="mt-1 whitespace-pre-wrap text-xs text-slate-700">{patch.rollback_plan}</p>
      </details>
      <p className="mt-1 text-xs text-slate-600">
        Creado {formatDateTime(patch.created_at)}
        {patch.approved_at ? ` · decidido ${formatDateTime(patch.approved_at)}` : ""}
        {patch.applied_at ? ` · aplicado ${formatDateTime(patch.applied_at)}` : ""}
        {patch.rolled_back_at ? ` · revertido ${formatDateTime(patch.rolled_back_at)}` : ""}
        {patch.checksum_sha256 ? ` · SHA-256 ${patch.checksum_sha256.slice(0, 12)}…` : ""}
      </p>
      {patch.approval_note ? (
        <p className="mt-1 text-xs text-slate-600">Nota de aprobación: {patch.approval_note}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {can(ctx, "patch:manage")
          ? (NEXT_STATUS[patch.status] ?? []).map((n) => (
              <Button
                key={n.to}
                variant="secundario"
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => setPatchStatus(supabase, patch.id, n.to),
                    `Paquete: ${PATCH_STATUS_LABEL[n.to]}.`,
                  )
                }
              >
                {n.label}
              </Button>
            ))
          : null}
      </div>
      {canDecide ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
          <TextField
            label="Nota de la decisión (obligatoria si rechaza)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () => actions.decidePatch(supabase, patch.id, true, note.trim() || null),
                  "Paquete aprobado.",
                )
              }
            >
              Aprobar
            </Button>
            <Button
              variant="peligro"
              disabled={action.busy || note.trim().length < 5}
              onClick={() =>
                void action.run(
                  () => actions.decidePatch(supabase, patch.id, false, note.trim()),
                  "Paquete rechazado.",
                )
              }
            >
              Rechazar
            </Button>
          </div>
        </div>
      ) : null}
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </li>
  );
}

/** Lista de paquetes de corrección (la usan Yago y, en Documentos, el cliente). */
export function PatchList({
  patches,
  orgNames,
}: {
  patches: PatchPackageRow[];
  orgNames: Map<string, string>;
}) {
  if (patches.length === 0) return <EmptyState>No hay paquetes de corrección.</EmptyState>;
  return (
    <ul className="flex flex-col gap-3">
      {patches.map((p) => (
        <PatchItem key={p.id} patch={p} orgName={orgNames.get(p.org_id) ?? ""} />
      ))}
    </ul>
  );
}

function NewPatchForm() {
  const supabase = useSupabase();
  const { data: orgs = [] } = useOrganizations();
  const action = useRunAction([keys.patches]);
  const [form, setForm] = useState({
    org_id: "",
    version: "",
    title: "",
    description: "",
    rollback_plan: "",
    artifact_path: "",
    checksum_sha256: "",
  });
  const [submit, setSubmit] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = patchSchema.safeParse({
      ...form,
      artifact_path: form.artifact_path.trim() || null,
      checksum_sha256: form.checksum_sha256.trim().toLowerCase() || null,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    const ok = await action.run(
      () =>
        createPatch(supabase, {
          ...parsed.data,
          ticket_id: null,
          status: submit ? "pendiente_aprobacion" : "borrador",
        }),
      submit ? "Paquete enviado a aprobación." : "Paquete guardado como borrador.",
    );
    if (ok)
      setForm({
        org_id: "",
        version: "",
        title: "",
        description: "",
        rollback_plan: "",
        artifact_path: "",
        checksum_sha256: "",
      });
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  return (
    <Card title="Nuevo paquete de corrección">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2" noValidate>
        <SelectField
          label="Organización"
          value={form.org_id}
          onChange={set("org_id")}
          error={errors["org_id"]}
          required
        >
          <option value="">Seleccione…</option>
          {orgs
            .filter((o) => !o.is_provider)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </SelectField>
        <TextField
          label="Versión"
          value={form.version}
          onChange={set("version")}
          error={errors["version"]}
          placeholder="1.0.2"
          required
        />
        <div className="sm:col-span-2">
          <TextField
            label="Título"
            value={form.title}
            onChange={set("title")}
            error={errors["title"]}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <TextArea
            label="Descripción"
            value={form.description}
            onChange={set("description")}
            error={errors["description"]}
            rows={3}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <TextArea
            label="Plan de reversa"
            value={form.rollback_plan}
            onChange={set("rollback_plan")}
            error={errors["rollback_plan"]}
            help="Cómo se vuelve a la versión anterior si algo falla (BT-054)."
            rows={3}
            required
          />
        </div>
        <TextField label="Ruta del artefacto" value={form.artifact_path} onChange={set("artifact_path")} />
        <TextField
          label="SHA-256 del artefacto"
          value={form.checksum_sha256}
          onChange={set("checksum_sha256")}
          error={errors["checksum_sha256"]}
        />
        <label className="inline-flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={submit}
            onChange={(e) => setSubmit(e.target.checked)}
            className="h-4 w-4"
          />
          Enviar a aprobación al guardar
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={action.busy}>
            Guardar paquete
          </Button>
        </div>
      </form>
      {action.error ? <Alert>{action.error}</Alert> : null}
      {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
    </Card>
  );
}

export function PatchesPage() {
  const supabase = useSupabase();
  const patches = useQuery({ queryKey: keys.patches, queryFn: () => fetchPatches(supabase) });
  const { data: orgs = [] } = useOrganizations();
  const orgNames = new Map(orgs.map((o) => [o.id, o.name]));
  return (
    <div className="flex flex-col gap-4">
      <PageTitle description="Cada paquete lleva su plan de reversa y lo aprueba la contraparte o un supervisor distinto de quien lo preparó.">
        Paquetes de corrección
      </PageTitle>
      <NewPatchForm />
      <Card title="Paquetes">
        {patches.isLoading ? <Spinner label="Cargando paquetes" /> : null}
        {patches.error ? <Alert>{friendlyError(patches.error)}</Alert> : null}
        {patches.data ? <PatchList patches={patches.data} orgNames={orgNames} /> : null}
      </Card>
    </div>
  );
}
