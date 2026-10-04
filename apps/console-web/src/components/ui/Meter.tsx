import { cx } from "../../lib/cx";
import { formatNumber } from "../../lib/format";

interface MeterProps {
  value: number;
  max?: number;
  label: string;
  /** Muestra el valor en texto a la derecha (por defecto, como porcentaje). */
  showValue?: boolean;
  valueText?: string;
  tone?: "accent" | "auto";
  className?: string;
  testId?: string;
}

/**
 * Barra de medición (completitud, peso de tráfico, puntaje). El relleno usa el acento o, en
 * modo "auto", el color de estado según el valor; el valor siempre se muestra en texto.
 */
export function Meter({
  value,
  max = 100,
  label,
  showValue = true,
  valueText,
  tone = "accent",
  className,
  testId,
}: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const pct = Math.round(ratio * 100);
  const fill = tone === "auto" ? (pct >= 80 ? "bg-ok" : pct >= 50 ? "bg-warn" : "bg-bad") : "bg-accent";
  const text = valueText ?? `${formatNumber(pct)} %`;
  return (
    <div className={cx("flex items-center gap-2", className)} data-testid={testId}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-subtle"
      >
        <div className={cx("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
      </div>
      {showValue && <span className="w-12 shrink-0 text-right text-xs text-fg-muted tabular">{text}</span>}
    </div>
  );
}
