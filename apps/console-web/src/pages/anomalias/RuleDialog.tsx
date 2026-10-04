import { useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { useApis, useSaveRule } from "../../api/queries";
import type { AnomalyAction, AnomalyMetric, AnomalyRule, AnomalyRuleInput } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Checkbox, Field, Input, Select } from "../../components/ui/Input";
import { Dialog } from "../../components/ui/Dialog";
import { formatNumber } from "../../lib/format";
import { ACTION_LABELS, METRIC_LABELS } from "../../lib/labels";

const METRICS = Object.keys(METRIC_LABELS) as AnomalyMetric[];
const ACTIONS = Object.keys(ACTION_LABELS) as AnomalyAction[];

const RuleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3, "El nombre debe tener al menos 3 caracteres.")
    .max(120, "Máximo 120 caracteres."),
  apiId: z.string(),
  consumerId: z.string().trim().max(120, "Máximo 120 caracteres."),
  metric: z.enum(METRICS as [AnomalyMetric, ...AnomalyMetric[]]),
  sensitivity: z.number().min(1, "Mínimo 1.").max(10, "Máximo 10."),
  minVolume: z
    .number({ error: "Ingrese un número." })
    .int("Debe ser un número entero.")
    .min(0, "No puede ser negativo.")
    .max(1_000_000, "Valor demasiado alto."),
  action: z.enum(ACTIONS as [AnomalyAction, ...AnomalyAction[]]),
  blockTtlMinutes: z
    .number({ error: "Ingrese un número." })
    .int("Debe ser un número entero.")
    .min(1, "Mínimo 1 minuto.")
    .max(1440, "Máximo 24 horas (1440 minutos)."),
  enabled: z.boolean(),
});

type RuleValues = z.infer<typeof RuleSchema>;
type Errors = Partial<Record<keyof RuleValues, string>>;

function initial(rule: AnomalyRule | null): RuleValues {
  return {
    name: rule?.name ?? "",
    apiId: rule?.apiId ?? "",
    consumerId: rule?.consumerId ?? "",
    metric: rule?.metric ?? "volumen",
    sensitivity: rule?.sensitivity ?? 6,
    minVolume: rule?.minVolume ?? 30,
    action: rule?.action ?? "alertar",
    blockTtlMinutes: rule?.blockTtlMinutes ?? 30,
    enabled: rule?.enabled ?? true,
  };
}

const SENSITIVITY_HINT = (value: number) =>
  value <= 3
    ? "Muy sensible: detecta desvíos pequeños (más alertas)."
    : value >= 8
      ? "Poco sensible: solo desvíos muy grandes."
      : "Equilibrada.";

function RuleForm({ rule, onClose }: { rule: AnomalyRule | null; onClose: () => void }) {
  const apis = useApis();
  const save = useSaveRule();
  const [values, setValues] = useState<RuleValues>(() => initial(rule));
  const [errors, setErrors] = useState<Errors>({});
  const sensitivityHintId = useId();

  const set = <K extends keyof RuleValues>(key: K, value: RuleValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = RuleSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof RuleValues | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const v = parsed.data;
    const input: AnomalyRuleInput = {
      name: v.name,
      metric: v.metric,
      sensitivity: v.sensitivity,
      minVolume: v.minVolume,
      action: v.action,
      blockTtlMinutes: v.blockTtlMinutes,
      enabled: v.enabled,
      ...(v.apiId ? { apiId: v.apiId } : {}),
      ...(v.consumerId ? { consumerId: v.consumerId } : {}),
    };
    save.mutate({ id: rule?.id, input }, { onSuccess: onClose });
  };

  const numberValue = (raw: string) => (raw === "" ? Number.NaN : Number(raw));

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2" data-testid="rule-form">
      <Field id="rule-name" label="Nombre" required error={errors.name} className="sm:col-span-2">
        {(control) => (
          <Input
            {...control}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            data-testid="rule-name"
          />
        )}
      </Field>
      <Field id="rule-api" label="API" hint="Vacío: aplica a todas las APIs." error={errors.apiId}>
        {(control) => (
          <Select
            {...control}
            value={values.apiId}
            onChange={(e) => set("apiId", e.target.value)}
            data-testid="rule-api"
          >
            <option value="">Todas las APIs</option>
            {(apis.data ?? []).map((a) => (
              <option key={a.id} value={a.wso2ApiId ?? a.id}>
                {a.name} {a.version}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="rule-consumer"
        label="Consumidor (opcional)"
        hint="Identificador de la aplicación en WSO2."
        error={errors.consumerId}
      >
        {(control) => (
          <Input {...control} value={values.consumerId} onChange={(e) => set("consumerId", e.target.value)} />
        )}
      </Field>
      <Field id="rule-metric" label="Métrica" required error={errors.metric}>
        {(control) => (
          <Select
            {...control}
            value={values.metric}
            onChange={(e) => set("metric", e.target.value as AnomalyMetric)}
            data-testid="rule-metric"
          >
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABELS[m]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <label htmlFor="rule-sensitivity" className="text-sm font-medium text-fg">
          Sensibilidad: <output htmlFor="rule-sensitivity">{formatNumber(values.sensitivity, 1)}</output>
        </label>
        <input
          id="rule-sensitivity"
          type="range"
          min={1}
          max={10}
          step={0.5}
          value={values.sensitivity}
          onChange={(e) => set("sensitivity", Number(e.target.value))}
          aria-describedby={sensitivityHintId}
          aria-valuetext={`${formatNumber(values.sensitivity, 1)} desviaciones robustas`}
          className="h-9 w-full accent-accent"
          data-testid="rule-sensitivity"
        />
        <p id={sensitivityHintId} className="text-xs text-fg-muted">
          Umbral en desviaciones robustas (MAD) sobre la línea base. {SENSITIVITY_HINT(values.sensitivity)}
        </p>
      </div>
      <Field
        id="rule-min-volume"
        label="Volumen mínimo"
        hint="Llamadas por ventana de evaluación (60 s por omisión) bajo las cuales no se evalúa."
        error={errors.minVolume}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={0}
            inputMode="numeric"
            value={Number.isNaN(values.minVolume) ? "" : values.minVolume}
            onChange={(e) => set("minVolume", numberValue(e.target.value))}
          />
        )}
      </Field>
      <Field id="rule-action" label="Acción" required error={errors.action}>
        {(control) => (
          <Select
            {...control}
            value={values.action}
            onChange={(e) => set("action", e.target.value as AnomalyAction)}
            data-testid="rule-action"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="rule-ttl"
        label="Duración del bloqueo (minutos)"
        hint={
          values.action === "alertar"
            ? "No aplica: la regla solo alerta."
            : "El bloqueo se levanta solo al vencer."
        }
        error={errors.blockTtlMinutes}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={1}
            max={1440}
            inputMode="numeric"
            disabled={values.action === "alertar"}
            value={Number.isNaN(values.blockTtlMinutes) ? "" : values.blockTtlMinutes}
            onChange={(e) => set("blockTtlMinutes", numberValue(e.target.value))}
          />
        )}
      </Field>
      <Checkbox
        id="rule-enabled"
        label="Regla activa"
        description="Una regla inactiva no genera eventos."
        checked={values.enabled}
        onChange={(e) => set("enabled", e.target.checked)}
        className="sm:col-span-2"
      />
      <div className="flex justify-end gap-2 border-t border-line pt-4 sm:col-span-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button type="submit" variant="primary" loading={save.isPending} data-testid="btn-save-rule">
          {rule ? "Guardar cambios" : "Crear regla"}
        </Button>
      </div>
    </form>
  );
}

export function RuleDialog({
  open,
  rule,
  onClose,
}: {
  open: boolean;
  rule: AnomalyRule | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={rule ? `Editar regla: ${rule.name}` : "Nueva regla de detección"}
      description="Línea base por API y consumidor según la hora de la semana (mediana y MAD)."
      size="lg"
      testId="rule-dialog"
    >
      <RuleForm key={rule?.id ?? "nueva"} rule={rule} onClose={onClose} />
    </Dialog>
  );
}
