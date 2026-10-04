// Copia los videos de las demostraciones registradas (release/evidencias, fuera de git) a build/evidencias para
// que Firebase Hosting los sirva en /evidencias/<archivo>. Si no hay videos, avisa y sigue: la página
// /evidencias se genera igual desde src/data/evidencias.json.
// Se publican los videos, su imagen de portada y SHA256SUMS.txt; el índice evidencias.json no se copia (ya está
// en la página).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fail, fromRepo, fromSite, readJson } from "./lib.mjs";

const SCRIPT = "copiar-evidencias.mjs";
const ORIGEN = fromRepo("release/evidencias");
const DESTINO = fromSite("build/evidencias");
const PUBLICAR = /\.(webm|mp4|jpg)$|^SHA256SUMS\.txt$/;

if (!existsSync(ORIGEN)) {
  console.log(`[${SCRIPT}] no existe ${ORIGEN}: se omite (grabe con pnpm --filter @nexo/evidencias grabar)`);
  process.exit(0);
}
const archivos = readdirSync(ORIGEN).filter((f) => PUBLICAR.test(f));
if (archivos.length === 0) {
  console.log(`[${SCRIPT}] ${ORIGEN} no tiene videos: se omite`);
  process.exit(0);
}

// Solo se publica lo que la página anuncia, y con la misma suma SHA-256.
const { evidencias } = readJson(fromSite("src/data/evidencias.json"));
const anunciados = new Map(evidencias.map((e) => [e.file, e.sha256]));
mkdirSync(DESTINO, { recursive: true });
let copiados = 0;
for (const f of archivos) {
  const ruta = join(ORIGEN, f);
  if (f.endsWith(".jpg")) {
    // Portada del video (fotograma de la portada de la grabación): se publica si su video se publica.
    if (!anunciados.has(f.replace(/\.jpg$/, ".webm"))) continue;
  } else if (f !== "SHA256SUMS.txt") {
    if (!anunciados.has(f)) {
      console.log(`[${SCRIPT}] ${f} no está en src/data/evidencias.json: no se publica`);
      continue;
    }
    const hash = createHash("sha256").update(readFileSync(ruta)).digest("hex");
    if (hash !== anunciados.get(f)) fail(SCRIPT, `${f}: su SHA-256 no coincide con src/data/evidencias.json`);
  }
  copyFileSync(ruta, join(DESTINO, f));
  copiados++;
}
const faltan = [...anunciados.keys()].filter((f) => !archivos.includes(f));
if (faltan.length) console.log(`[${SCRIPT}] aviso: la página anuncia videos que no están en ${ORIGEN}: ${faltan.join(", ")}`);
console.log(`[${SCRIPT}] ${copiados} archivos copiados a build/evidencias`);
