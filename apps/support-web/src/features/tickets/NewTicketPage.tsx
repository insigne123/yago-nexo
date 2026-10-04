import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { useSessionContext } from "../../auth/session";
import { Alert, Button, Card, PageTitle, SelectField, TextArea, TextField } from "../../components/ui";
import { createTicket } from "../../lib/api";
import { CATEGORY_OPTIONS, ENVIRONMENT_LABEL } from "../../lib/labels";
import { ticketOrgs } from "../../lib/permissions";
import { useDirectory, useOrganizations } from "../../lib/queries";
import { classify, toAnswers, type PartialAnswers } from "../../lib/severity";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { Environment } from "../../lib/types";
import { SeverityWizard } from "../wizard/SeverityWizard";

const ticketSchema = z.object({
  orgId: z.uuid({ error: "Seleccione la organización" }),
  title: z
    .string()
    .trim()
    .min(3, "El título debe tener al menos 3 caracteres")
    .max(200, "Máximo 200 caracteres"),
  description: z
    .string()
    .trim()
    .min(10, "Describa el problema con al menos 10 caracteres")
    .max(20000, "Máximo 20.000 caracteres"),
  environment: z.enum(["prod", "qa", "dev"]),
  category: z.string().nullable(),
  component: z.string().trim().max(120, "Máximo 120 caracteres").nullable(),
});

export function NewTicketPage() {
  const ctx = useSessionContext();
  const supabase = useSupabase();
  const navigate = useNavigate();
  const { data: allOrgs = [] } = useOrganizations(ctx.isStaff);
  const { data: directory = [] } = useDirectory(ctx.isStaff);

  const orgOptions = ctx.isStaff
    ? allOrgs.filter((o) => !o.is_provider && o.active).map((o) => ({ id: o.id, name: o.name }))
    : ticketOrgs(ctx).map((m) => ({ id: m.orgId, name: m.orgName }));

  const [orgId, setOrgId] = useState<string>("");
  const [reporterId, setReporterId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState<Environment>("prod");
  const [category, setCategory] = useState<string>("");
  const [component, setComponent] = useState("");
  const [isSecurity, setIsSecurity] = useState(false);
  const [answers, setAnswers] = useState<PartialAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedOrg = orgId || (orgOptions.length === 1 ? (orgOptions[0]?.id ?? "") : "");
  const result = classify(answers);
  const reporters = directory.filter(
    (d) => d.org_id === selectedOrg && (d.role === "reportante" || d.role === "contraparte"),
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = ticketSchema.safeParse({
      orgId: selectedOrg,
      title,
      description,
      environment,
      category: category || null,
      component: component.trim() || null,
    });
    const nextErrors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) nextErrors[String(issue.path[0])] ??= issue.message;
    }
    if (!result) nextErrors["wizard"] = "Responda las preguntas del asistente de severidad";
    setErrors(nextErrors);
    if (!parsed.success || !result) return;

    setBusy(true);
    setError(null);
    try {
      const created = await createTicket(supabase, {
        ...parsed.data,
        isSecurityIncident: isSecurity,
        answers: toAnswers(answers),
        reporterId: ctx.isStaff && reporterId ? reporterId : null,
      });
      navigate(`/tickets/${created.id}`, { state: { creado: created.number } });
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle description="La mesa recibe tickets de todas las severidades las 24 horas, todos los días del año.">
        Nuevo ticket
      </PageTitle>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <Card title="1. Describa el problema">
          <div className="flex flex-col gap-3">
            {orgOptions.length > 1 || ctx.isStaff ? (
              <SelectField
                label="Organización"
                value={selectedOrg}
                onChange={(e) => {
                  setOrgId(e.target.value);
                  setReporterId("");
                }}
                error={errors["orgId"]}
                required
              >
                <option value="">Seleccione…</option>
                {orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            {ctx.isStaff ? (
              <SelectField
                label="Reportante (si el ticket llegó por teléfono)"
                value={reporterId}
                onChange={(e) => setReporterId(e.target.value)}
                help="Opcional. Debe pertenecer a la organización seleccionada."
              >
                <option value="">Sin reportante registrado</option>
                {reporters.map((r) => (
                  <option key={r.user_id} value={r.user_id}>
                    {r.display_name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            <TextField
              label="Título"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={errors["title"]}
              maxLength={200}
              required
            />
            <TextArea
              label="Descripción"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              error={errors["description"]}
              help="Qué ocurre, desde cuándo, qué APIs o integraciones están afectadas y qué mensajes de error aparecen. No incluya contraseñas ni datos personales."
              rows={6}
              required
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SelectField
                label="Ambiente"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as Environment)}
              >
                {(Object.keys(ENVIRONMENT_LABEL) as Environment[]).map((env) => (
                  <option key={env} value={env}>
                    {ENVIRONMENT_LABEL[env]}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Categoría" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Sin categoría</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Componente"
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                error={errors["component"]}
                placeholder="Por ejemplo: Gateway"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isSecurity}
                onChange={(e) => setIsSecurity(e.target.checked)}
                className="h-4 w-4 accent-blue-800"
              />
              Es (o puede ser) un incidente de ciberseguridad
            </label>
          </div>
        </Card>
        <Card title="2. Asistente de severidad">
          <SeverityWizard value={answers} onChange={setAnswers} />
          {errors["wizard"] ? (
            <p className="mt-2 text-xs font-medium text-red-700" role="alert">
              {errors["wizard"]}
            </p>
          ) : null}
        </Card>
        <div className="flex justify-end gap-2">
          <Button variant="secundario" onClick={() => navigate(-1)}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !result}>
            {busy
              ? "Enviando…"
              : result
                ? `Confirmar y enviar como ${result.severity}`
                : "Confirmar y enviar"}
          </Button>
        </div>
      </form>
    </div>
  );
}
