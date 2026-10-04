import { METRIC_LABEL } from "../lib/labels";
import { describeClock, type ClockTone } from "../lib/sla";
import type { Metric, SlaClockRow } from "../lib/types";

const TONE_CLASS: Record<ClockTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  alerta: "border-amber-300 bg-amber-50 text-amber-900",
  peligro: "border-red-300 bg-red-50 text-red-800",
  pausa: "border-slate-300 bg-slate-100 text-slate-800",
  neutro: "border-slate-200 bg-white text-slate-500",
};

const ORDER: Metric[] = ["acuse", "diagnostico", "solucion"];

/** Un reloj SLA: tiempo restante, pausa (congelado) o vencido (en rojo). */
export function SlaClock({
  clock,
  now,
  compact = false,
}: {
  clock: SlaClockRow;
  now: Date;
  compact?: boolean;
}) {
  const view = describeClock(clock, now);
  return (
    <div
      className={`rounded-md border px-2 py-1 ${TONE_CLASS[view.tone]} ${compact ? "text-xs" : "text-sm"}`}
      data-estado={view.state}
      data-tono={view.tone}
      aria-label={view.ariaLabel}
      role="group"
    >
      <div className="font-semibold">
        {METRIC_LABEL[clock.metric]}
        {view.state === "en_pausa" ? (
          <span className="ml-1 rounded bg-slate-700 px-1 text-[10px] font-bold text-white">PAUSA</span>
        ) : null}
      </div>
      <div aria-hidden="true">{view.label}</div>
      {!compact && view.detail ? (
        <div className="text-xs opacity-80" aria-hidden="true">
          {view.detail}
        </div>
      ) : null}
    </div>
  );
}

export function SlaClocks({
  clocks,
  now,
  compact = false,
}: {
  clocks: SlaClockRow[];
  now: Date;
  compact?: boolean;
}) {
  const sorted = [...clocks].sort((a, b) => ORDER.indexOf(a.metric) - ORDER.indexOf(b.metric));
  if (sorted.length === 0) return <span className="text-xs text-slate-500">Sin relojes (en cuarentena)</span>;
  return (
    <div className={`grid gap-2 ${compact ? "grid-cols-3" : "grid-cols-1 sm:grid-cols-3"}`}>
      {sorted.map((clock) => (
        <SlaClock key={clock.id} clock={clock} now={now} compact={compact} />
      ))}
    </div>
  );
}
