import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../../lib/cx";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "bad";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-subtle text-fg-muted border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
};

interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: BadgeTone;
  icon?: ReactNode;
}

/** Etiqueta de estado. Siempre lleva texto (y en estados, ícono): el color nunca va solo. */
export function Badge({ tone = "neutral", icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}
