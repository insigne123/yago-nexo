// Copia a build/evidencias lo que la página /evidencias anuncia en src/data/evidencias.json, para que Firebase
// Hosting lo sirva en /evidencias/<archivo>: cada video (MP4; WebM en el formato anterior) con su portada, sus
// subtítulos y capítulos WebVTT y su archivo de pasos (.pasos.json), más SHA256SUMS.txt. El índice
// evidencias.json no se copia (ya está en la página) y el archivo «sin música» tampoco (queda en release/evidencias
// para la verificación).
//
// Antes de copiar exige: SHA-256 del video igual al del índice, archivos anunciados presentes, pasos.json que no
// sea de ensayo y de la misma versión, y textos publicables (sin nombres de clientes ni códigos internos).
// Si release/evidencias no existe o no tiene videos, avisa y sigue: la página se genera igual.
//
// EVIDENCIAS_ORIGEN, EVIDENCIAS_DESTINO y EVIDENCIAS_INDICE cambian las rutas (solo para probar este script).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertPublic, fail, fromRepo, fromSite, readJson } from "./lib.mjs";

const SCRIPT = "copiar-evidencias.mjs";
const ORIGEN = process.env.EVIDENCIAS_ORIGEN ?? fromRepo("release/evidencias");
const DESTINO = process.env.EVIDENCIAS_DESTINO ?? fromSite("build/evidencias");
const INDICE = process.env.EVIDENCIAS_INDICE ?? fromSite("src/data/evidencias.json");
const VIDEO = /\.(webm|mp4)$/;
const SIN_MUSICA = /\.sin-musica\.mp4$/;

if (!existsSync(ORIGEN)) {
  console.log(`[${SCRIPT}] no existe ${ORIGEN}: se omite (grabe con pnpm --filter @nexo/evidencias grabar)`);
  process.exit(0);
}
const presentes = readdirSync(ORIGEN);
if (!presentes.some((f) => VIDEO.test(f) && !SIN_MUSICA.test(f))) {
  console.log(`[${SCRIPT}] ${ORIGEN} no tiene videos: se omite`);
  process.exit(0);
}

const { evidencias } = readJson(INDICE);
const sha256 = (ruta) => createHash("sha256").update(readFileSync(ruta)).digest("hex");
const publicable = (f) => {
  try {
    assertPublic(f, readFileSync(join(ORIGEN, f), "utf8"));
  } catch (e) {
    fail(SCRIPT, e instanceof Error ? e.message : String(e));
  }
};

mkdirSync(DESTINO, { recursive: true });
let copiados = 0;
const copiar = (f) => {
  copyFileSync(join(ORIGEN, f), join(DESTINO, f));
  copiados++;
};
const faltan = [];
for (const e of evidencias) {
  if (e.rehearsal === true) fail(SCRIPT, `${e.file}: es una grabación de ensayo; no se publica`);
  if (!existsSync(join(ORIGEN, e.file))) {
    faltan.push(e.file);
    continue;
  }
  if (sha256(join(ORIGEN, e.file)) !== e.sha256)
    fail(SCRIPT, `${e.file}: su SHA-256 no coincide con src/data/evidencias.json`);
  const textos = [e.subtitles, e.chapters_file, e.steps_file].filter(Boolean);
  for (const f of textos)
    if (!existsSync(join(ORIGEN, f))) fail(SCRIPT, `${f}: lo anuncia ${e.file} pero no está en ${ORIGEN}`);
  if (e.steps_file) {
    const pasos = readJson(join(ORIGEN, e.steps_file));
    if (pasos.ensayo !== false)
      fail(SCRIPT, `${e.steps_file}: grabación de ensayo (o sin «ensayo: false»); no se publica`);
    if (pasos.version !== e.version)
      fail(SCRIPT, `${e.steps_file}: versión ${pasos.version} distinta de la del índice (${e.version})`);
  }
  for (const f of textos) publicable(f);
  copiar(e.file);
  for (const f of textos) copiar(f);
  // Portada (fotograma de la portada de la grabación): se publica si existe.
  if (e.poster && existsSync(join(ORIGEN, e.poster))) copiar(e.poster);
}
if (existsSync(join(ORIGEN, "SHA256SUMS.txt"))) copiar("SHA256SUMS.txt");

const anunciados = new Set(evidencias.map((e) => e.file));
for (const f of presentes) {
  if (VIDEO.test(f) && !SIN_MUSICA.test(f) && !anunciados.has(f))
    console.log(`[${SCRIPT}] ${f} no está en src/data/evidencias.json: no se publica`);
}
if (faltan.length)
  console.log(`[${SCRIPT}] aviso: la página anuncia videos que no están en ${ORIGEN}: ${faltan.join(", ")}`);
console.log(`[${SCRIPT}] ${copiados} archivos copiados a build/evidencias`);
