/**
 * Contrato <nombre>.pasos.json (compartido con el panel, los subtítulos/capítulos WebVTT y verificar.ts).
 * El grabador lo escribe junto a cada video; los tiempos son segundos desde el primer cuadro del video.
 *
 *   {
 *     producto: "Yago Nexo", version: "1.2.0",
 *     commit_producto: "<sha corto de la etiqueta>", commit_herramientas: "<sha corto de HEAD>",
 *     ensayo: false, ancho: 1920, alto: 1080, cps: 30, duracion_s: 187.4,
 *     pasos: [{ n: 1, inicio_s: 11.02, fin_s: 31.5, titulo, que_pasa, por_que_importa,
 *               comprueba: [{ texto, ok, valor? }] }]
 *   }
 *
 * «comprueba» de cada paso son las verificaciones registradas EN VIVO durante ese paso
 * (estudio.comprueba), no lo declarado: lo declarado («Se comprueba») se muestra en el panel.
 */
import { PASO_MINIMO_S, redondear, TOPE_VIDEO_S } from "./ritmo.js";

export interface ComprobacionPaso {
  texto: string;
  ok: boolean;
  valor?: string | number;
}

export interface PasoJson {
  n: number;
  inicio_s: number;
  fin_s: number;
  titulo: string;
  que_pasa: string;
  por_que_importa: string;
  comprueba: ComprobacionPaso[];
}

export interface PasosJson {
  producto: string;
  version: string;
  commit_producto: string;
  commit_herramientas: string;
  ensayo: boolean;
  ancho: number;
  alto: number;
  cps: number;
  duracion_s: number;
  pasos: PasoJson[];
}

/** Lo que el guion declara al abrir un paso (estudio.paso). */
export interface DefinicionPaso {
  /** Título corto (capítulo, rótulo y panel), p. ej. «Versión defectuosa: canary con fase sombra». */
  titulo: string;
  /** «Qué está pasando»: 1 a 3 frases en lenguaje llano. */
  quePasa: string;
  /** «Por qué importa»: qué riesgo cubre o qué exige la capacidad. */
  porQueImporta: string;
  /** «Se comprueba»: lo que se verificará en este paso (las verificaciones reales llegan con comprueba()). */
  comprueba?: string[];
  /** Mínimo de este paso en segundos (nunca menos de 7). */
  minimoS?: number;
}

interface PasoAbierto {
  n: number;
  inicioMs: number;
  finMs?: number;
  def: DefinicionPaso;
  comprueba: ComprobacionPaso[];
}

export class RegistroPasos {
  private readonly lista: PasoAbierto[] = [];
  /** Verificaciones registradas antes del primer paso (se asignan al paso 1). */
  private previas: ComprobacionPaso[] = [];

  constructor(private readonly inicioVideoMs: () => number) {}

  get actual(): PasoAbierto | undefined {
    return this.lista.at(-1);
  }

  get cantidad(): number {
    return this.lista.length;
  }

  abrir(def: DefinicionPaso, ahoraMs: number): number {
    this.cerrar(ahoraMs);
    const n = this.lista.length + 1;
    const p: PasoAbierto = { n, inicioMs: ahoraMs, def, comprueba: [] };
    if (this.previas.length) {
      p.comprueba.push(...this.previas);
      this.previas = [];
    }
    this.lista.push(p);
    return n;
  }

  comprobar(c: ComprobacionPaso): number {
    const a = this.actual;
    if (!a || a.finMs !== undefined) {
      if (a) a.comprueba.push(c);
      else this.previas.push(c);
      return a?.n ?? 0;
    }
    a.comprueba.push(c);
    return a.n;
  }

  cerrar(ahoraMs: number): void {
    const a = this.actual;
    if (a && a.finMs === undefined) a.finMs = Math.max(a.inicioMs, ahoraMs);
  }

  /** Duración en segundos de cada paso (los abiertos, hasta ahora). */
  duraciones(ahoraMs: number): number[] {
    return this.lista.map((p) => ((p.finMs ?? ahoraMs) - p.inicioMs) / 1000);
  }

  pasos(finVideoMs: number): PasoJson[] {
    const t0 = this.inicioVideoMs();
    return this.lista.map((p) => ({
      n: p.n,
      inicio_s: redondear((p.inicioMs - t0) / 1000),
      fin_s: redondear(((p.finMs ?? finVideoMs) - t0) / 1000),
      titulo: p.def.titulo,
      que_pasa: p.def.quePasa,
      por_que_importa: p.def.porQueImporta,
      comprueba: p.comprueba.map((c) => ({
        texto: c.texto,
        ok: c.ok,
        ...(c.valor !== undefined ? { valor: c.valor } : {}),
      })),
    }));
  }

  titulos(): string[] {
    return this.lista.map((p) => p.def.titulo);
  }
}

/** Problemas del pasos.json respecto de las reglas de los videos (vacío si cumple). */
export function validarPasos(p: PasosJson, o: { minimoS?: number; topeS?: number } = {}): string[] {
  const minimo = o.minimoS ?? PASO_MINIMO_S;
  const tope = o.topeS ?? TOPE_VIDEO_S;
  const r: string[] = [];
  if (!p.producto || !p.version) r.push("falta producto o versión");
  if (!p.commit_producto || !p.commit_herramientas) r.push("faltan los commits de producto y herramientas");
  if (p.duracion_s > tope) r.push(`dura ${p.duracion_s.toFixed(1)} s (tope ${tope} s)`);
  if (!p.pasos.length) r.push("no tiene pasos");
  let anterior = 0;
  for (const s of p.pasos) {
    const d = s.fin_s - s.inicio_s;
    if (d + 0.05 < minimo) r.push(`paso ${s.n} dura ${d.toFixed(1)} s (mínimo ${minimo} s)`);
    if (s.inicio_s + 1e-6 < anterior) r.push(`paso ${s.n} empieza antes de que termine el anterior`);
    if (s.fin_s > p.duracion_s + 0.5) r.push(`paso ${s.n} termina después del final del video`);
    if (!s.titulo.trim()) r.push(`paso ${s.n} sin título`);
    if (!s.que_pasa.trim() || !s.por_que_importa.trim())
      r.push(`paso ${s.n} sin «qué pasa» o «por qué importa»`);
    if (s.comprueba.some((c) => !c.ok)) r.push(`paso ${s.n} tiene verificaciones fallidas`);
    anterior = s.fin_s;
  }
  return r;
}
