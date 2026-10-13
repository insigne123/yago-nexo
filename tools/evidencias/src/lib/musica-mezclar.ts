/**
 * Vuelve a mezclar la música de videos ya grabados, sin regrabar ni recodificar la imagen: parte del
 * <nombre>.sin-musica.mp4 y del <nombre>.pasos.json que dejó la grabación y repite terminarVideo() (música con
 * -c:v copy, loudnorm en dos pasadas, comprobación del MD5 del flujo de video, subtítulos, capítulos y portada).
 * Sirve para cambiar la variante de un video o rehacer la mezcla; la imagen queda idéntica (mismo MD5 del flujo
 * de video) y cambian el SHA-256 del MP4 y los datos de la música, que se actualizan en evidencias.json y
 * SHA256SUMS.txt (y en su copia de apps/site/src/data si la carpeta es release/evidencias).
 *
 *   pnpm --filter @nexo/evidencias exec tsx src/lib/musica-mezclar.ts D-01 BT-005 [--variante 1|2|3] [--dir <carpeta>]
 *
 * Sin --variante se usa la del video (la que le toca por su identificador). Después: pnpm --filter
 * @nexo/evidencias verificar.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizarId } from "./cli.js";
import { desdeRaiz, SALIDA } from "./entorno.js";
import { VARIANTES, type Variante } from "./musica.js";
import { terminarVideo, type Publicacion } from "./video.js";

export interface EntradaMezcla {
  id: string;
  title: string;
  file: string;
  sha256: string;
}

export interface Indice<T extends EntradaMezcla = EntradaMezcla> {
  evidencias: T[];
  [k: string]: unknown;
}

/** Nombre base de un video publicado (D-01_descubrimiento.mp4 → D-01_descubrimiento). */
export const nombreBase = (file: string) => file.replace(/\.mp4$/, "");

/** El índice con la entrada `id` reemplazada por los datos nuevos del archivo (el resto de sus campos se conserva). */
export function actualizarIndice<T extends EntradaMezcla>(indice: Indice<T>, id: string, pub: Publicacion, generado = new Date().toISOString()): Indice<T> {
  if (!indice.evidencias.some((e) => e.id === id)) throw new Error(`${id} no está en evidencias.json`);
  return { ...indice, generado, evidencias: indice.evidencias.map((e) => (e.id === id ? { ...e, ...pub } : e)) };
}

/** SHA256SUMS.txt del índice (mismo formato que escribe grabar.ts). */
export function textoSumas(evidencias: ReadonlyArray<Pick<EntradaMezcla, "sha256" | "file">>): string {
  return `${evidencias.map((e) => `${e.sha256}  ${e.file}`).join("\n")}\n`;
}

export interface OpcionesRemezcla {
  carpeta: string;
  ids: string[];
  variante?: Variante;
  /** Carpeta de trabajo para el WAV intermedio. */
  temporal?: string;
  /** Copiar el índice y las sumas a apps/site/src/data (por defecto, solo si la carpeta es release/evidencias). */
  sitio?: boolean;
}

/** Rehace la mezcla de los videos pedidos y actualiza el índice de la carpeta. Devuelve los datos nuevos. */
export async function remezclar(o: OpcionesRemezcla): Promise<Publicacion[]> {
  const carpeta = resolve(o.carpeta);
  const rutaIndice = join(carpeta, "evidencias.json");
  if (!existsSync(rutaIndice)) throw new Error(`no existe ${rutaIndice}`);
  let indice = JSON.parse(readFileSync(rutaIndice, "utf8")) as Indice;
  const hechos: Publicacion[] = [];
  for (const id of o.ids) {
    const e = indice.evidencias.find((x) => x.id === id);
    if (!e) throw new Error(`${id} no está en ${rutaIndice}`);
    if (!e.file.endsWith(".mp4")) throw new Error(`${id}: ${e.file} es del formato anterior (sin pasos ni archivo sin música): hay que regrabarlo`);
    const nombre = nombreBase(e.file);
    const sinMusica = join(carpeta, `${nombre}.sin-musica.mp4`);
    if (!existsSync(sinMusica)) throw new Error(`${id}: falta ${sinMusica}`);
    const pub = await terminarVideo({ sinMusica, carpeta, nombre, id, titulo: `${id} · ${e.title}`, ...(o.variante ? { variante: o.variante } : {}), ...(o.temporal ? { temporal: o.temporal } : {}) });
    indice = actualizarIndice(indice, id, pub);
    // Se escribe después de cada video: si uno falla, los anteriores ya quedan registrados con su suma nueva.
    writeFileSync(rutaIndice, `${JSON.stringify(indice, null, 2)}\n`);
    writeFileSync(join(carpeta, "SHA256SUMS.txt"), textoSumas(indice.evidencias));
    hechos.push(pub);
  }
  if (o.sitio ?? carpeta === resolve(SALIDA)) {
    const datos = desdeRaiz("apps/site/src/data");
    copyFileSync(rutaIndice, join(datos, "evidencias.json"));
    copyFileSync(join(carpeta, "SHA256SUMS.txt"), join(datos, "SHA256SUMS.txt"));
  }
  return hechos;
}

async function principal(args: string[]): Promise<number> {
  const valor = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const textoVariante = valor("--variante");
  const variante = textoVariante === undefined ? undefined : (Number(textoVariante) as Variante);
  if (variante !== undefined && !VARIANTES.includes(variante)) {
    console.error(`--variante ${textoVariante}: use ${VARIANTES.join(", ")}`);
    return 2;
  }
  const conValor = new Set(["--variante", "--dir"]);
  const ids = args.filter((a, i) => !a.startsWith("--") && !conValor.has(args[i - 1] ?? "")).map(normalizarId);
  if (!ids.length) {
    console.error("Indique los videos: musica-mezclar.ts D-01 [BT-005 …] [--variante 1|2|3] [--dir <carpeta>]");
    return 2;
  }
  const trabajo = mkdtempSync(join(tmpdir(), "remezcla-"));
  try {
    const hechos = await remezclar({ carpeta: valor("--dir") ?? SALIDA, ids, ...(variante ? { variante } : {}), temporal: trabajo });
    for (const p of hechos) console.log(`${p.file}: variante ${p.music.variant}, ${p.music.integrated_lufs} LUFS, pico real ${p.music.true_peak_dbtp} dBTP · flujo de video ${p.video_stream_md5} (sin cambios) · SHA-256 ${p.sha256}`);
    console.log("Listo. Revise con: pnpm --filter @nexo/evidencias verificar");
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    rmSync(trabajo, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await principal(process.argv.slice(2).filter((a) => a !== "--"));
}
