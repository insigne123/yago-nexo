import { Save, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { usePatchApi } from "../../api/queries";
import type { ApiAssetDetail, ApiAssetPatch } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";
import { toast } from "../../components/ui/toast-store";
import { AUDIENCE_LABELS, CLASSIFICATION_LABELS } from "../../lib/labels";

const EditSchema = z.object({
  purpose: z.string().trim().max(1000, "Máximo 1000 caracteres."),
  ownerTeam: z.string().trim().max(200, "Máximo 200 caracteres."),
  ownerContact: z
    .string()
    .trim()
    .max(200, "Máximo 200 caracteres.")
    .refine(
      (v) => !v.includes("@") || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      "El correo no tiene un formato válido.",
    ),
  audience: z.enum(["interna", "operadores", "publica"]),
  classification: z.enum(["", "publica", "interna", "reservada", "datos_personales"]),
  contractRef: z
    .string()
    .trim()
    .max(300, "Máximo 300 caracteres.")
    .refine(
      (v) => !v || /^[^\s@]+@[0-9a-f]{7,40}$/i.test(v),
      "Use el formato repositorio@commit, por ejemplo nexo-contratos@3f2a9c1.",
    ),
});

type EditValues = z.infer<typeof EditSchema>;
type Errors = Partial<Record<keyof EditValues, string>>;

function initialValues(api: ApiAssetDetail): EditValues {
  return {
    purpose: api.purpose ?? "",
    ownerTeam: api.ownerTeam ?? "",
    ownerContact: api.ownerContact ?? "",
    audience: api.audience,
    classification: api.classification ?? "",
    contractRef: api.contractRef ?? "",
  };
}

/** Edición en línea de los metadatos de gobierno (PATCH /apis/{id}, permiso catalog:write). */
export function ApiEditForm({ api, onDone }: { api: ApiAssetDetail; onDone: () => void }) {
  const [values, setValues] = useState<EditValues>(() => initialValues(api));
  const [errors, setErrors] = useState<Errors>({});
  const patch = usePatchApi(api.id);

  const set = <K extends keyof EditValues>(key: K, value: EditValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = EditSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof EditValues | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const original = initialValues(api);
    const body: ApiAssetPatch = {};
    const v = parsed.data;
    if (v.purpose !== original.purpose) body.purpose = v.purpose;
    if (v.ownerTeam !== original.ownerTeam) body.ownerTeam = v.ownerTeam;
    if (v.ownerContact !== original.ownerContact) body.ownerContact = v.ownerContact;
    if (v.audience !== original.audience) body.audience = v.audience;
    if (v.classification && v.classification !== original.classification)
      body.classification = v.classification;
    if (v.contractRef !== original.contractRef) body.contractRef = v.contractRef;
    if (Object.keys(body).length === 0) {
      toast.info("Sin cambios", "No se modificó ningún campo.");
      onDone();
      return;
    }
    patch.mutate(body, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 md:grid-cols-2" data-testid="api-edit-form">
      <Field id="api-purpose" label="Propósito" error={errors.purpose} className="md:col-span-2">
        {(control) => (
          <Textarea
            {...control}
            value={values.purpose}
            maxLength={1000}
            onChange={(e) => set("purpose", e.target.value)}
            rows={3}
          />
        )}
      </Field>
      <Field id="api-owner-team" label="Equipo dueño" error={errors.ownerTeam}>
        {(control) => (
          <Input {...control} value={values.ownerTeam} onChange={(e) => set("ownerTeam", e.target.value)} />
        )}
      </Field>
      <Field
        id="api-owner-contact"
        label="Contacto del dueño"
        hint="Correo o nombre de contacto."
        error={errors.ownerContact}
      >
        {(control) => (
          <Input
            {...control}
            value={values.ownerContact}
            onChange={(e) => set("ownerContact", e.target.value)}
          />
        )}
      </Field>
      <Field id="api-audience" label="Audiencia" error={errors.audience}>
        {(control) => (
          <Select
            {...control}
            value={values.audience}
            onChange={(e) => set("audience", e.target.value as EditValues["audience"])}
          >
            {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="api-classification" label="Clasificación de los datos" error={errors.classification}>
        {(control) => (
          <Select
            {...control}
            value={values.classification}
            onChange={(e) => set("classification", e.target.value as EditValues["classification"])}
          >
            <option value="">Sin clasificar</option>
            {Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="api-contract"
        label="Contrato (repositorio@commit)"
        hint="Referencia inmutable al contrato OpenAPI o WSDL versionado."
        error={errors.contractRef}
        className="md:col-span-2"
      >
        {(control) => (
          <Input
            {...control}
            value={values.contractRef}
            onChange={(e) => set("contractRef", e.target.value)}
            className="font-mono"
            spellCheck={false}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 md:col-span-2">
        <Button onClick={onDone} icon={<X className="size-4" aria-hidden="true" />}>
          Cancelar
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={patch.isPending}
          icon={<Save className="size-4" aria-hidden="true" />}
          data-testid="btn-save-api"
        >
          Guardar cambios
        </Button>
      </div>
    </form>
  );
}
