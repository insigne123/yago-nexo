import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../../lib/cx";

const CONTROL =
  "w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "aria-[invalid=true]:border-bad disabled:cursor-not-allowed disabled:opacity-60";

export interface ControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: (control: ControlProps) => ReactNode;
}

/** Etiqueta, ayuda y error enlazados al control (aria-describedby / aria-invalid). */
export function Field({ id, label, hint, error, required = false, className, children }: FieldProps) {
  const hintId = hint ? `${id}-ayuda` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required && (
          <span className="text-bad" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint && (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cx(CONTROL, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={cx(CONTROL, "min-h-20 py-2", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentPropsWithRef<"select">) {
  return (
    <select className={cx(CONTROL, "h-9 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

interface CheckboxProps extends Omit<ComponentPropsWithRef<"input">, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...rest }: CheckboxProps) {
  return (
    <label htmlFor={id} className={cx("flex cursor-pointer items-start gap-2 text-sm", className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-accent" {...rest} />
      <span>
        <span className="text-fg">{label}</span>
        {description && <span className="block text-xs text-fg-muted">{description}</span>}
      </span>
    </label>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  name: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
  describedBy?: string;
}

/** Grupo de opciones excluyentes con radios nativos (navegable con flechas). */
export function SegmentedControl<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
  testId,
  describedBy,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cx(
        "inline-flex rounded-md border border-line-strong bg-surface p-0.5",
        disabled && "opacity-60",
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className={cx(
              "rounded px-3 py-1.5 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
              checked ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-subtle",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
