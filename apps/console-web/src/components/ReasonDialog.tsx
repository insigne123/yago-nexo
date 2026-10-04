import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field, Textarea } from "./ui/Input";

interface ReasonDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: "primary" | "danger";
  /** Largo mínimo del motivo; 0 lo deja opcional. */
  minLength?: number;
  pending?: boolean;
  onConfirm: (reason: string) => void;
  testId?: string;
  children?: ReactNode;
}

function ReasonForm({
  onClose,
  confirmLabel,
  confirmVariant = "primary",
  minLength = 10,
  pending = false,
  onConfirm,
  testId,
  children,
}: Omit<ReasonDialogProps, "open" | "title" | "description">) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const required = minLength > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = reason.trim();
    if (required && value.length < minLength) {
      setError(`Indique el motivo (al menos ${minLength} caracteres). Queda registrado en la auditoría.`);
      return;
    }
    setError(null);
    onConfirm(value);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {children}
      <Field
        id={`${testId ?? "motivo"}-reason`}
        label={required ? "Motivo" : "Motivo (opcional)"}
        required={required}
        error={error ?? undefined}
      >
        {(control) => (
          <Textarea
            {...control}
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            data-testid={testId ? `${testId}-reason` : undefined}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose}>Cancelar</Button>
        <Button
          type="submit"
          variant={confirmVariant}
          loading={pending}
          data-testid={testId ? `${testId}-confirm` : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/** Confirmación con motivo: liberar, descartar, revertir, reprocesar, aprobar retorno. */
export function ReasonDialog({ open, title, description, ...rest }: ReasonDialogProps) {
  return (
    <Dialog open={open} onClose={rest.onClose} title={title} description={description} testId={rest.testId}>
      <ReasonForm {...rest} />
    </Dialog>
  );
}
