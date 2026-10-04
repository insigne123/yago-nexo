import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Reporte de exposición en PDF (D-01): resumen y hallazgos ordenados por puntaje, con sus motivos.
 * Usa las fuentes estándar del PDF (WinAnsi), así que el texto se normaliza a ese juego de caracteres.
 */
export interface ReportFinding {
  source: string;
  host: string;
  port?: number;
  path: string;
  authDetected: string;
  personalDataSuspected: boolean;
  matchedApiId?: string;
  exposureScore: number;
  reasons: string[];
  status: string;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;

/** Reemplaza lo que WinAnsi no puede representar (las tildes y la ñ sí están). */
function ansi(text: string): string {
  return text
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF—–•·€]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = ansi(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function discoveryReportPdf(opts: { environment: string; generatedAt: string; findings: ReportFinding[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Reporte de exposición de APIs");
  doc.setAuthor("Yago Nexo");
  doc.setCreator("Consola Nexo");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  const width = A4[0] - MARGIN * 2;
  const text = (t: string, x: number, size = 9, f = font, color = rgb(0.13, 0.15, 0.2)) => page.drawText(ansi(t), { x, y, size, font: f, color });
  const newPageIfNeeded = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage(A4);
      y = A4[1] - MARGIN;
    }
  };

  text("Reporte de exposición de APIs no gobernadas", MARGIN, 16, bold);
  y -= 20;
  text(`${opts.environment} · generado el ${opts.generatedAt.replace("T", " ").slice(0, 19)} UTC`, MARGIN, 9, font, rgb(0.4, 0.42, 0.48));
  y -= 24;
  const ungoverned = opts.findings.filter((f) => !f.matchedApiId).length;
  const high = opts.findings.filter((f) => f.exposureScore >= 70).length;
  for (const [label, value] of [
    ["Hallazgos", opts.findings.length],
    ["No gobernados", ungoverned],
    ["Exposición alta (70 o más)", high],
  ] as const) {
    text(String(value), MARGIN, 18, bold);
    text(label, MARGIN + 40, 10);
    y -= 24;
  }
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.6, color: rgb(0.8, 0.82, 0.86) });
  y -= 18;

  for (const f of opts.findings) {
    const target = `${f.host}${f.port ? `:${f.port}` : ""}${f.path}`;
    const reasonLines = f.reasons.flatMap((r) => wrap(`• ${r}`, font, 8.5, width - 52));
    const meta = wrap(
      `${f.source.toUpperCase()} · autenticación: ${f.authDetected} · ${f.personalDataSuspected ? "posibles datos personales" : "sin datos personales detectados"} · ${f.matchedApiId ? "asociada a una API gobernada" : "no gobernada"} · estado: ${f.status.replace(/_/g, " ")}`,
      font,
      8.5,
      width - 40,
    );
    newPageIfNeeded(40 + (reasonLines.length + meta.length) * 11);
    const color = f.exposureScore >= 70 ? rgb(0.75, 0.16, 0.16) : f.exposureScore >= 40 ? rgb(0.8, 0.5, 0.05) : rgb(0.2, 0.5, 0.25);
    text(String(f.exposureScore), MARGIN, 14, bold, color);
    for (const line of wrap(target, bold, 10, width - 52).slice(0, 2)) {
      text(line, MARGIN + 40, 10, bold);
      y -= 13;
    }
    for (const line of meta) {
      text(line, MARGIN + 40, 8.5, font, rgb(0.35, 0.37, 0.43));
      y -= 11;
    }
    y -= 2;
    for (const line of reasonLines) {
      text(line, MARGIN + 46, 8.5);
      y -= 11;
    }
    y -= 10;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) =>
    p.drawText(ansi(`Yago Nexo · Descubrimiento de APIs (D-01) · página ${i + 1} de ${pages.length}`), { x: MARGIN, y: 24, size: 7.5, font, color: rgb(0.55, 0.57, 0.62) }),
  );
  return doc.save();
}
