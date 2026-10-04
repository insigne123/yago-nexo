import { FlaskConical } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { GraphNode, ImpactChangeKind, ImpactRequest } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Select, Textarea } from "../../components/ui/Input";
import { CHANGE_KIND_LABELS, NODE_TYPE_LABELS } from "../../lib/labels";
import { LAYER_ORDER } from "../graph/layout";

interface ImpactDialogProps {
  open: boolean;
  onClose: () => void;
  nodes: readonly GraphNode[];
  defaultNodeId?: string | null;
  pending: boolean;
  onSubmit: (request: ImpactRequest) => void;
}

const KINDS = Object.keys(CHANGE_KIND_LABELS) as ImpactChangeKind[];

const PLACEHOLDER: Record<ImpactChangeKind, string> = {
  contrato: "Por ejemplo: la versión 2 elimina el recurso /concesiones/{id}/historial",
  campo: "Por ejemplo: el campo region pasa de texto a código numérico",
  fuente: "Por ejemplo: la tabla CONCESION se migra de Oracle a Cloud SQL",
  retiro: "Por ejemplo: se retira la versión 1.0 el 31-12-2026",
};

function ImpactForm({ nodes, defaultNodeId, pending, onSubmit, onClose }: Omit<ImpactDialogProps, "open">) {
  const [nodeId, setNodeId] = useState(defaultNodeId ?? nodes[0]?.id ?? "");
  const [kind, setKind] = useState<ImpactChangeKind>("contrato");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!nodeId) {
      setError("Seleccione el activo que cambia.");
      return;
    }
    onSubmit({ nodeId, change: { kind, detail: detail.trim() || undefined } });
  };

  return (
    <form id="impact-form" onSubmit={submit} noValidate className="space-y-4">
      <Field id="impact-node" label="Activo que cambia" error={error ?? undefined} required>
        {(control) => (
          <Select
            {...control}
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
            data-testid="impact-node-select"
          >
            {LAYER_ORDER.map((type) => {
              const group = nodes.filter((n) => n.type === type);
              if (group.length === 0) return null;
              return (
                <optgroup key={type} label={NODE_TYPE_LABELS[type]}>
                  {group.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>
        )}
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-fg">Tipo de cambio</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {KINDS.map((k) => (
            <label
              key={k}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="impact-kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-0.5 accent-accent"
                data-testid={`impact-kind-${k}`}
              />
              {CHANGE_KIND_LABELS[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="impact-detail" label="Detalle del cambio" hint="Opcional. Se incluye en el reporte.">
        {(control) => (
          <Textarea
            {...control}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={PLACEHOLDER[kind]}
            maxLength={500}
            data-testid="impact-detail"
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          icon={<FlaskConical className="size-4" aria-hidden="true" />}
          data-testid="btn-run-simulation"
        >
          Simular
        </Button>
      </div>
    </form>
  );
}

/** Diálogo "Simular cambio" (POST /impact/simulate). */
export function ImpactDialog(props: ImpactDialogProps) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Simular cambio"
      description="Calcula qué consumidores, APIs, flujos, sistemas y reportes se verían afectados, sin aplicar el cambio."
      testId="impact-dialog"
    >
      <ImpactForm {...props} />
    </Dialog>
  );
}
