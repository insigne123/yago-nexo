/** CSV según RFC 4180 (coma como separador, comillas dobles para escapar). */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join(" | ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(c.value(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
