/**
 * Codificación, música y medición de los videos con ffmpeg/ffprobe.
 *
 * Formato publicado (único): MP4 con H.264 (yuv420p, CRF 20, BT.709, +faststart) y AAC estéreo de 160 kb/s.
 *
 *   captura ──► transcodificar() o codificadorCuadros() ──► <nombre>.sin-musica.mp4   (la imagen se codifica UNA vez)
 *           ──► terminarVideo() ──► <nombre>.mp4             música mezclada con -c:v copy: la imagen no se toca
 *                                   <nombre>.vtt             subtítulos (paso y «qué pasa»)
 *                                   <nombre>.capitulos.vtt   capítulos (uno por paso)
 *                                   <nombre>.pasos.json      pasos con la duración medida
 *                                   <nombre>.jpg             portada para el reproductor
 *
 * terminarVideo() comprueba que el MD5 del flujo de video (ffmpeg -map 0:v -c copy -f md5 -) sea el mismo antes y
 * después de mezclar, y que el audio quede en −18 LUFS integrado con pico real ≤ −1,5 dBTP.
 *
 * Se usa el ffmpeg del sistema (/usr/bin/ffmpeg, con libx264). El de Playwright (solo VP8, sin ffprobe) sirve
 * únicamente para el formato anterior (WebM).
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AUTORIA, describir, ESTILO, FUNDIDO_ENTRADA_S, FUNDIDO_SALIDA_S, huellaPcm, sintetizar, varianteParaVideo, wav, type Variante } from "./musica.js";
import { capitulosIndice, capitulosVtt, nombresVtt, subtitulosVtt, validarPasos, type ArchivoPasos } from "./vtt.js";

const run = promisify(execFile);
const BUFFER = 64 * 1024 * 1024;

function ffmpegPlaywright(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith("ffmpeg"));
  const bin = dir ? join(base, dir, "ffmpeg-linux") : undefined;
  return bin && existsSync(bin) ? bin : undefined;
}

export const FFMPEG = existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : (ffmpegPlaywright() ?? "ffmpeg");
const FFPROBE = existsSync("/usr/bin/ffprobe") ? "/usr/bin/ffprobe" : undefined;

/** Objetivos de audio: −18 LUFS integrado (±1 al verificar), pico real ≤ −1,5 dBTP; loudnorm apunta a −2 dBTP. */
export const AUDIO = { lufs: -18, toleranciaLufs: 1, picoMaximo: -1.5, picoObjetivo: -2, lra: 20, kbps: 160, frecuencia: 48_000 } as const;

// ── H.264 ───────────────────────────────────────────────────────────────────────────────────────────────

export interface OpcionesH264 {
  ancho?: number;
  alto?: number;
  cps?: number;
  /** Calidad constante (menor = mejor). */
  crf?: number;
  /** Preset de x264; «medium» rinde bien en 4 núcleos (EVIDENCIAS_PRESET lo cambia). */
  preset?: string;
  hilos?: number;
}

export const H264: Required<OpcionesH264> = {
  ancho: 1920,
  alto: 1080,
  cps: 30,
  crf: 20,
  preset: process.env.EVIDENCIAS_PRESET ?? "medium",
  hilos: 4,
};

/** Filtro de video: escala a la resolución pedida, cuadros constantes y matriz BT.709 en rango limitado. */
export function filtroH264(o: OpcionesH264 = {}): string {
  const c = { ...H264, ...o };
  return `scale=${c.ancho}:${c.alto}:flags=lanczos:out_color_matrix=bt709:out_range=tv,fps=${c.cps},format=yuv420p`;
}

/** Argumentos de salida de x264 (sin audio): yuv420p, perfil high, GOP de 2 s, BT.709 y +faststart. */
export function argumentosH264(o: OpcionesH264 = {}): string[] {
  const c = { ...H264, ...o };
  return [
    "-c:v", "libx264",
    "-preset", c.preset,
    "-crf", String(c.crf),
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-g", String(c.cps * 2),
    "-keyint_min", String(c.cps),
    "-threads", String(c.hilos),
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-color_range", "tv",
    "-an",
    "-movflags", "+faststart",
    "-fflags", "+bitexact",
  ];
}

/**
 * Codifica una captura. Si el destino es .mp4 (formato vigente): H.264 a la resolución y cps de `o`
 * (1920×1080 a 30 cps por defecto), sin audio. Si es .webm (formato anterior): VP9 a 1280×720 y 15 cps.
 * `recorteSeg` descarta el comienzo de la captura (el instante previo a la portada).
 */
export async function transcodificar(origen: string, destino: string, recorteSeg = 0, o: OpcionesH264 = {}): Promise<void> {
  if (destino.endsWith(".webm")) return transcodificarWebm(origen, destino, recorteSeg);
  await exigirX264();
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", recorteSeg.toFixed(3), "-i", origen, "-vf", filtroH264(o), ...argumentosH264(o), "-f", "mp4", destino], { maxBuffer: BUFFER });
}

/**
 * Codificador que recibe cuadros sueltos (JPEG o PNG, p. ej. del screencast de Chromium) a cps constantes y
 * escribe el MP4 H.264 sin audio: la imagen se codifica una sola vez. Cada llamada a escribir() es un cuadro.
 */
export function codificadorCuadros(destino: string, o: OpcionesH264 & { formato?: "mjpeg" | "png" } = {}) {
  const c = { ...H264, ...o };
  const hijo = spawn(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", o.formato ?? "mjpeg", "-framerate", String(c.cps), "-i", "-", "-vf", filtroH264(c), ...argumentosH264(c), "-f", "mp4", destino],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let error = "";
  hijo.stderr.on("data", (d: Buffer) => (error += d.toString()));
  const fin = new Promise<void>((ok, mal) =>
    hijo.on("close", (codigo) => (codigo === 0 ? ok() : mal(new Error(`ffmpeg terminó con código ${codigo}: ${error.trim().slice(-400)}`)))),
  );
  let cuadros = 0;
  return {
    get cuadros() {
      return cuadros;
    },
    /** Escribe un cuadro; espera si ffmpeg va atrasado. */
    async escribir(cuadro: Buffer): Promise<void> {
      cuadros++;
      if (!hijo.stdin.write(cuadro)) await new Promise<void>((ok) => hijo.stdin.once("drain", () => ok()));
    },
    /** Cierra la entrada y espera a que el archivo quede escrito. */
    async terminar(): Promise<void> {
      hijo.stdin.end();
      await fin;
    },
  };
}

let x264: Promise<boolean> | undefined;
async function exigirX264(): Promise<void> {
  x264 ??= run(FFMPEG, ["-hide_banner", "-encoders"], { maxBuffer: BUFFER }).then(
    (r) => /libx264/.test(r.stdout),
    () => false,
  );
  if (!(await x264)) throw new Error(`${FFMPEG} no trae libx264: instale ffmpeg del sistema (apt install ffmpeg)`);
}

/** Formato anterior (1.0/1.1): VP9 en WebM a 1280×720 y 15 cps; VP8 a tasa fija si el ffmpeg no trae VP9. */
async function transcodificarWebm(origen: string, destino: string, recorteSeg: number): Promise<void> {
  const vp9 = FFMPEG === "/usr/bin/ffmpeg";
  const codec = vp9
    ? ["-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-tile-columns", "2", "-threads", "4"]
    : ["-c:v", "libvpx", "-b:v", "700k", "-crf", "12", "-qmin", "4", "-qmax", "48", "-deadline", "good", "-cpu-used", "4", "-threads", "3"];
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", recorteSeg.toFixed(2), "-i", origen, "-an", "-vf", "scale=1280:720,fps=15", ...codec, "-g", "300", destino], { maxBuffer: 16 * 1024 * 1024 });
}

// ── Análisis ────────────────────────────────────────────────────────────────────────────────────────────

export interface InfoAudio {
  codec: string;
  frecuencia: number;
  canales: number;
  kbps: number;
  duracion: number;
}

export interface InfoVideo {
  duracion: number;
  cuadros: number;
  ancho: number;
  alto: number;
  codec: string;
  /** Cuadros por segundo nominales (r_frame_rate) y medios (avg_frame_rate). */
  cps?: number;
  cpsMedio?: number;
  pixFmt?: string;
  perfil?: string;
  contenedor?: string;
  bytes?: number;
  kbps?: number;
  audio?: InfoAudio;
  /** Etiquetas del contenedor (title, comment…). */
  etiquetas: Record<string, string>;
}

export function racional(r?: string): number | undefined {
  if (!r) return undefined;
  const [a, b] = r.split("/").map(Number);
  if (!Number.isFinite(a) || !b) return undefined;
  return a! / b;
}

interface SalidaFfprobe {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    nb_frames?: string;
    nb_read_frames?: string;
    duration?: string;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
  }>;
  format?: { duration?: string; size?: string; format_name?: string; bit_rate?: string; tags?: Record<string, string> };
}

/** Interpreta la salida JSON de ffprobe (separado para probarlo sin archivos). */
export function leerFfprobe(j: SalidaFfprobe): InfoVideo {
  const v = j.streams?.find((s) => s.codec_type === "video") ?? j.streams?.[0];
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const cuadros = Number(v?.nb_read_frames ?? v?.nb_frames ?? 0);
  return {
    duracion: Number(j.format?.duration ?? v?.duration ?? 0),
    cuadros: Number.isFinite(cuadros) ? cuadros : 0,
    ancho: v?.width ?? 0,
    alto: v?.height ?? 0,
    codec: v?.codec_name ?? "?",
    cps: racional(v?.r_frame_rate),
    cpsMedio: racional(v?.avg_frame_rate),
    pixFmt: v?.pix_fmt,
    perfil: v?.profile,
    contenedor: j.format?.format_name,
    bytes: j.format?.size ? Number(j.format.size) : undefined,
    kbps: j.format?.bit_rate ? Number(j.format.bit_rate) / 1000 : undefined,
    audio: a
      ? { codec: a.codec_name ?? "?", frecuencia: Number(a.sample_rate ?? 0), canales: a.channels ?? 0, kbps: Number(a.bit_rate ?? 0) / 1000, duracion: Number(a.duration ?? 0) }
      : undefined,
    etiquetas: Object.fromEntries(Object.entries(j.format?.tags ?? {}).map(([k, val]) => [k.toLowerCase(), val])),
  };
}

/**
 * Describe el archivo. Con `decodificar` (por defecto) cuenta los cuadros decodificándolos todos (prueba de que
 * el archivo se lee completo); sin él usa el conteo del contenedor (rápido, MP4).
 */
export async function analizarVideo(archivo: string, o: { decodificar?: boolean } = {}): Promise<InfoVideo> {
  const decodificar = o.decodificar ?? true;
  if (FFPROBE) {
    const { stdout } = await run(
      FFPROBE,
      [
        "-v", "error",
        ...(decodificar ? ["-count_frames"] : []),
        "-show_entries",
        "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,sample_rate,channels,bit_rate:format=duration,size,format_name,bit_rate:format_tags",
        "-of", "json",
        archivo,
      ],
      { maxBuffer: BUFFER },
    );
    return leerFfprobe(JSON.parse(stdout) as SalidaFfprobe);
  }
  // Sin ffprobe: decodifica todo y lee el último «frame= N … time=HH:MM:SS.xx» del informe de ffmpeg.
  const r = await run(FFMPEG, ["-hide_banner", "-i", archivo, "-f", "null", "-"], { maxBuffer: BUFFER }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const err = String(r.stderr);
  const cuadros = [...err.matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  const t = [...err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const dim = /, (\d{3,4})x(\d{3,4})/.exec(err);
  return {
    duracion: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : 0,
    cuadros: Number(cuadros ?? 0),
    ancho: Number(dim?.[1] ?? 0),
    alto: Number(dim?.[2] ?? 0),
    codec: /Video: (\w+)/.exec(err)?.[1] ?? "?",
    etiquetas: {},
  };
}

/** MD5 del flujo de video sin decodificar (ffmpeg -map 0:v -c copy -f md5 -): igual ⇔ la imagen no se tocó. */
export async function hashFlujoVideo(archivo: string): Promise<string> {
  const { stdout } = await run(FFMPEG, ["-v", "error", "-i", archivo, "-map", "0:v", "-c", "copy", "-f", "md5", "-"], { maxBuffer: BUFFER });
  const m = /MD5=([0-9a-f]{32})/.exec(stdout);
  if (!m) throw new Error(`no se obtuvo el MD5 del flujo de video de ${archivo}`);
  return m[1]!;
}

export function sha256Archivo(archivo: string): Promise<string> {
  return new Promise((ok, mal) => {
    const h = createHash("sha256");
    createReadStream(archivo)
      .on("data", (d) => h.update(d))
      .on("end", () => ok(h.digest("hex")))
      .on("error", mal);
  });
}

/**
 * ¿Está el índice (moov) antes de los datos (mdat)? Es lo que hace +faststart: el navegador empieza a reproducir
 * sin descargar el archivo entero.
 */
export function moovAlInicio(archivo: string): boolean {
  const fd = openSync(archivo, "r");
  try {
    const total = fstatSync(fd).size;
    const cab = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= total) {
      readSync(fd, cab, 0, 16, pos);
      let largo = cab.readUInt32BE(0);
      const tipo = cab.toString("latin1", 4, 8);
      if (tipo === "moov") return true;
      if (tipo === "mdat") return false;
      if (largo === 1) largo = Number(cab.readBigUInt64BE(8));
      if (largo < 8) return false;
      pos += largo;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

// ── Sonoridad ───────────────────────────────────────────────────────────────────────────────────────────

export interface Sonoridad {
  /** Sonoridad integrada (LUFS). */
  integrado: number;
  /** Rango de sonoridad (LU). */
  lra: number;
  /** Pico real (dBTP). */
  picoReal: number;
}

/** Lee el resumen del filtro ebur128 (con peak=true). */
export function leerEbur128(texto: string): Sonoridad {
  const resumen = texto.slice(texto.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(resumen);
    if (!m) throw new Error(`resumen de ebur128 incompleto (${re.source})`);
    return m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  return { integrado: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), lra: num(/LRA:\s+(-?[\d.]+)\s+LU/), picoReal: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) };
}

/** Mide sonoridad integrada, rango y pico real del primer flujo de audio (ITU-R BS.1770 / EBU R128). */
export async function medirSonoridad(archivo: string): Promise<Sonoridad> {
  const r = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", archivo, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"], { maxBuffer: BUFFER });
  return leerEbur128(r.stderr);
}

export interface Estadisticas {
  picoDb: number;
  rmsDb: number;
  dc: number;
  /** Mayor salto entre muestras consecutivas (un clic se ve como un salto grande). */
  saltoMaximo: number;
  /** > 0 indica crestas planas (recorte). */
  factorPlano: number;
}

/** Lee la sección «Overall» de astats. */
export function leerAstats(texto: string): Estadisticas {
  const total = texto.slice(texto.lastIndexOf("Overall"));
  const num = (clave: string) => {
    const m = new RegExp(`${clave}:\\s*(-?[\\d.]+|-?inf)`).exec(total);
    if (!m) throw new Error(`astats sin «${clave}»`);
    return /inf/.test(m[1]!) ? (m[1]!.startsWith("-") ? -Infinity : Infinity) : Number(m[1]);
  };
  return { picoDb: num("Peak level dB"), rmsDb: num("RMS level dB"), dc: num("DC offset"), saltoMaximo: num("Max difference"), factorPlano: num("Flat factor") };
}

export async function medirAstats(archivo: string): Promise<Estadisticas> {
  const r = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", archivo, "-map", "0:a:0", "-af", "astats", "-f", "null", "-"], { maxBuffer: BUFFER });
  return leerAstats(r.stderr);
}

/**
 * Espectrograma (PNG) del audio de 0 a 8 kHz, para revisarlo a ojo. Se remuestrea a 16 kHz en vez de usar la
 * opción stop= de showspectrumpic, que en ffmpeg 6.1 dibuja las frecuencias en el lugar equivocado.
 */
export async function espectrograma(archivo: string, png: string, o: { ancho?: number; alto?: number } = {}): Promise<void> {
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", archivo, "-lavfi", `aresample=16000,showspectrumpic=s=${o.ancho ?? 1600}x${o.alto ?? 600}:legend=1:scale=log:color=intensity`, png], { maxBuffer: BUFFER });
}

/** Primera pasada de loudnorm: mide la entrada. */
export type MedicionLoudnorm = Record<string, string>;

/** Último objeto JSON impreso por loudnorm (print_format=json). */
export function leerLoudnorm(texto: string): MedicionLoudnorm {
  const fin = texto.lastIndexOf("}");
  const ini = texto.lastIndexOf("{", fin);
  if (ini < 0 || fin < 0) throw new Error("loudnorm no informó su medición");
  return JSON.parse(texto.slice(ini, fin + 1)) as MedicionLoudnorm;
}

const objetivoLoudnorm = `I=${AUDIO.lufs}:TP=${AUDIO.picoObjetivo}:LRA=${AUDIO.lra}`;

export async function medirLoudnorm(archivo: string): Promise<MedicionLoudnorm> {
  const r = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", archivo, "-map", "0:a:0", "-af", `loudnorm=${objetivoLoudnorm}:print_format=json`, "-f", "null", "-"], { maxBuffer: BUFFER });
  return leerLoudnorm(r.stderr);
}

/** Segunda pasada: ganancia lineal (no cambia la dinámica ni los fundidos) calculada desde la medición. */
export function filtroLoudnorm(m: MedicionLoudnorm): string {
  const v = (k: string) => {
    const x = m[k];
    if (x === undefined || !Number.isFinite(Number(x))) throw new Error(`medición de loudnorm sin «${k}»`);
    return x;
  };
  return `loudnorm=${objetivoLoudnorm}:measured_I=${v("input_i")}:measured_TP=${v("input_tp")}:measured_LRA=${v("input_lra")}:measured_thresh=${v("input_thresh")}:offset=${v("target_offset")}:linear=true:print_format=json`;
}

/**
 * Mezcla la música (WAV) con el video sin audio: el video se copia tal cual (-c:v copy) y el audio pasa por la
 * segunda pasada de loudnorm y se codifica en AAC de 160 kb/s a 48 kHz. Exige que loudnorm haya aplicado ganancia
 * lineal.
 */
export async function mezclarMusica(o: { video: string; musica: string; destino: string; metadatos?: Record<string, string>; medicion?: MedicionLoudnorm }): Promise<MedicionLoudnorm> {
  const medicion = o.medicion ?? (await medirLoudnorm(o.musica));
  const meta = Object.entries(o.metadatos ?? {}).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  const r = await run(
    FFMPEG,
    [
      "-y", "-hide_banner", "-nostats",
      "-i", o.video,
      "-i", o.musica,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", `${filtroLoudnorm(medicion)},aresample=${AUDIO.frecuencia}`,
      "-c:a", "aac",
      "-b:a", `${AUDIO.kbps}k`,
      "-ar", String(AUDIO.frecuencia),
      "-ac", "2",
      ...meta,
      // Sin contenido lingüístico (ISO 639-2 «zxx»).
      "-metadata:s:a:0", "language=zxx",
      "-metadata:s:a:0", "handler_name=Musica original (sintesis propia)",
      "-movflags", "+faststart",
      "-fflags", "+bitexact",
      "-flags:a", "+bitexact",
      "-f", "mp4",
      o.destino,
    ],
    { maxBuffer: BUFFER },
  );
  const salida = leerLoudnorm(r.stderr);
  if (salida.normalization_type !== "linear") {
    rmSync(o.destino, { force: true });
    throw new Error(`loudnorm no pudo aplicar ganancia lineal (${salida.normalization_type ?? "?"}): revise la música (pico ${medicion.input_tp} dBTP)`);
  }
  return salida;
}

// ── Cierre de un video ──────────────────────────────────────────────────────────────────────────────────

export const nombresVideo = (nombre: string) => ({
  ...nombresVtt(nombre),
  video: `${nombre}.mp4`,
  sinMusica: `${nombre}.sin-musica.mp4`,
  portada: `${nombre}.jpg`,
});

/** Datos del archivo publicado, para sumar a la entrada de evidencias.json (ver apps/site/src/data/evidencias.schema.json). */
export interface Publicacion {
  file: string;
  sha256: string;
  size_bytes: number;
  duration_seconds: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  poster?: string;
  steps_file: string;
  subtitles: string;
  chapters_file: string;
  chapters: Array<{ n: number; title: string; start_s: number; end_s: number }>;
  /** MD5 del flujo de video: igual en el archivo sin música y en el final. */
  video_stream_md5: string;
  without_music: { file: string; sha256: string; size_bytes: number };
  music: {
    style: string;
    variant: Variante;
    seed: number;
    author: string;
    description: string;
    pcm_sha256: string;
    integrated_lufs: number;
    true_peak_dbtp: number;
    lra_lu: number;
    fade_in_s: number;
    fade_out_s: number;
  };
  tools_commit: string;
  rehearsal: boolean;
}

export interface OpcionesTerminar {
  /** MP4 H.264 sin audio (de transcodificar o codificadorCuadros). Si no está en <carpeta>/<nombre>.sin-musica.mp4, se copia ahí. */
  sinMusica: string;
  /** Carpeta de salida (release/evidencias, o una de ensayo). */
  carpeta: string;
  /** Nombre base, p. ej. «D-01_descubrimiento». */
  nombre: string;
  /** Identificador de la demostración: elige la variante de música (siempre la misma para el mismo id). */
  id: string;
  /** Metadato «title» del MP4. */
  titulo: string;
  /** Pasos del video; si se omite, se lee <carpeta>/<nombre>.pasos.json. */
  pasos?: ArchivoPasos;
  variante?: Variante;
  /** Carpeta de trabajo para el WAV intermedio (por defecto, la temporal del sistema). */
  temporal?: string;
  /** Segundo del que se toma la portada (false: no se genera). */
  segundoPortada?: number | false;
}

const redondear = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Cierra un video: valida los pasos contra el archivo, mezcla la música (sin recodificar la imagen y comprobándolo),
 * escribe los subtítulos, los capítulos y el pasos.json definitivo (con la duración medida) y devuelve los datos
 * para evidencias.json. Si algo no cuadra, lanza un error y no deja el MP4 final.
 */
export async function terminarVideo(o: OpcionesTerminar): Promise<Publicacion> {
  const n = nombresVideo(o.nombre);
  const carpeta = resolve(o.carpeta);
  const rutaPasos = join(carpeta, n.pasos);
  const crudo = o.pasos ?? (JSON.parse(readFileSync(rutaPasos, "utf8")) as ArchivoPasos);
  const v = validarPasos(crudo);
  if (!v.ok || !v.pasos) throw new Error(`${n.pasos}: ${v.problemas.join("; ")}`);
  const pasos: ArchivoPasos = { ...v.pasos, pasos: v.pasos.pasos.map((p) => ({ ...p, comprueba: [...p.comprueba] })) };

  const info = await analizarVideo(o.sinMusica, { decodificar: false });
  const problemas: string[] = [];
  if (info.codec !== "h264") problemas.push(`códec ${info.codec} (se espera h264)`);
  if (info.pixFmt !== "yuv420p") problemas.push(`formato de píxel ${info.pixFmt ?? "?"} (se espera yuv420p)`);
  if (info.ancho !== pasos.ancho || info.alto !== pasos.alto) problemas.push(`resolución ${info.ancho}×${info.alto} y pasos.json declara ${pasos.ancho}×${pasos.alto}`);
  if (info.cps === undefined || Math.abs(info.cps - pasos.cps) > 0.01) problemas.push(`${info.cps ?? "?"} cps y pasos.json declara ${pasos.cps}`);
  if (Math.abs(info.duracion - pasos.duracion_s) > 1) problemas.push(`dura ${info.duracion.toFixed(2)} s y pasos.json declara ${pasos.duracion_s} s`);
  if (problemas.length) throw new Error(`${o.nombre}: ${problemas.join("; ")}`);
  pasos.duracion_s = redondear(info.duracion);
  const ultimo = pasos.pasos.at(-1)!;
  if (ultimo.fin_s > pasos.duracion_s) ultimo.fin_s = pasos.duracion_s;

  const sinMusica = join(carpeta, n.sinMusica);
  if (resolve(o.sinMusica) !== sinMusica) copyFileSync(o.sinMusica, sinMusica);

  const variante = o.variante ?? varianteParaVideo(o.id);
  const trabajo = mkdtempSync(join(o.temporal ?? tmpdir(), `musica-${o.id}-`));
  const destino = join(carpeta, n.video);
  const parcial = `${destino}.parcial`;
  try {
    const pista = sintetizar(info.duracion, variante);
    const rutaWav = join(trabajo, "musica.wav");
    writeFileSync(rutaWav, wav(pista));
    const md5Antes = await hashFlujoVideo(sinMusica);
    const ensayo = pasos.ensayo ? "ENSAYO · " : "";
    await mezclarMusica({
      video: sinMusica,
      musica: rutaWav,
      destino: parcial,
      metadatos: {
        title: `${ensayo}${o.titulo}`,
        comment: `${pasos.producto} ${pasos.version} (commit ${pasos.commit_producto}) · herramientas ${pasos.commit_herramientas} · ${pasos.ensayo ? "ENSAYO: no publicable" : "grabación registrada"} · ${AUTORIA}`,
      },
    });
    const md5Despues = await hashFlujoVideo(parcial);
    if (md5Antes !== md5Despues) throw new Error(`la mezcla alteró el flujo de video (${md5Antes} ≠ ${md5Despues})`);
    const son = await medirSonoridad(parcial);
    if (Math.abs(son.integrado - AUDIO.lufs) > AUDIO.toleranciaLufs || son.picoReal > AUDIO.picoMaximo) {
      throw new Error(`audio fuera de norma: ${son.integrado} LUFS, pico real ${son.picoReal} dBTP`);
    }
    renameSync(parcial, destino);

    writeFileSync(rutaPasos, `${JSON.stringify(pasos, null, 2)}\n`);
    writeFileSync(join(carpeta, n.subtitulos), subtitulosVtt(pasos));
    writeFileSync(join(carpeta, n.capitulos), capitulosVtt(pasos));
    if (o.segundoPortada !== false) await portada(destino, join(carpeta, n.portada), o.segundoPortada ?? 3);

    const final = await analizarVideo(destino, { decodificar: false });
    return {
      file: n.video,
      sha256: await sha256Archivo(destino),
      size_bytes: statSync(destino).size,
      duration_seconds: redondear(final.duracion, 1),
      frames: final.cuadros,
      width: final.ancho,
      height: final.alto,
      fps: redondear(final.cps ?? pasos.cps, 3),
      ...(o.segundoPortada !== false ? { poster: n.portada } : {}),
      steps_file: n.pasos,
      subtitles: n.subtitulos,
      chapters_file: n.capitulos,
      chapters: capitulosIndice(pasos),
      video_stream_md5: md5Despues,
      without_music: { file: n.sinMusica, sha256: await sha256Archivo(sinMusica), size_bytes: statSync(sinMusica).size },
      music: {
        style: ESTILO,
        variant: variante,
        seed: pista.plan.semilla,
        author: AUTORIA,
        description: describir(pista.plan),
        pcm_sha256: huellaPcm(pista),
        integrated_lufs: son.integrado,
        true_peak_dbtp: son.picoReal,
        lra_lu: son.lra,
        fade_in_s: FUNDIDO_ENTRADA_S,
        fade_out_s: FUNDIDO_SALIDA_S,
      },
      tools_commit: pasos.commit_herramientas,
      rehearsal: pasos.ensayo,
    };
  } finally {
    rmSync(parcial, { force: true });
    rmSync(trabajo, { recursive: true, force: true });
  }
}

/** Imagen de portada (JPEG) tomada de la portada de la grabación, para el reproductor del sitio. */
export async function portada(video: string, destino: string, segundo = 3): Promise<void> {
  await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(segundo), "-i", video, "-frames:v", "1", "-q:v", "4", destino]);
}
