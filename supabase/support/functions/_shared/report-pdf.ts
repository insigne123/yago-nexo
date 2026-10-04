// PDF del informe mensual de cumplimiento del SLA (pdf-lib, fuentes estándar: no requiere
// archivos de fuentes). El texto se normaliza al juego WinAnsi de esas fuentes.
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

export interface SummaryRow {
  severity: string;
  metric: string;
  calendar: string;
  target_minutes: number | null;
  total: number;
  met_on_time: number;
  breached: number;
  pending: number;
  compliance_pct: number | string | null;
  avg_effective_minutes: number | string | null;
  max_effective_minutes: number | string | null;
}

export interface ReportData {
  organizacion: { id: string; nombre: string };
  periodo: string;
  desde?: string;
  hasta?: string;
  zona_horaria?: string;
  generado_en?: string;
  resumen: SummaryRow[];
  tickets: { total: number; por_severidad: Record<string, number>; por_estado: Record<string, number> };
  pausas: Array<{ motivo: string; cantidad: number; minutos: number | string; objetadas: number }>;
  incumplimientos: Array<{
    numero: string;
    titulo: string;
    severidad: string;
    metrica: string;
    vencia: string | null;
    cumplido: string | null;
  }>;
  incidentes_seguridad: number;
}

const METRIC_LABEL: Record<string, string> = {
  acuse: "Acuse",
  diagnostico: "Diagnóstico",
  solucion: "Solución",
};
const PAUSE_LABEL: Record<string, string> = {
  infraestructura_subtel: "Infraestructura de SUBTEL",
  red: "Red",
  terceros: "Terceros",
  decision_subtel: "Decisión de SUBTEL",
  acceso_remoto_pendiente: "Acceso remoto pendiente",
};
const STATUS_LABEL: Record<string, string> = {
  nuevo: "Nuevo",
  acusado: "Acusado",
  en_diagnostico: "En diagnóstico",
  solucion_temporal: "Solución temporal",
  resuelto: "Resuelto",
  cerrado: "Cerrado",
};

// Caracteres de WinAnsi fuera de Latin-1 que las fuentes estándar sí pueden dibujar.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const REPLACEMENTS: Record<string, string> = { "≥": ">=", "≤": "<=", "→": "->", "\t": " " };

/** Deja el texto dibujable con Helvetica (WinAnsi): reemplaza lo que no se puede codificar. */
export function toWinAnsi(value: string): string {
  let out = "";
  for (const ch of value.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch === "\n" || ch === "\r") out += " ";
    else out += REPLACEMENTS[ch] ?? "?";
  }
  return out;
}

export function formatTarget(minutes: number | null, calendar: string): string {
  if (minutes === null || minutes === undefined) return "Sin plazo";
  if (calendar === "habil") {
    if (minutes % 540 === 0) {
      const days = minutes / 540;
      return `${days} ${days === 1 ? "día hábil" : "días hábiles"}`;
    }
    if (minutes % 60 === 0) return `${minutes / 60} h hábiles`;
    return `${minutes} min hábiles`;
  }
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatPercent(value: number | string | null): string {
  const n = num(value);
  return n === null ? "Sin casos" : `${n.toFixed(1).replace(".", ",")} %`;
}

function formatMinutes(value: number | string | null): string {
  const n = num(value);
  return n === null ? "-" : n.toFixed(0);
}

export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  const label = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(/\//g, "-");
}

/** Cumplimiento global: casos a tiempo sobre casos cerrados (cumplidos + incumplidos). */
export function overallCompliance(rows: SummaryRow[]): number | null {
  const met = rows.reduce((acc, r) => acc + (num(r.met_on_time) ?? 0), 0);
  const breached = rows.reduce((acc, r) => acc + (num(r.breached) ?? 0), 0);
  return met + breached === 0 ? null : (100 * met) / (met + breached);
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  readonly width = 595.28;
  readonly height = 841.89;
  readonly margin = 48;

  constructor(
    private readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage([this.width, this.height]);
    this.pages.push(this.page);
    this.y = this.height - this.margin;
  }

  ensure(space: number): void {
    if (this.y - space < this.margin + 24) this.newPage();
  }

  text(
    value: string,
    opts: { size?: number; bold?: boolean; x?: number; color?: [number, number, number] } = {},
  ): void {
    const size = opts.size ?? 10;
    this.ensure(size + 4);
    const [r, g, b] = opts.color ?? [0.07, 0.09, 0.15];
    this.page.drawText(toWinAnsi(value), {
      x: opts.x ?? this.margin,
      y: this.y - size,
      size,
      font: opts.bold ? this.bold : this.font,
      color: rgb(r, g, b),
    });
    this.y -= size + 5;
  }

  paragraph(value: string, size = 9): void {
    const maxWidth = this.width - 2 * this.margin;
    const words = toWinAnsi(value).split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        this.text(line, { size });
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) this.text(line, { size });
  }

  gap(points: number): void {
    this.y -= points;
  }

  /** Tabla simple: columnas con ancho fijo; trunca el texto que no cabe. */
  table(headers: string[], widths: number[], rows: string[][], size = 8): void {
    const rowHeight = size + 7;
    const drawRow = (cells: string[], header: boolean) => {
      this.ensure(rowHeight + 2);
      let x = this.margin;
      if (header) {
        this.page.drawRectangle({
          x: this.margin - 2,
          y: this.y - rowHeight + 2,
          width: widths.reduce((a, b) => a + b, 0) + 4,
          height: rowHeight,
          color: rgb(0.9, 0.93, 0.97),
        });
      }
      cells.forEach((cell, i) => {
        const width = widths[i] ?? 60;
        const font = header ? this.bold : this.font;
        let value = toWinAnsi(cell);
        while (value.length > 1 && font.widthOfTextAtSize(value, size) > width - 4)
          value = `${value.slice(0, -2)}…`;
        this.page.drawText(value, { x, y: this.y - size - 2, size, font, color: rgb(0.07, 0.09, 0.15) });
        x += width;
      });
      this.y -= rowHeight;
    };
    drawRow(headers, true);
    for (const row of rows) drawRow(row, false);
    this.gap(6);
  }

  footer(org: string, period: string): void {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      page.drawText(
        toWinAnsi(`Mesa de soporte Nexo · Yago · ${org} · ${period} · Página ${i + 1} de ${total}`),
        {
          x: this.margin,
          y: 24,
          size: 7,
          font: this.font,
          color: rgb(0.42, 0.45, 0.5),
        },
      );
    });
  }
}

export async function renderMonthlyReportPdf(data: ReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(`Informe mensual SLA ${data.periodo} - ${data.organizacion.nombre}`));
  doc.setAuthor("Yago - Mesa de soporte Nexo");
  doc.setSubject("Cumplimiento del SLA");
  doc.setLanguage("es-CL");
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );
  const period = periodLabel(data.periodo);

  w.text("Informe mensual de cumplimiento del SLA", { size: 16, bold: true });
  w.text(`${data.organizacion.nombre} · ${period}`, { size: 11 });
  w.text(`Generado el ${formatDateTime(data.generado_en ?? new Date().toISOString())} (hora de Santiago)`, {
    size: 8,
    color: [0.42, 0.45, 0.5],
  });
  w.gap(8);

  const overall = overallCompliance(data.resumen);
  w.text("Resumen", { size: 12, bold: true });
  w.text(`Tickets recibidos en el período: ${data.tickets.total}`);
  const bySeverity = ["S1", "S2", "S3", "S4"]
    .map((s) => `${s}: ${data.tickets.por_severidad[s] ?? 0}`)
    .join("   ");
  w.text(`Por severidad: ${bySeverity}`);
  w.text(`Cumplimiento global de plazos: ${formatPercent(overall)}`, { bold: true });
  w.text(`Incidentes de seguridad registrados: ${data.incidentes_seguridad}`);
  w.gap(8);

  w.text("Cumplimiento por severidad y métrica", { size: 12, bold: true });
  w.table(
    [
      "Sev.",
      "Métrica",
      "Plazo",
      "Casos",
      "A tiempo",
      "Fuera",
      "En curso",
      "Cumplimiento",
      "Prom. min",
      "Máx. min",
    ],
    [30, 62, 78, 36, 44, 36, 44, 64, 50, 50],
    data.resumen.map((r) => [
      r.severity,
      METRIC_LABEL[r.metric] ?? r.metric,
      formatTarget(r.target_minutes, r.calendar),
      String(r.total),
      String(r.met_on_time),
      String(r.breached),
      String(r.pending),
      formatPercent(r.compliance_pct),
      formatMinutes(r.avg_effective_minutes),
      formatMinutes(r.max_effective_minutes),
    ]),
  );
  w.paragraph(
    "S1 y S2 se miden en minutos corridos (24x7x365). S3 y S4 se miden en tiempo hábil: lunes a viernes de 09:00 a 18:00 (America/Santiago), sin feriados nacionales; 1 día hábil = 9 horas. Los minutos son efectivos: no incluyen las pausas por causas tipificadas. El cumplimiento considera los casos con el hito alcanzado o vencido.",
    8,
  );
  w.gap(8);

  w.text("Pausas del reloj (causas tipificadas)", { size: 12, bold: true });
  if (data.pausas.length === 0) {
    w.text("Sin pausas en el período.");
  } else {
    w.table(
      ["Motivo", "Cantidad", "Minutos", "Objetadas por SUBTEL"],
      [190, 70, 70, 120],
      data.pausas.map((p) => [
        PAUSE_LABEL[p.motivo] ?? p.motivo,
        String(p.cantidad),
        formatMinutes(p.minutos),
        String(p.objetadas),
      ]),
    );
  }
  w.gap(4);

  w.text("Plazos incumplidos", { size: 12, bold: true });
  if (data.incumplimientos.length === 0) {
    w.text("No hubo incumplimientos en el período.");
  } else {
    w.table(
      ["Ticket", "Sev.", "Métrica", "Venció", "Cumplido", "Título"],
      [74, 30, 66, 82, 82, 160],
      data.incumplimientos.map((i) => [
        i.numero,
        i.severidad,
        METRIC_LABEL[i.metrica] ?? i.metrica,
        formatDateTime(i.vencia),
        formatDateTime(i.cumplido),
        i.titulo,
      ]),
    );
  }

  const estados = Object.entries(data.tickets.por_estado ?? {});
  if (estados.length > 0) {
    w.gap(4);
    w.text("Estado actual de los tickets del período", { size: 12, bold: true });
    w.text(estados.map(([k, v]) => `${STATUS_LABEL[k] ?? k}: ${v}`).join("   "));
  }

  w.footer(data.organizacion.nombre, period);
  return await doc.save();
}
