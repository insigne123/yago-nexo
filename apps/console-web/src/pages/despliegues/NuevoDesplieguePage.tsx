import { ArrowLeft, Rocket } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { useApis, useCreateRollout } from "../../api/queries";
import type { RolloutInput } from "../../api/types";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input, SegmentedControl, Select } from "../../components/ui/Input";

type Strategy = RolloutInput["strategy"];
type Environment = RolloutInput["environment"];

const FormSchema = z
  .object({
    apiId: z.string().min(1, "Seleccione la API."),
    strategy: z.enum(["canary", "blue_green"]),
    candidateEndpoint: z
      .string()
      .trim()
      .url("Ingrese una URL completa, por ejemplo https://concesiones-v2.interno.invalid")
      .refine((v) => /^https?:\/\//.test(v), "La URL debe comenzar con http:// o https://"),
    stepsText: z.string(),
    stepDurationSec: z
      .number({ error: "Ingrese un número." })
      .int("Debe ser entero.")
      .min(10, "Mínimo 10 segundos.")
      .max(3600, "Máximo 1 hora."),
    maxErrorRatePct: z
      .number({ error: "Ingrese un número." })
      .min(0, "No puede ser negativo.")
      .max(100, "Máximo 100 %."),
    maxP99Ms: z
      .number({ error: "Ingrese un número." })
      .int("Debe ser entero.")
      .min(1, "Mínimo 1 ms.")
      .max(60_000, "Máximo 60 000 ms."),
    minRequests: z
      .number({ error: "Ingrese un número." })
      .int("Debe ser entero.")
      .min(1, "Mínimo 1.")
      .max(1_000_000, "Valor demasiado alto."),
    environment: z.enum(["dev", "qa", "prod"]),
  })
  .superRefine((value, ctx) => {
    if (value.strategy === "blue_green") return;
    const steps = parseSteps(value.stepsText);
    if (!steps) {
      ctx.addIssue({
        code: "custom",
        path: ["stepsText"],
        message: "Use números de 1 a 100 separados por coma, por ejemplo 5, 25, 50, 100.",
      });
      return;
    }
    if (steps.some((s, i) => i > 0 && s <= steps[i - 1]!)) {
      ctx.addIssue({
        code: "custom",
        path: ["stepsText"],
        message: "Los pasos deben ir en orden creciente.",
      });
    }
    if (steps.at(-1) !== 100) {
      ctx.addIssue({ code: "custom", path: ["stepsText"], message: "El último paso debe ser 100 %." });
    }
  });

type FormValues = z.infer<typeof FormSchema>;
type Errors = Partial<Record<keyof FormValues, string>>;

function parseSteps(text: string): number[] | null {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.replace("%", "").trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const steps = parts.map(Number);
  return steps.every((s) => Number.isInteger(s) && s >= 1 && s <= 100) ? steps : null;
}

const numberValue = (raw: string) => (raw === "" ? Number.NaN : Number(raw.replace(",", ".")));
const shown = (v: number) => (Number.isNaN(v) ? "" : String(v));

export default function NuevoDesplieguePage() {
  const apis = useApis();
  const create = useCreateRollout();
  const navigate = useNavigate();
  const [values, setValues] = useState<FormValues>({
    apiId: "",
    strategy: "canary",
    candidateEndpoint: "",
    stepsText: "5, 25, 50, 100",
    stepDurationSec: 60,
    maxErrorRatePct: 2,
    maxP99Ms: 800,
    minRequests: 20,
    environment: "prod",
  });
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = FormSchema.safeParse(values);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormValues | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const v = parsed.data;
    const input: RolloutInput = {
      apiId: v.apiId,
      strategy: v.strategy,
      candidateEndpoint: v.candidateEndpoint,
      steps: v.strategy === "blue_green" ? [100] : (parseSteps(v.stepsText) ?? [5, 25, 50, 100]),
      stepDurationSec: v.stepDurationSec,
      thresholds: { maxErrorRate: v.maxErrorRatePct / 100, maxP99Ms: v.maxP99Ms, minRequests: v.minRequests },
      environment: v.environment,
    };
    create.mutate(input, {
      onSuccess: (rollout) => void navigate(`/despliegues/${encodeURIComponent(rollout.id)}`),
    });
  };

  return (
    <>
      <PageHeader
        title="Nuevo despliegue"
        reference="D-04"
        breadcrumb={
          <Link to="/despliegues" className="inline-flex items-center gap-1 hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Despliegues
          </Link>
        }
        description="Defina la versión candidata, los pasos de tráfico y los umbrales que debe cumplir para avanzar."
      />
      <Card className="max-w-3xl">
        <form onSubmit={submit} noValidate className="grid gap-5 sm:grid-cols-2" data-testid="rollout-form">
          <Field id="rollout-api" label="API" required error={errors.apiId} className="sm:col-span-2">
            {(control) => (
              <Select
                {...control}
                value={values.apiId}
                onChange={(e) => set("apiId", e.target.value)}
                data-testid="rollout-api"
              >
                <option value="">Seleccione…</option>
                {(apis.data ?? [])
                  .filter((a) => a.state !== "RETIRED")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} {a.version} ({a.context})
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-sm font-medium text-fg" id="rollout-strategy-label">
              Estrategia
            </span>
            <SegmentedControl<Strategy>
              name="rollout-strategy"
              label="Estrategia"
              value={values.strategy}
              onChange={(v) => set("strategy", v)}
              options={[
                { value: "canary", label: "Canary (por pasos)" },
                { value: "blue_green", label: "Blue-green (todo de una vez)" },
              ]}
              testId="rollout-strategy"
            />
            <p className="text-xs text-fg-muted">
              {values.strategy === "canary"
                ? "El tráfico hacia la versión nueva sube por pasos mientras cumpla los umbrales."
                : "Se mantienen dos revisiones y se cambia todo el tráfico de una vez, con reversa inmediata."}
            </p>
          </div>
          <Field
            id="rollout-endpoint"
            label="Endpoint candidato"
            required
            error={errors.candidateEndpoint}
            className="sm:col-span-2"
            hint="Backend de la versión nueva. El estable es el que tiene hoy la API en WSO2."
          >
            {(control) => (
              <Input
                {...control}
                type="url"
                value={values.candidateEndpoint}
                onChange={(e) => set("candidateEndpoint", e.target.value)}
                placeholder="https://concesiones-v2.interno.invalid"
                className="font-mono"
                spellCheck={false}
                data-testid="rollout-endpoint"
              />
            )}
          </Field>
          <Field
            id="rollout-steps"
            label="Pasos (% de tráfico)"
            error={errors.stepsText}
            hint={
              values.strategy === "blue_green"
                ? "Blue-green usa un único paso de 100 %."
                : "Separados por coma, en orden creciente y terminando en 100."
            }
          >
            {(control) => (
              <Input
                {...control}
                value={values.strategy === "blue_green" ? "100" : values.stepsText}
                disabled={values.strategy === "blue_green"}
                onChange={(e) => set("stepsText", e.target.value)}
                data-testid="rollout-steps"
              />
            )}
          </Field>
          <Field
            id="rollout-duration"
            label="Duración de cada paso (segundos)"
            error={errors.stepDurationSec}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={10}
                inputMode="numeric"
                value={shown(values.stepDurationSec)}
                onChange={(e) => set("stepDurationSec", numberValue(e.target.value))}
              />
            )}
          </Field>
          <fieldset className="grid gap-4 rounded-md border border-line p-4 sm:col-span-2 sm:grid-cols-3">
            <legend className="px-1 text-sm font-medium text-fg">Umbrales para avanzar</legend>
            <Field id="rollout-max-error" label="Tasa de errores máxima (%)" error={errors.maxErrorRatePct}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  step="0.1"
                  min={0}
                  max={100}
                  inputMode="decimal"
                  value={shown(values.maxErrorRatePct)}
                  onChange={(e) => set("maxErrorRatePct", numberValue(e.target.value))}
                  data-testid="rollout-max-error"
                />
              )}
            </Field>
            <Field id="rollout-max-p99" label="Latencia p99 máxima (ms)" error={errors.maxP99Ms}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={shown(values.maxP99Ms)}
                  onChange={(e) => set("maxP99Ms", numberValue(e.target.value))}
                />
              )}
            </Field>
            <Field id="rollout-min-requests" label="Solicitudes mínimas por paso" error={errors.minRequests}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={shown(values.minRequests)}
                  onChange={(e) => set("minRequests", numberValue(e.target.value))}
                />
              )}
            </Field>
          </fieldset>
          <Field
            id="rollout-env"
            label="Ambiente"
            error={errors.environment}
            hint={
              values.environment === "prod"
                ? "En producción, otra persona con rol aprobador debe aprobar el inicio (cuatro ojos)."
                : undefined
            }
          >
            {(control) => (
              <Select
                {...control}
                value={values.environment}
                onChange={(e) => set("environment", e.target.value as Environment)}
                data-testid="rollout-env"
              >
                <option value="dev">Desarrollo</option>
                <option value="qa">QA</option>
                <option value="prod">Producción</option>
              </Select>
            )}
          </Field>
          <div className="flex items-end justify-end gap-2 sm:col-span-2">
            <Button onClick={() => void navigate("/despliegues")}>Cancelar</Button>
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              icon={<Rocket className="size-4" aria-hidden="true" />}
              data-testid="btn-create-rollout"
            >
              Crear despliegue
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
