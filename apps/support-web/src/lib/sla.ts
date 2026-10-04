// Presentación de los relojes SLA (cuenta regresiva, pausa y vencimiento).
import { formatDateTime } from "./format";
import { METRIC_LABEL } from "./labels";
import type { SlaClockRow } from "./types";

/** Duración compacta: "2 d 4 h", "3 h 05 min", "12 min", "45 s". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Duración para lectores de pantalla: "2 días y 4 horas". */
export function formatDurationLong(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return hours > 0
      ? `${plural(days, "día", "días")} y ${plural(hours, "hora", "horas")}`
      : plural(days, "día", "días");
  }
  if (hours > 0) {
    return minutes > 0
      ? `${plural(hours, "hora", "horas")} y ${plural(minutes, "minuto", "minutos")}`
      : plural(hours, "hora", "horas");
  }
  if (minutes > 0) return plural(minutes, "minuto", "minutos");
  return plural(seconds, "segundo", "segundos");
}

export type ClockState = "corriendo" | "en_pausa" | "vencido" | "cumplido" | "cumplido_tarde" | "sin_plazo";
export type ClockTone = "ok" | "alerta" | "peligro" | "pausa" | "neutro";

export interface ClockView {
  state: ClockState;
  tone: ClockTone;
  /** Texto principal, por ejemplo "Quedan 45 min" o "Vencido hace 2 h 10 min". */
  label: string;
  /** Detalle, por ejemplo "vence lun 05-10-2026, 18:00". */
  detail: string;
  /** Frase completa para lectores de pantalla. */
  ariaLabel: string;
  /** Segundos que quedan (negativo si venció); null si no aplica. */
  remainingSeconds: number | null;
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/**
 * Describe el estado de un reloj en el instante `now`. Si el reloj sigue "en_curso" pero
 * ya pasó su vencimiento, se muestra vencido aunque sd_tick todavía no lo haya marcado.
 */
export function describeClock(clock: SlaClockRow, now: Date): ClockView {
  const metric = METRIC_LABEL[clock.metric];
  const habil = clock.calendar === "habil";
  const suffix = habil ? " hábiles" : "";

  if (clock.status === "no_aplica" || clock.target_minutes === null) {
    return {
      state: "sin_plazo",
      tone: "neutro",
      label: "Sin plazo comprometido",
      detail: "",
      ariaLabel: `${metric}: sin plazo comprometido`,
      remainingSeconds: null,
    };
  }

  if (clock.met_at) {
    const late = clock.status === "incumplido" || clock.breached_at !== null;
    return {
      state: late ? "cumplido_tarde" : "cumplido",
      tone: late ? "peligro" : "ok",
      label: late ? "Cumplido fuera de plazo" : "Cumplido",
      detail: `el ${formatDateTime(clock.met_at)}`,
      ariaLabel: `${metric}: ${late ? "cumplido fuera de plazo" : "cumplido a tiempo"} el ${formatDateTime(clock.met_at)}`,
      remainingSeconds: null,
    };
  }

  if (clock.status === "pausado") {
    const remaining = clock.remaining_seconds_at_pause ?? 0;
    return {
      state: "en_pausa",
      tone: "pausa",
      label: `En pausa · quedan ${formatDuration(remaining)}${suffix}`,
      detail: clock.paused_since ? `pausado desde ${formatDateTime(clock.paused_since)}` : "pausado",
      ariaLabel: `${metric}: reloj en pausa, quedan ${formatDurationLong(remaining)}${suffix}`,
      remainingSeconds: remaining,
    };
  }

  const due = clock.due_at ? new Date(clock.due_at) : null;
  const remaining = due ? seconds(due.getTime() - now.getTime()) : 0;
  if (clock.status === "incumplido" || remaining <= 0) {
    const overdue = due ? -remaining : 0;
    return {
      state: "vencido",
      tone: "peligro",
      label: `Vencido hace ${formatDuration(overdue)}`,
      detail: due ? `venció ${formatDateTime(due)}` : "vencido",
      ariaLabel: `${metric}: plazo vencido hace ${formatDurationLong(overdue)}`,
      remainingSeconds: -overdue,
    };
  }

  // Alerta cuando sd_tick ya avisó el 80 % o, en 24x7, si queda menos del 20 % del plazo.
  const lowOnTime = !habil && remaining <= clock.target_minutes * 60 * 0.2;
  return {
    state: "corriendo",
    tone: clock.notified_80_at || lowOnTime ? "alerta" : "ok",
    label: `Quedan ${formatDuration(remaining)}`,
    detail: `vence ${formatDateTime(due)}${habil ? " (plazo en horario hábil)" : ""}`,
    ariaLabel: `${metric}: quedan ${formatDurationLong(remaining)}, vence ${formatDateTime(due)}`,
    remainingSeconds: remaining,
  };
}

/** Próximo vencimiento entre los relojes que corren (para ordenar la bandeja). */
export function nextDue(clocks: SlaClockRow[]): string | null {
  const running = clocks
    .filter((c) => c.status === "en_curso" && c.due_at && !c.met_at)
    .map((c) => c.due_at as string)
    .sort();
  return running[0] ?? null;
}

export function isBreached(clocks: SlaClockRow[], now: Date): boolean {
  return clocks.some((c) => describeClock(c, now).state === "vencido");
}
