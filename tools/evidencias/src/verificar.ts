/**
 * Verifica los videos de release/evidencias contra su índice antes de publicarlos. Cada video debe:
 *   - ser MP4 H.264 (yuv420p, +faststart) con audio AAC estéreo a 48 kHz;
 *   - tener la resolución y los cps declarados en su pasos.json (1920×1080 a 30 cps, o la alternativa
 *     permitida: 1600×900 / 25 cps), durar 240 s o menos, con cada paso de 7 s o más;
 *   - sonar a −18 LUFS integrado (±1) con pico real ≤ −1,5 dBTP;
 *   - tener el SHA-256 de evidencias.json, de SHA256SUMS.txt y de la copia del sitio;
 *   - tener el mismo flujo de video (MD5 sin decodificar) que su archivo sin música: la música no tocó la imagen;
 *   - no ser un ensayo (pasos.json con ensayo:true o rotulado ENSAYO): un ensayo nunca se publica;
 *   - tener subtítulos y capítulos WebVTT iguales a los que se generan desde su pasos.json;
 *   - tener todas sus verificaciones del escenario cumplidas.
 *
 *   pnpm --filter @nexo/evidencias verificar
 *   pnpm --filter @nexo/evidencias verificar -- --dir <carpeta> [--sin-sitio] [--rapido] [--permitir-anteriores]
 *
 * --dir revisa otra carpeta (p. ej. una de ensayo); --sin-sitio no compara con apps/site/src/data; --rapido no
 * decodifica los cuadros (usa el conteo del contenedor). --permitir-anteriores acepta las entradas del formato
 * anterior (WebM de 1.0/1.1, que se conservan como respaldo si una toma nueva no queda bien) revisando solo su
 * integridad (archivo, cuadros, SHA-256 y escenario); se informan aparte y nunca pasan por formato vigente.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { desdeRaiz, SALIDA } from "./lib/entorno.js";
import { analizarVideo, AUDIO, hashFlujoVideo, medirSonoridad, moovAlInicio, sha256Archivo, type InfoVideo, type Sonoridad } from "./lib/video.js";
import { capitulosVtt, REGLAS, subtitulosVtt, validarPasos, type ArchivoPasos } from "./lib/vtt.js";

/** Lo que se lee de cada entrada de evidencias.json (formato vigente y anterior). */
export interface EntradaEvidencia {
  id: string;
  file: string;
  sha256: string;
  duration_seconds: number;
  version: string;
  commit: string;
  checks: Array<{ texto: string; ok: boolean; detalle?: string }>;
  steps_file?: string;
  subtitles?: string;
  chapters_file?: string;
  video_stream_md5?: string;
  without_music?: { file: string; sha256: string; size_bytes?: number };
  rehearsal?: boolean;
}

export interface Criterio {
  clave: string;
  ok: boolean;
  detalle: string;
}

export interface ResultadoVerificacion {
  id: string;
  ok: boolean;
  criterios: Criterio[];
  info?: InfoVideo;
  sonoridad?: Sonoridad;
  /** Se verificó como respaldo del formato anterior (solo integridad). */
  anterior?: boolean;
}

export interface OpcionesVerificacion {
  carpeta: string;
  /** Contenido de SHA256SUMS.txt (archivo → suma). */
  sumas: Map<string, string>;
  /** Entradas de la copia del sitio; null: no se compara. */
  sitio: Array<{ id: string; sha256: string }> | null;
  /** Decodificar todos los cuadros (por defecto sí). */
  decodificar?: boolean;
  /** Aceptar entradas del formato anterior (WebM) revisando solo su integridad. */
  permitirAnteriores?: boolean;
}

/** Entrada del formato anterior (WebM de 1.0/1.1, sin pasos.json, sin audio). */
export const esFormatoAnterior = (e: Pick<EntradaEvidencia, "file">) => e.file.endsWith(".webm");

const fmt = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) ? String(x) : x.toFixed(d));

export function leerSumas(texto: string): Map<string, string> {
  return new Map(
    texto
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+\*?/))
      .map(([h, f]) => [f!, h!]),
  );
}

/** Verifica una entrada del índice. No lanza: cada problema queda como un criterio no cumplido. */
export async function verificarEvidencia(e: EntradaEvidencia, o: OpcionesVerificacion): Promise<ResultadoVerificacion> {
  const criterios: Criterio[] = [];
  const poner = (clave: string, ok: boolean, detalle: string) => criterios.push({ clave, ok, detalle });
  const ruta = (f: string) => join(o.carpeta, f);
  const archivo = ruta(e.file);
  if (!existsSync(archivo)) {
    poner("archivo", false, `falta ${e.file}`);
    return { id: e.id, ok: false, criterios };
  }
  if (o.permitirAnteriores && esFormatoAnterior(e)) return verificarAnterior(e, o, archivo);
  poner("archivo", e.file.endsWith(".mp4"), e.file.endsWith(".mp4") ? e.file : `${e.file}: formato anterior; el formato publicado es MP4`);

  // Pasos (reglas de publicación).
  let pasos: ArchivoPasos | undefined;
  if (!e.steps_file || !existsSync(ruta(e.steps_file))) {
    poner("pasos", false, e.steps_file ? `falta ${e.steps_file}` : "la entrada no declara su pasos.json (formato anterior)");
  } else {
    let datos: unknown;
    try {
      datos = JSON.parse(readFileSync(ruta(e.steps_file), "utf8"));
    } catch (err) {
      datos = undefined;
      poner("pasos", false, `${e.steps_file}: JSON inválido (${err instanceof Error ? err.message : String(err)})`);
    }
    if (datos !== undefined) {
      const estructura = validarPasos(datos);
      pasos = estructura.pasos;
      const v = validarPasos(datos, { publicar: true });
      const sinEnsayo = v.problemas.filter((p) => !p.includes("ENSAYO"));
      poner("pasos", estructura.ok && sinEnsayo.length === 0, sinEnsayo.length ? sinEnsayo.join("; ") : `${pasos?.pasos.length ?? 0} pasos, cada uno ≥ ${REGLAS.pasoMinimo} s`);
    }
  }

  const info = await analizarVideo(archivo, { decodificar: o.decodificar ?? true }).catch(() => undefined);
  if (!info) {
    poner("formato", false, "ffprobe no pudo leer el archivo");
    return { id: e.id, ok: false, criterios };
  }

  // Ensayo: nunca se publica (se mira el pasos.json, el índice y la etiqueta del propio MP4).
  const etiquetaEnsayo = /ENSAYO/i.test(`${info.etiquetas.title ?? ""} ${info.etiquetas.comment ?? ""}`);
  const ensayo = pasos?.ensayo === true || e.rehearsal === true || etiquetaEnsayo;
  poner("no es ensayo", !ensayo, ensayo ? "grabación de ENSAYO: no se publica" : "grabación registrada");

  // Producto y versión.
  if (pasos) {
    const cp = pasos.commit_producto;
    const mismoCommit = cp.startsWith(e.commit) || e.commit.startsWith(cp);
    const enEtiqueta = (info.etiquetas.comment ?? "").includes(`${pasos.producto} ${pasos.version}`);
    poner(
      "versión",
      pasos.version === e.version && mismoCommit && enEtiqueta,
      `${pasos.producto} ${pasos.version} (commit ${cp})${pasos.version !== e.version ? ` ≠ índice ${e.version}` : ""}${mismoCommit ? "" : ` ≠ commit del índice ${e.commit}`}${enEtiqueta ? "" : " · la etiqueta del MP4 no identifica producto y versión"}`,
    );
  }

  // Formato.
  const faststart = info.contenedor?.includes("mp4") ? moovAlInicio(archivo) : false;
  const formatoOk = !!info.contenedor?.includes("mp4") && info.codec === "h264" && info.pixFmt === "yuv420p" && faststart;
  poner("formato", formatoOk, `${info.contenedor ?? "?"} · ${info.codec} ${info.perfil ?? ""} · ${info.pixFmt ?? "?"} · ${faststart ? "+faststart" : "sin faststart"}`);

  const ancho = pasos?.ancho ?? 1920;
  const alto = pasos?.alto ?? 1080;
  const cps = pasos?.cps ?? 30;
  const permitida = REGLAS.resoluciones.some(([w, h]) => w === ancho && h === alto);
  poner("resolución", info.ancho === ancho && info.alto === alto && permitida, `${info.ancho}×${info.alto} (declarada ${ancho}×${alto})`);
  const cpsOk = info.cps !== undefined && Math.abs(info.cps - cps) < 0.01 && info.cpsMedio !== undefined && Math.abs(info.cpsMedio - cps) < 0.5 && REGLAS.cps.includes(cps);
  poner("cps", cpsOk, `${fmt(info.cps, 2)} nominales, ${fmt(info.cpsMedio, 2)} medios (declarados ${cps})`);

  // Audio.
  const a = info.audio;
  const audioOk = !!a && a.codec === "aac" && a.frecuencia === AUDIO.frecuencia && a.canales === 2 && a.kbps >= AUDIO.kbps * 0.75 && a.kbps <= AUDIO.kbps * 1.25;
  poner("audio", audioOk, a ? `${a.codec} ${a.frecuencia} Hz ${a.canales} canales ${fmt(a.kbps, 0)} kb/s` : "sin audio");
  let sonoridad: Sonoridad | undefined;
  if (a) {
    sonoridad = await medirSonoridad(archivo).catch(() => undefined);
    const ok = !!sonoridad && Math.abs(sonoridad.integrado - AUDIO.lufs) <= AUDIO.toleranciaLufs && sonoridad.picoReal <= AUDIO.picoMaximo;
    poner("sonoridad", ok, sonoridad ? `${fmt(sonoridad.integrado)} LUFS (objetivo ${AUDIO.lufs} ±${AUDIO.toleranciaLufs}), pico real ${fmt(sonoridad.picoReal)} dBTP (máx. ${AUDIO.picoMaximo})` : "no se pudo medir");
  } else poner("sonoridad", false, "sin audio");

  // Duración (tope de 240 s) y cuadros.
  const d = info.duracion;
  const durOk = d > 0 && d <= REGLAS.duracionMaxima + 0.05 && Math.abs(d - e.duration_seconds) <= 0.5 && (!pasos || Math.abs(d - pasos.duracion_s) <= 0.5);
  poner("duración", durOk, `${fmt(d)} s (máx. ${REGLAS.duracionMaxima}; índice ${e.duration_seconds}${pasos ? `; pasos ${pasos.duracion_s}` : ""})`);
  const esperados = d * cps;
  poner("cuadros", info.cuadros > 0 && Math.abs(info.cuadros - esperados) <= cps, `${info.cuadros} ${o.decodificar === false ? "en el contenedor" : "decodificados"} (≈ ${Math.round(esperados)} esperados)`);

  // Sumas.
  const hash = await sha256Archivo(archivo);
  poner("sha256", hash === e.sha256 && o.sumas.get(e.file) === hash, hash === e.sha256 ? (o.sumas.get(e.file) === hash ? hash : "SHA256SUMS.txt no coincide") : `${hash} ≠ índice ${e.sha256}`);
  if (o.sitio) poner("sitio", o.sitio.some((s) => s.id === e.id && s.sha256 === hash), "copia de evidencias.json del sitio");

  // La música no tocó la imagen.
  const md5 = await hashFlujoVideo(archivo).catch(() => "");
  if (!e.without_music) poner("flujo de video", false, "la entrada no declara su archivo sin música");
  else if (!existsSync(ruta(e.without_music.file))) poner("flujo de video", false, `falta ${e.without_music.file}`);
  else {
    const md5Sin = await hashFlujoVideo(ruta(e.without_music.file)).catch(() => "?");
    const shaSin = await sha256Archivo(ruta(e.without_music.file));
    const ok = md5 !== "" && md5 === md5Sin && md5 === e.video_stream_md5 && shaSin === e.without_music.sha256;
    poner("flujo de video", ok, ok ? `MD5 ${md5} igual con y sin música` : `MD5 final ${md5 || "?"}, sin música ${md5Sin}, índice ${e.video_stream_md5 ?? "?"}${shaSin === e.without_music.sha256 ? "" : " · SHA-256 del archivo sin música distinto"}`);
  }

  // Subtítulos y capítulos.
  if (pasos) {
    const faltan: string[] = [];
    const distintos: string[] = [];
    for (const [f, esperado] of [
      [e.subtitles, subtitulosVtt(pasos)],
      [e.chapters_file, capitulosVtt(pasos)],
    ] as const) {
      if (!f || !existsSync(ruta(f))) faltan.push(f ?? "(sin declarar)");
      else if (readFileSync(ruta(f), "utf8") !== esperado) distintos.push(f);
    }
    poner("subtítulos", !faltan.length && !distintos.length, faltan.length ? `faltan ${faltan.join(", ")}` : distintos.length ? `no coinciden con pasos.json: ${distintos.join(", ")}` : `${pasos.pasos.length} capítulos`);
  } else poner("subtítulos", false, "sin pasos.json");

  // Escenario.
  const fallidas = (e.checks ?? []).filter((c) => !c.ok);
  poner("escenario", (e.checks ?? []).length > 0 && fallidas.length === 0, `${(e.checks ?? []).length - fallidas.length}/${(e.checks ?? []).length} verificaciones`);

  return { id: e.id, ok: criterios.every((c) => c.ok), criterios, info, sonoridad };
}

/**
 * Respaldo del formato anterior (WebM): solo integridad, como lo verificaba la versión 1.1 (archivo legible con
 * cuadros, duración ≤ 240 s, SHA-256 igual al índice, a SHA256SUMS.txt y a la copia del sitio, escenario cumplido).
 * No se le exigen 1080p, audio, pasos ni subtítulos: se cita con su versión y su commit tal como se grabó.
 */
async function verificarAnterior(e: EntradaEvidencia, o: OpcionesVerificacion, archivo: string): Promise<ResultadoVerificacion> {
  const criterios: Criterio[] = [];
  const poner = (clave: string, ok: boolean, detalle: string) => criterios.push({ clave, ok, detalle });
  poner("archivo", true, `${e.file}: formato anterior (respaldo de la versión ${e.version}, commit ${e.commit})`);
  poner("no es ensayo", e.rehearsal !== true, e.rehearsal === true ? "grabación de ENSAYO: no se publica" : "grabación registrada");
  const info = await analizarVideo(archivo, { decodificar: o.decodificar ?? true }).catch(() => undefined);
  if (!info) {
    poner("formato", false, "no se pudo leer el archivo");
    return { id: e.id, ok: false, criterios };
  }
  poner("formato", info.codec === "vp9" || info.codec === "vp8", `${info.contenedor ?? "webm"} · ${info.codec} · ${info.ancho}×${info.alto}`);
  const d = info.duracion;
  poner("duración", d > 0 && d <= REGLAS.duracionMaxima + 0.05 && Math.abs(d - e.duration_seconds) <= 0.5, `${fmt(d)} s (máx. ${REGLAS.duracionMaxima}; índice ${e.duration_seconds})`);
  poner("cuadros", info.cuadros > 0, `${info.cuadros} cuadros`);
  const hash = await sha256Archivo(archivo);
  poner("sha256", hash === e.sha256 && o.sumas.get(e.file) === hash, hash === e.sha256 ? (o.sumas.get(e.file) === hash ? hash : "SHA256SUMS.txt no coincide") : `${hash} ≠ índice ${e.sha256}`);
  if (o.sitio) poner("sitio", o.sitio.some((s) => s.id === e.id && s.sha256 === hash), "copia de evidencias.json del sitio");
  const fallidas = (e.checks ?? []).filter((c) => !c.ok);
  poner("escenario", (e.checks ?? []).length > 0 && fallidas.length === 0, `${(e.checks ?? []).length - fallidas.length}/${(e.checks ?? []).length} verificaciones`);
  return { id: e.id, ok: criterios.every((c) => c.ok), criterios, info, anterior: true };
}

async function principal(args: string[]): Promise<number> {
  const valor = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const carpeta = resolve(valor("--dir") ?? SALIDA);
  const indice = join(carpeta, "evidencias.json");
  if (!existsSync(indice)) {
    console.error(`No existe ${indice}: grabe primero (pnpm --filter @nexo/evidencias grabar)`);
    return 1;
  }
  const { evidencias } = JSON.parse(readFileSync(indice, "utf8")) as { evidencias: EntradaEvidencia[] };
  const rutaSumas = join(carpeta, "SHA256SUMS.txt");
  const sumas = existsSync(rutaSumas) ? leerSumas(readFileSync(rutaSumas, "utf8")) : new Map<string, string>();
  const copia = desdeRaiz("apps/site/src/data/evidencias.json");
  const sitio = args.includes("--sin-sitio") ? null : existsSync(copia) ? (JSON.parse(readFileSync(copia, "utf8")) as { evidencias: EntradaEvidencia[] }).evidencias : [];

  const problemas: string[] = [];
  const anteriores: string[] = [];
  const filas: Array<Record<string, unknown>> = [];
  for (const e of evidencias) {
    const r = await verificarEvidencia(e, { carpeta, sumas, sitio, decodificar: !args.includes("--rapido"), permitirAnteriores: args.includes("--permitir-anteriores") });
    if (r.anterior) anteriores.push(e.id);
    for (const c of r.criterios) if (!c.ok) problemas.push(`${e.id}: no cumple «${c.clave}»: ${c.detalle}`);
    const i = r.info;
    const bytes = existsSync(join(carpeta, e.file)) ? statSync(join(carpeta, e.file)).size : 0;
    filas.push({
      id: e.id,
      archivo: e.file,
      s: fmt(i?.duracion),
      imagen: i ? `${i.ancho}×${i.alto}@${fmt(i.cps, 0)}` : "",
      LUFS: fmt(r.sonoridad?.integrado),
      dBTP: fmt(r.sonoridad?.picoReal),
      MB: (bytes / 1048576).toFixed(1),
      "Mb/s": i?.kbps ? (i.kbps / 1000).toFixed(2) : "",
      cumple: `${r.criterios.filter((c) => c.ok).length}/${r.criterios.length}`,
      ok: r.ok,
    });
  }
  console.table(filas);
  if (!args.includes("--dir")) {
    const { DEMOS } = await import("./demos/index.js");
    const faltan = DEMOS.filter((d) => !evidencias.some((e) => e.id === d.id)).map((d) => d.id);
    if (faltan.length) console.log(`Sin grabar todavía: ${faltan.join(", ")}`);
  }
  if (anteriores.length) console.log(`Formato anterior (respaldo; solo integridad: archivo, SHA-256 y escenario): ${anteriores.join(", ")}`);
  if (problemas.length) {
    console.error(`\n${problemas.length} problemas:\n  ${problemas.join("\n  ")}`);
    return 1;
  }
  if (anteriores.length) {
    const vigentes = evidencias.length - anteriores.length;
    console.log(`\n${vigentes} videos verificados en el formato vigente y ${anteriores.length} respaldos del formato anterior con su integridad comprobada.`);
    return 0;
  }
  console.log(
    `\n${evidencias.length} videos verificados: MP4 H.264 + AAC, resolución y cps declarados, ${AUDIO.lufs} LUFS, ≤ ${REGLAS.duracionMaxima} s, pasos ≥ ${REGLAS.pasoMinimo} s, SHA-256 coincidente, imagen intacta tras la música, subtítulos y capítulos al día, sin ensayos y escenario cumplido.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await principal(process.argv.slice(2).filter((a) => a !== "--"));
}
