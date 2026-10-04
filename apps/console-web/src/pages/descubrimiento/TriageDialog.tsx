import { useState, type FormEvent } from "react";
import { usePatchFinding } from "../../api/queries";
import type { DiscoveryFinding, FindingStatus } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Textarea } from "../../components/ui/Input";

type TriageStatus = Exclude<FindingStatus, "nuevo">;

const OPTIONS: Array<{ value: TriageStatus; label: string; description: string; noteRequired: boolean }> = [
  {
    value: "gobernado",
    label: "Gobernado",
    description: "Ya está publicado en WSO2 o se vinculó con una API del catálogo.",
    noteRequired: false,
  },
  {
    value: "en_migracion",
    label: "En migración",
    description: "Se crea una tarea para publicarlo detrás del gateway con su ficha de gobierno.",
    noteRequired: false,
  },
  {
    value: "riesgo_aceptado",
    label: "Riesgo aceptado",
    description: "Se mantiene fuera del gateway de forma justificada y con responsable.",
    noteRequired: true,
  },
  {
    value: "descartado",
    label: "Descartado",
    description: "No es una API (falso positivo) o ya no existe.",
    noteRequired: true,
  },
];

function TriageForm({ finding, onClose }: { finding: DiscoveryFinding; onClose: () => void }) {
  const patch = usePatchFinding();
  const [status, setStatus] = useState<TriageStatus>(
    finding.status === "nuevo" ? "en_migracion" : finding.status,
  );
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const option = OPTIONS.find((o) => o.value === status);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (option?.noteRequired && note.trim().length < 10) {
      setError("Explique el motivo (al menos 10 caracteres): queda en la auditoría.");
      return;
    }
    setError(null);
    patch.mutate({ id: finding.id, status, note: note.trim() || undefined }, { onSuccess: onClose });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="triage-form">
      <p className="rounded-md bg-subtle px-3 py-2 font-mono text-xs break-all text-fg">
        {finding.host}
        {finding.port ? `:${finding.port}` : ""}
        {finding.path}
      </p>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Clasificación</legend>
        <div className="space-y-2">
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="triage-status"
                value={o.value}
                checked={status === o.value}
                onChange={() => setStatus(o.value)}
                className="mt-0.5 accent-accent"
                data-testid={`triage-${o.value}`}
              />
              <span>
                <span className="font-medium text-fg">{o.label}</span>
                <span className="block text-xs text-fg-muted">{o.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        id="triage-note"
        label={option?.noteRequired ? "Motivo" : "Nota (opcional)"}
        required={option?.noteRequired}
        error={error ?? undefined}
      >
        {(control) => (
          <Textarea
            {...control}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            data-testid="triage-note"
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose}>Cancelar</Button>
        <Button type="submit" variant="primary" loading={patch.isPending} data-testid="btn-save-triage">
          Guardar clasificación
        </Button>
      </div>
    </form>
  );
}

export function TriageDialog({
  finding,
  onClose,
}: {
  finding: DiscoveryFinding | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={finding !== null}
      onClose={onClose}
      title="Clasificar hallazgo"
      description="La decisión queda registrada con su usuario en la auditoría."
      testId="triage-dialog"
    >
      {finding && <TriageForm finding={finding} onClose={onClose} />}
    </Dialog>
  );
}
