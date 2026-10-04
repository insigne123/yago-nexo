// Utilidades comunes de los scripts de generación del sitio (Node 22, sin dependencias de red).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(siteDir, "../..");
export const fromRepo = (...parts) => resolve(repoRoot, ...parts);
export const fromSite = (...parts) => resolve(siteDir, ...parts);
export const rel = (path) => relative(repoRoot, path);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeGenerated(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
}

/** Encabezado de los archivos Markdown generados (comentario HTML, válido en MDX y en CommonMark). */
export function banner(script, ...sources) {
  return `<!-- Archivo generado por apps/site/scripts/${script} desde ${sources.join(", ")}. No editar a mano. -->\n`;
}

/** Texto seguro para MDX: escapa los caracteres que MDX interpreta como JSX o expresiones. */
export function mdText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([{}<>])/g, "\\$1");
}

/** Texto seguro dentro de una celda de tabla GFM (una sola línea). */
export function cell(value) {
  return mdText(value)
    .replace(/\|/g, "\\|")
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/** Código en línea. Dentro de tablas se escapa la barra vertical. */
export function code(value, { inTable = false } = {}) {
  const text = String(value);
  const fence = text.includes("`") ? "``" : "`";
  const body = inTable ? text.replace(/\|/g, "\\|") : text;
  return `${fence}${body}${fence}`;
}

export function table(headers, rows, align = []) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map((_, i) => (align[i] === "center" ? ":-:" : "---")).join(" | ")} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/**
 * Contenido que no debe aparecer en el sitio público: referencias a clientes o procesos de
 * compra específicos, códigos internos de requisitos, precios y nombres de personas del equipo.
 * Lo usan gen-api-docs.mjs (antes de escribir) y check-public-content.mjs (después del build).
 */
export const FORBIDDEN = [
  { re: /SUBTEL/i, motivo: "nombre de una institución cliente" },
  { re: /licitaci[oó]n/i, motivo: "referencia a un proceso de compra" },
  { re: /mercado\s*p[uú]blico/i, motivo: "referencia a un proceso de compra" },
  { re: /\b606-26-LE26\b/, motivo: "identificador de un proceso de compra" },
  { re: /\bBT-\d{3}\b/, motivo: "código interno de requisito" },
  { re: /\bD-0[1-8]\b/, motivo: "código interno de requisito" },
  { re: /criterio\s+N[°º]\s*\d/i, motivo: "criterio de evaluación" },
  { re: /US\$\s?\d|\bUSD\s?\d/, motivo: "precio" },
  { re: /\b(?:Donders|Cristian|Nicol[aá]s)\b/, motivo: "nombre de una persona del equipo" },
];

export function findForbidden(text) {
  const hits = [];
  for (const { re, motivo } of FORBIDDEN) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(global)) {
      const start = Math.max(0, m.index - 40);
      const snippet = text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ");
      hits.push({ match: m[0], motivo, snippet });
    }
  }
  return hits;
}

export function assertPublic(label, text) {
  const hits = findForbidden(text);
  if (hits.length > 0) {
    const detail = hits.map((h) => `  - "${h.match}" (${h.motivo}): …${h.snippet}…`).join("\n");
    throw new Error(`${label} contiene texto no publicable:\n${detail}`);
  }
}

export function fail(script, message) {
  console.error(`[${script}] ERROR: ${message}`);
  process.exit(1);
}
