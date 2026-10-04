/**
 * Verifica los videos publicados en release/evidencias contra su índice: que existan, que duren 3 minutos o
 * menos, que tengan cuadros decodificables, que su SHA-256 coincida con evidencias.json y SHA256SUMS.txt y que
 * todas sus verificaciones del escenario se hayan cumplido.
 *
 *   pnpm --filter @nexo/evidencias verificar
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMOS } from "./demos/index.js";
import { desdeRaiz, SALIDA } from "./lib/entorno.js";
import type { Evidencia } from "./lib/grabador.js";
import { analizarVideo } from "./lib/video.js";

const INDICE = join(SALIDA, "evidencias.json");
if (!existsSync(INDICE)) {
  console.error(`No existe ${INDICE}: grabe primero (pnpm --filter @nexo/evidencias grabar)`);
  process.exit(1);
}
const { evidencias } = JSON.parse(readFileSync(INDICE, "utf8")) as { evidencias: Evidencia[] };
const sumas = new Map(
  readFileSync(join(SALIDA, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(/\s+/))
    .map(([h, f]) => [f!, h!]),
);
const copia = desdeRaiz("apps/site/src/data/evidencias.json");
const sitio = existsSync(copia) ? (JSON.parse(readFileSync(copia, "utf8")) as { evidencias: Evidencia[] }).evidencias : [];

const problemas: string[] = [];
const filas: Array<Record<string, unknown>> = [];
for (const e of evidencias) {
  const archivo = join(SALIDA, e.file);
  if (!existsSync(archivo)) {
    problemas.push(`${e.id}: falta ${e.file}`);
    continue;
  }
  const info = await analizarVideo(archivo);
  const hash = createHash("sha256").update(readFileSync(archivo)).digest("hex");
  const ok = {
    duracion: info.duracion > 0 && info.duracion <= 180,
    cuadros: info.cuadros > 0,
    tamano: info.ancho === 1280 && info.alto === 720,
    hash: hash === e.sha256 && sumas.get(e.file) === hash,
    sitio: sitio.some((s) => s.id === e.id && s.sha256 === hash),
    escenario: e.checks.length > 0 && e.checks.every((c) => c.ok),
  };
  for (const [k, v] of Object.entries(ok)) if (!v) problemas.push(`${e.id}: no cumple «${k}»`);
  filas.push({ id: e.id, archivo: e.file, segundos: info.duracion.toFixed(1), cuadros: info.cuadros, códec: info.codec, MB: (readFileSync(archivo).length / 1048576).toFixed(1), verificaciones: `${e.checks.filter((c) => c.ok).length}/${e.checks.length}`, ok: Object.values(ok).every(Boolean) });
}
console.table(filas);
const faltan = DEMOS.filter((d) => !evidencias.some((e) => e.id === d.id)).map((d) => d.id);
if (faltan.length) console.log(`Sin grabar todavía: ${faltan.join(", ")}`);
if (problemas.length) {
  console.error(`\n${problemas.length} problemas:\n  ${problemas.join("\n  ")}`);
  process.exit(1);
}
console.log(`\n${evidencias.length} videos verificados: duración ≤ 180 s, cuadros decodificables, SHA-256 coincidente y escenario cumplido.`);
