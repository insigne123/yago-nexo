/** Formatos en español de Chile. Un valor ausente se muestra como "—". */

const LOCALE = "es-CL";
export const EMPTY = "—";

const isMissing = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || Number.isNaN(v);

export function formatNumber(value: number | null | undefined, maxDigits = 0): string {
  if (isMissing(value)) return EMPTY;
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxDigits }).format(value);
}

/** `ratio` es una proporción de 0 a 1. */
export function formatPercent(ratio: number | null | undefined, maxDigits = 1): string {
  if (isMissing(ratio)) return EMPTY;
  return new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: maxDigits }).format(ratio);
}

/** Cifra abreviada en español: 950, 5,5 mil, 1,2 M (los datos de CLDR para es-CL mezclan "K" y "k"). */
export function formatCompact(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${formatNumber(value / 1e9, 1)} mil M`;
  if (abs >= 1e6) return `${formatNumber(value / 1e6, 1)} M`;
  if (abs >= 1e4) return `${formatNumber(value / 1e3, 0)} mil`;
  if (abs >= 1e3) return `${formatNumber(value / 1e3, 1)} mil`;
  return formatNumber(value);
}

/** "1 error", "3 errores": número con el sustantivo en singular o plural. */
export function plural(count: number | null | undefined, singular: string, pluralForm: string): string {
  const n = count ?? 0;
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (isMissing(ms)) return EMPTY;
  if (ms < 1000) return `${formatNumber(ms)} ms`;
  return `${formatNumber(ms / 1000, 1)} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (isMissing(bytes)) return EMPTY;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(value, unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (isMissing(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "short", timeStyle: "medium" }).format(d);
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium" }).format(d);
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return new Intl.DateTimeFormat(LOCALE, { timeStyle: "medium" }).format(d);
}

/** Fecha y hora larga con zona horaria, para el banner de demostración. */
export function formatClock(d: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function formatRelative(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

/** Marca de tiempo para nombres de archivo: 20261004-0521. */
export function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Fecha local en formato ISO (AAAA-MM-DD) para inputs de tipo date. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortHash(hash: string | null | undefined, size = 10): string {
  if (!hash) return EMPTY;
  return hash.length > size ? `${hash.slice(0, size)}…` : hash;
}
