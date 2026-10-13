/**
 * Archivo de pasos de cada video (<nombre>.pasos.json, lo escribe el grabador) y los WebVTT que se generan desde
 * él: subtítulos (texto del paso y «qué pasa», con sus tiempos) y capítulos (uno por paso).
 *
 * Contrato del archivo de pasos (compartido por el motor, la verificación y el sitio):
 *   { producto, version, commit_producto, commit_herramientas, ensayo, ancho, alto, cps, duracion_s,
 *     pasos: [{ n, inicio_s, fin_s, titulo, que_pasa, por_que_importa, comprueba: [{ texto, ok, valor? }] }] }
 * Los tiempos son segundos desde el inicio del archivo de video final.
 */

export interface Comprobacion {
  texto: string;
  ok: boolean;
  valor?: string | number;
}

export interface PasoGrabado {
  n: number;
  inicio_s: number;
  fin_s: number;
  titulo: string;
  que_pasa: string;
  por_que_importa: string;
  comprueba: Comprobacion[];
}

export interface ArchivoPasos {
  producto: string;
  version: string;
  commit_producto: string;
  commit_herramientas: string;
  /** true: grabación de ensayo (sin laboratorio): nunca se publica. */
  ensayo: boolean;
  ancho: number;
  alto: number;
  cps: number;
  duracion_s: number;
  pasos: PasoGrabado[];
}

/** Reglas de publicación de los videos (bases y plan de videos). */
export const REGLAS = {
  producto: "Yago Nexo",
  duracionMaxima: 240,
  pasoMinimo: 7,
  /** 1920×1080 es lo pedido; 1600×900 es la alternativa si la captura no rinde. */
  resoluciones: [
    [1920, 1080],
    [1600, 900],
  ] as ReadonlyArray<readonly [number, number]>,
  cps: [30, 25] as readonly number[],
} as const;

/** Holgura para comparar tiempos (redondeos de cuadros y milisegundos). */
const HOLGURA = 0.05;

export const nombresVtt = (nombre: string) => ({
  pasos: `${nombre}.pasos.json`,
  subtitulos: `${nombre}.vtt`,
  capitulos: `${nombre}.capitulos.vtt`,
});

const esTexto = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const esNumero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Valida el archivo de pasos. Siempre revisa la estructura (tipos, numeración, orden y tiempos dentro del video);
 * con `publicar` además exige las reglas de publicación: no es ensayo, resolución y cps permitidos, duración
 * ≤ 240 s, cada paso ≥ 7 s y todas sus comprobaciones cumplidas.
 */
export function validarPasos(datos: unknown, o: { publicar?: boolean } = {}): { ok: boolean; problemas: string[]; pasos?: ArchivoPasos } {
  const problemas: string[] = [];
  if (!datos || typeof datos !== "object") return { ok: false, problemas: ["no es un objeto JSON"] };
  const p = datos as Partial<ArchivoPasos>;
  if (!esTexto(p.producto)) problemas.push("falta «producto»");
  else if (p.producto !== REGLAS.producto) problemas.push(`producto «${p.producto}» (se espera «${REGLAS.producto}»)`);
  if (!esTexto(p.version) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(p.version)) problemas.push("«version» no es una versión x.y.z");
  for (const k of ["commit_producto", "commit_herramientas"] as const) {
    if (!esTexto(p[k]) || !/^[0-9a-f]{7,40}$/.test(p[k])) problemas.push(`«${k}» no es un commit (7 a 40 hexadecimales)`);
  }
  if (typeof p.ensayo !== "boolean") problemas.push("«ensayo» debe ser true o false");
  for (const k of ["ancho", "alto", "cps"] as const) if (!esNumero(p[k]) || p[k] <= 0 || !Number.isInteger(p[k])) problemas.push(`«${k}» debe ser un entero positivo`);
  if (!esNumero(p.duracion_s) || p.duracion_s <= 0) problemas.push("«duracion_s» debe ser un número positivo");
  if (!Array.isArray(p.pasos) || p.pasos.length === 0) problemas.push("«pasos» debe ser una lista con al menos un paso");
  if (problemas.length) return { ok: false, problemas };

  const a = p as ArchivoPasos;
  let finAnterior = 0;
  a.pasos.forEach((paso, i) => {
    const id = `paso ${i + 1}`;
    if (!paso || typeof paso !== "object") {
      problemas.push(`${id}: no es un objeto`);
      return;
    }
    if (paso.n !== i + 1) problemas.push(`${id}: «n» es ${String(paso.n)} (se espera ${i + 1})`);
    if (!esTexto(paso.titulo)) problemas.push(`${id}: falta «titulo»`);
    // «qué pasa» y «por qué importa» deben ser texto; vacíos solo se toleran fuera de la publicación (ensayos del
    // motor con guiones todavía sin narración: el subtítulo muestra solo el título).
    for (const k of ["que_pasa", "por_que_importa"] as const) {
      if (typeof paso[k] !== "string") problemas.push(`${id}: falta «${k}»`);
      else if (o.publicar && !esTexto(paso[k])) problemas.push(`${id}: «${k}» vacío`);
    }
    if (!esNumero(paso.inicio_s) || !esNumero(paso.fin_s)) {
      problemas.push(`${id}: «inicio_s» y «fin_s» deben ser números`);
      return;
    }
    if (paso.inicio_s < 0 || paso.fin_s <= paso.inicio_s) problemas.push(`${id}: tiempos inválidos (${paso.inicio_s} → ${paso.fin_s})`);
    if (paso.inicio_s < finAnterior - HOLGURA) problemas.push(`${id}: empieza (${paso.inicio_s} s) antes de que termine el anterior (${finAnterior} s)`);
    if (paso.fin_s > a.duracion_s + HOLGURA) problemas.push(`${id}: termina (${paso.fin_s} s) después del video (${a.duracion_s} s)`);
    finAnterior = paso.fin_s;
    if (!Array.isArray(paso.comprueba)) problemas.push(`${id}: «comprueba» debe ser una lista`);
    else
      paso.comprueba.forEach((c, j) => {
        if (!c || !esTexto(c.texto) || typeof c.ok !== "boolean") problemas.push(`${id}: comprobación ${j + 1} sin «texto» u «ok»`);
        else if (c.valor !== undefined && typeof c.valor !== "string" && !esNumero(c.valor)) problemas.push(`${id}: comprobación ${j + 1}: «valor» debe ser texto o número`);
      });
    if (o.publicar) {
      const dura = paso.fin_s - paso.inicio_s;
      if (dura < REGLAS.pasoMinimo - HOLGURA) problemas.push(`${id}: dura ${dura.toFixed(1)} s (mínimo ${REGLAS.pasoMinimo} s)`);
      for (const c of paso.comprueba ?? []) if (c && c.ok === false) problemas.push(`${id}: comprobación no cumplida: ${c.texto}`);
    }
  });
  if (o.publicar) {
    if (a.ensayo) problemas.push("es una grabación de ENSAYO: no se publica");
    if (!REGLAS.resoluciones.some(([w, h]) => w === a.ancho && h === a.alto)) problemas.push(`resolución ${a.ancho}×${a.alto} no permitida (${REGLAS.resoluciones.map(([w, h]) => `${w}×${h}`).join(" o ")})`);
    if (!REGLAS.cps.includes(a.cps)) problemas.push(`${a.cps} cps no permitido (${REGLAS.cps.join(" o ")})`);
    if (a.duracion_s > REGLAS.duracionMaxima) problemas.push(`dura ${a.duracion_s.toFixed(1)} s (máximo ${REGLAS.duracionMaxima} s)`);
  }
  return problemas.length ? { ok: false, problemas } : { ok: true, problemas, pasos: a };
}

/** Tiempo WebVTT (hh:mm:ss.mmm). */
export function tiempoVtt(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const seg = Math.floor((ms % 60_000) / 1000);
  const mil = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(seg).padStart(2, "0")}.${String(mil).padStart(3, "0")}`;
}

/** Texto seguro para una señal WebVTT: sin marcas, sin líneas en blanco y sin «-->». */
export function textoVtt(t: string): string {
  return t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Corta un texto en líneas de hasta `ancho` caracteres (sin partir palabras, salvo las más largas que el ancho). */
export function envolver(texto: string, ancho = 42): string[] {
  const lineas: string[] = [];
  let actual = "";
  for (const palabra of texto.replace(/\s+/g, " ").trim().split(" ")) {
    if (!palabra) continue;
    if (!actual) actual = palabra;
    else if (actual.length + 1 + palabra.length <= ancho) actual += ` ${palabra}`;
    else {
      lineas.push(actual);
      actual = palabra;
    }
    while (actual.length > ancho) {
      lineas.push(actual.slice(0, ancho));
      actual = actual.slice(ancho);
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

/** Parte un texto en `k` trozos de largo parecido, sin partir palabras. */
function partirParejo(texto: string, k: number): string[] {
  const palabras = texto.split(" ");
  const meta = texto.length / k;
  const trozos: string[] = [];
  let actual = "";
  for (const p of palabras) {
    const cand = actual ? `${actual} ${p}` : p;
    if (actual && trozos.length < k - 1 && cand.length > meta * 1.08) {
      trozos.push(actual);
      actual = p;
    } else actual = cand;
  }
  if (actual) trozos.push(actual);
  return trozos;
}

/**
 * Divide «qué pasa» en bloques de hasta 2 líneas de 42 caracteres: junta frases mientras quepan, corta de
 * preferencia al final de una oración o de una frase y reparte parejo las que no caben en un bloque (así no
 * quedan restos de dos palabras en pantalla por un segundo).
 */
export function bloquesSubtitulo(texto: string, ancho = 42, lineas = 2): string[][] {
  const cabe = (t: string) => envolver(t, ancho).length <= lineas;
  const frases = texto
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.;:!?])\s+/)
    .filter(Boolean);
  const bloques: string[] = [];
  let actual = "";
  for (const frase of frases) {
    const cand = actual ? `${actual} ${frase}` : frase;
    if (cabe(cand)) {
      actual = cand;
      continue;
    }
    // Un resto corto (una línea o menos) no queda solo: se reparte junto con la frase siguiente.
    let texto = frase;
    if (actual && actual.length <= ancho) texto = cand;
    else if (actual) bloques.push(actual);
    if (cabe(texto)) {
      actual = texto;
      continue;
    }
    let k = Math.ceil(envolver(texto, ancho).length / lineas);
    let trozos = partirParejo(texto, k);
    while (!trozos.every(cabe) && k < 50) trozos = partirParejo(texto, ++k);
    bloques.push(...trozos.slice(0, -1));
    actual = trozos.at(-1) ?? "";
  }
  if (actual) bloques.push(actual);
  return bloques.map((b) => equilibrar(b, ancho));
}

/** Envuelve un bloque y, si ocupa dos líneas, las deja de largo parecido (más fácil de leer). */
export function equilibrar(texto: string, ancho = 42): string[] {
  const ls = envolver(texto, ancho);
  if (ls.length !== 2) return ls;
  const t = ls.join(" ");
  let mejor = ls;
  for (let i = t.indexOf(" "); i > 0; i = t.indexOf(" ", i + 1)) {
    const a = t.slice(0, i);
    const b = t.slice(i + 1);
    if (a.length > ancho || b.length > ancho) continue;
    if (Math.abs(a.length - b.length) < Math.abs(mejor[0]!.length - mejor[1]!.length)) mejor = [a, b];
  }
  return mejor;
}

export interface Senal {
  id?: string;
  inicio: number;
  fin: number;
  texto: string;
}

function serializar(senales: Senal[], encabezado: string): string {
  const partes = [`WEBVTT - ${textoVtt(encabezado)}`, ""];
  for (const s of senales) {
    if (s.id) partes.push(s.id);
    partes.push(`${tiempoVtt(s.inicio)} --> ${tiempoVtt(s.fin)}`, s.texto, "");
  }
  return partes.join("\n");
}

const normalizar = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.…]+$/, "").toLowerCase();

/** Señales de subtítulos: en cada paso, «Paso n de N · título» y luego «qué pasa» en bloques, repartidos en su tiempo. */
export function senalesSubtitulos(a: ArchivoPasos): Senal[] {
  const total = a.pasos.length;
  const senales: Senal[] = [];
  for (const paso of a.pasos) {
    const titulo = `<b>${textoVtt(`Paso ${paso.n} de ${total} · ${paso.titulo}`)}</b>`;
    // Guiones con la API anterior (c.paso(texto)): «qué pasa» repite el título; no se muestra dos veces.
    const repite = normalizar(paso.que_pasa) === normalizar(paso.titulo);
    const bloques = repite ? [] : bloquesSubtitulo(paso.que_pasa);
    // Se deja un respiro de 0,2 s al final de cada paso (si el paso lo permite).
    const fin = paso.fin_s - Math.min(0.2, (paso.fin_s - paso.inicio_s) / 10);
    const largo = fin - paso.inicio_s;
    const pesos = bloques.map((b) => Math.max(20, b.join(" ").length));
    const suma = pesos.reduce((x, y) => x + y, 0);
    let t = paso.inicio_s;
    bloques.forEach((b, i) => {
      const hasta = i === bloques.length - 1 ? fin : t + (largo * pesos[i]!) / suma;
      senales.push({ id: `paso-${paso.n}-${i + 1}`, inicio: t, fin: hasta, texto: [titulo, ...b.map(textoVtt)].join("\n") });
      t = hasta;
    });
    if (!bloques.length) senales.push({ id: `paso-${paso.n}-1`, inicio: paso.inicio_s, fin, texto: titulo });
  }
  return senales;
}

export function subtitulosVtt(a: ArchivoPasos): string {
  return serializar(senalesSubtitulos(a), `${a.producto} ${a.version} · subtítulos`);
}

/** Capítulos WebVTT: uno por paso, con su título. */
export function capitulosVtt(a: ArchivoPasos): string {
  return serializar(
    a.pasos.map((p) => ({ id: `capitulo-${p.n}`, inicio: p.inicio_s, fin: p.fin_s, texto: textoVtt(`${p.n}. ${p.titulo}`) })),
    `${a.producto} ${a.version} · capítulos`,
  );
}

/** Capítulos para el índice del sitio (evidencias.json). */
export function capitulosIndice(a: ArchivoPasos): Array<{ n: number; title: string; start_s: number; end_s: number }> {
  const r = (x: number) => Math.round(x * 100) / 100;
  return a.pasos.map((p) => ({ n: p.n, title: p.titulo, start_s: r(p.inicio_s), end_s: r(p.fin_s) }));
}

const T_VTT = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/;
function segundosVtt(t: string): number {
  const m = T_VTT.exec(t.trim());
  if (!m) throw new Error(`tiempo WebVTT inválido: «${t}»`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Lector mínimo de WebVTT (para pruebas y verificación): devuelve las señales en orden. */
export function leerVtt(texto: string): Senal[] {
  const bloques = texto.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  if (!bloques[0]?.startsWith("WEBVTT")) throw new Error("no empieza con WEBVTT");
  const senales: Senal[] = [];
  for (const b of bloques.slice(1)) {
    const lineas = b.split("\n").filter((l) => l !== "");
    if (!lineas.length || /^(NOTE|STYLE|REGION)\b/.test(lineas[0]!)) continue;
    const iFlecha = lineas.findIndex((l) => l.includes("-->"));
    if (iFlecha < 0 || iFlecha > 1) throw new Error(`señal sin tiempos: «${lineas[0]}»`);
    const [ini, resto] = lineas[iFlecha]!.split("-->");
    const fin = resto!.trim().split(/\s+/)[0]!;
    senales.push({ ...(iFlecha === 1 ? { id: lineas[0] } : {}), inicio: segundosVtt(ini!), fin: segundosVtt(fin), texto: lineas.slice(iFlecha + 1).join("\n") });
  }
  return senales;
}
