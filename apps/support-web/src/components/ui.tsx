// Componentes básicos accesibles (etiquetas, ayudas y errores asociados a cada campo).
import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type Variant = "primario" | "secundario" | "peligro" | "fantasma";

const VARIANT_CLASS: Record<Variant, string> = {
  primario: "bg-blue-800 text-white hover:bg-blue-900 disabled:bg-slate-400",
  secundario: "bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-100 disabled:text-slate-400",
  peligro: "bg-red-700 text-white hover:bg-red-800 disabled:bg-slate-400",
  fantasma: "text-blue-800 hover:bg-blue-50 disabled:text-slate-400",
};

export function Button({
  variant = "primario",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${className}`}
      {...props}
    />
  );
}

interface FieldShellProps {
  id: string;
  label: string;
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

function FieldShell({ id, label, help, error, required, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
        {required ? <span className="text-red-700"> (obligatorio)</span> : null}
      </label>
      {children}
      {help ? (
        <p id={`${id}-ayuda`} className="text-xs text-slate-600">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, help?: ReactNode, error?: string | null): string | undefined {
  const ids = [help ? `${id}-ayuda` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

const CONTROL_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus-visible:outline-2 focus-visible:outline-blue-700 aria-[invalid=true]:border-red-600";

export function TextField({
  label,
  help,
  error,
  id: idProp,
  required,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: ReactNode; error?: string | null }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        className={CONTROL_CLASS}
        {...props}
      />
    </FieldShell>
  );
}

export function TextArea({
  label,
  help,
  error,
  id: idProp,
  required,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; help?: ReactNode; error?: string | null }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required}>
      <textarea
        id={id}
        required={required}
        rows={4}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        className={CONTROL_CLASS}
        {...props}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  help,
  error,
  id: idProp,
  required,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; help?: ReactNode; error?: string | null }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={required}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        className={CONTROL_CLASS}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export function Alert({
  tone = "error",
  children,
}: {
  tone?: "error" | "exito" | "info" | "alerta";
  children: ReactNode;
}) {
  const classes: Record<string, string> = {
    error: "border-red-300 bg-red-50 text-red-900",
    exito: "border-emerald-300 bg-emerald-50 text-emerald-900",
    info: "border-blue-200 bg-blue-50 text-blue-900",
    alerta: "border-amber-300 bg-amber-50 text-amber-900",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${classes[tone]}`}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = "Cargando" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-slate-600">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-800"
      />
      {label}…
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-base font-semibold text-slate-900">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageTitle({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-bold text-slate-900">{children}</h1>
      {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">{children}</p>
  );
}
