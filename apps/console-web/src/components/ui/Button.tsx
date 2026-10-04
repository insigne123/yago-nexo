import { LoaderCircle } from "lucide-react";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border-transparent hover:bg-accent-strong",
  secondary: "bg-surface text-fg border-line-strong hover:bg-subtle",
  ghost: "bg-transparent text-fg-muted border-transparent hover:bg-subtle hover:text-fg",
  danger: "bg-bad text-surface border-transparent hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-sm gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

/**
 * Botón base. Para acciones bloqueadas se usa aria-disabled (no disabled) para que el botón
 * siga siendo enfocable y el lector de pantalla anuncie el motivo.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const blocked = rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (blocked || loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        VARIANTS[variant],
        SIZES[size],
        (disabled || blocked) && "cursor-not-allowed opacity-55",
        loading && "cursor-progress",
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}
