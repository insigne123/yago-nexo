import { Radar } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useCreateScan } from "../../api/queries";
import type { DiscoverySource } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Checkbox, Field, Textarea } from "../../components/ui/Input";
import { Dialog } from "../../components/ui/Dialog";

const SOURCES: Array<{ value: DiscoverySource; label: string; description: string }> = [
  { value: "apisix", label: "APISIX", description: "Rutas publicadas, leídas desde su Admin API (pasivo)." },
  {
    value: "nginx",
    label: "NGINX",
    description: "Archivos de configuración y registros de acceso (pasivo).",
  },
  {
    value: "gcp",
    label: "Google Cloud",
    description: "Cloud Run y balanceadores (Cloud Asset Inventory, pasivo).",
  },
  { value: "red", label: "Red", description: "Escaneo activo acotado a los rangos y nombres autorizados." },
];

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i;
const IPV4_OR_CIDR =
  /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?(:\d{1,5})?$/;

export function parseTargets(text: string): { targets: string[]; invalid: string[] } {
  const targets = text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const invalid = targets.filter((t) => !IPV4_OR_CIDR.test(t) && !HOST.test(t));
  return { targets: [...new Set(targets)], invalid };
}

function ScanForm({ onClose }: { onClose: () => void }) {
  const create = useCreateScan();
  const [sources, setSources] = useState<DiscoverySource[]>(["apisix", "nginx"]);
  const [targetsText, setTargetsText] = useState("");
  const [errors, setErrors] = useState<{ sources?: string; targets?: string }>({});

  const toggle = (value: DiscoverySource, checked: boolean) =>
    setSources((current) => (checked ? [...current, value] : current.filter((s) => s !== value)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { targets, invalid } = parseTargets(targetsText);
    const next: typeof errors = {};
    if (sources.length === 0) next.sources = "Seleccione al menos una fuente.";
    if (sources.includes("red") && targets.length === 0)
      next.targets = "El escaneo de red necesita al menos un host o rango autorizado.";
    if (invalid.length > 0)
      next.targets = `No son hosts ni rangos válidos: ${invalid.slice(0, 3).join(", ")}.`;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate({ sources, targets }, { onSuccess: onClose });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="scan-form">
      <fieldset aria-describedby={errors.sources ? "scan-sources-error" : undefined}>
        <legend className="mb-2 text-sm font-medium text-fg">Fuentes</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOURCES.map((s) => (
            <Checkbox
              key={s.value}
              id={`scan-source-${s.value}`}
              label={s.label}
              description={s.description}
              checked={sources.includes(s.value)}
              onChange={(e) => toggle(s.value, e.target.checked)}
              data-testid={`scan-source-${s.value}`}
              className="rounded-md border border-line p-2.5"
            />
          ))}
        </div>
        {errors.sources && (
          <p id="scan-sources-error" className="mt-1 text-xs font-medium text-bad">
            {errors.sources}
          </p>
        )}
      </fieldset>
      <Field
        id="scan-targets"
        label="Hosts o rangos autorizados"
        hint="Uno por línea, por ejemplo 10.20.0.0/24 o intranet.institucion.invalid. Solo lo que la institución haya autorizado por escrito."
        error={errors.targets}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={targetsText}
            onChange={(e) => setTargetsText(e.target.value)}
            className="font-mono"
            spellCheck={false}
            data-testid="scan-targets"
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          icon={<Radar className="size-4" aria-hidden="true" />}
          data-testid="btn-start-scan"
        >
          Iniciar escaneo
        </Button>
      </div>
    </form>
  );
}

export function NewScanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nuevo escaneo de descubrimiento"
      description="Busca APIs expuestas que no están en el catálogo de WSO2 y calcula su puntaje de exposición."
      testId="scan-dialog"
    >
      <ScanForm onClose={onClose} />
    </Dialog>
  );
}
