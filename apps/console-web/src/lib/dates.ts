import { isoDate } from "./format";

/** Rango de fechas (AAAA-MM-DD) que termina hoy y abarca `days` días. */
export function lastDays(days: number, today: Date = new Date()): { from: string; to: string } {
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  return { from: isoDate(start), to: isoDate(today) };
}

/** Lista de fechas AAAA-MM-DD entre dos fechas, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  for (let guard = 0; cursor <= end && guard < 400; guard++) {
    days.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** Etiqueta corta de día para ejes: "lun 29". */
export function shortDayLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDay;
  return new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric" }).format(d);
}
