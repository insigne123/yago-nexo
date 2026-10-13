/**
 * Ritmo de los videos (V03, V07 y §5.1): cada paso dura al menos 7 s (si termina antes, se espera con la
 * imagen en vivo), la portada dura 4 s, el cierre 3 s y ningún video pasa de 240 s. Las pausas de lectura se
 * pueden escalar con un factor global; las esperas que forman parte de una medición nunca se tocan.
 *
 * Portada y cierre (V07): la portada muestra de inmediato producto, versión, capacidad, agenda y commits (la
 * imagen de portada del reproductor se toma en el segundo 3); el cierre es el resumen de verificaciones. La
 * agenda sigue a la vista todo el video en la barra de capítulos y cada verificación ya se vio en vivo en el
 * panel lateral, así que no hace falta detener el video para leerlas.
 */

export const PASO_MINIMO_S = 7;
export const TOPE_VIDEO_S = 240;
export const PORTADA_S = 4;
export const CIERRE_S = 3;
/** Fracción máxima del video que puede verse ampliada (§5.1). */
export const ZOOM_MAX_FRACCION = 0.35;

/**
 * Tiempo mínimo que una verificación recién cumplida queda a la vista antes de cambiar de paso: sin esto,
 * la última marca ✓ de un paso que ya cumplió sus 7 s aparecería y desaparecería en el mismo instante.
 */
export const LECTURA_COMPROBADO_MS = 2500;
/** Con menos de esto por delante (antes del cierre), no se agrega la pausa de lectura de las verificaciones. */
export const RESERVA_LECTURA_S = 20;

/** Milisegundos que faltan para que un paso iniciado en `inicioMs` cumpla su mínimo. */
export function esperaParaMinimo(inicioMs: number, ahoraMs: number, minimoS = PASO_MINIMO_S): number {
  return Math.max(0, Math.ceil(inicioMs + minimoS * 1000 - ahoraMs));
}

/**
 * Espera al cerrar un paso: lo que falte para su mínimo y, si su última verificación es reciente, lo que falte
 * para que se lea (salvo que el video ya esté cerca del tope: `restantesS` < RESERVA_LECTURA_S).
 */
export function esperaAlCerrar(o: {
  inicioMs: number;
  ahoraMs: number;
  minimoS?: number;
  ultimaComprobacionMs?: number;
  restantesS?: number;
}): number {
  const minimo = esperaParaMinimo(o.inicioMs, o.ahoraMs, o.minimoS ?? PASO_MINIMO_S);
  const u = o.ultimaComprobacionMs;
  if (u === undefined || u < o.inicioMs || (o.restantesS ?? Infinity) < RESERVA_LECTURA_S) return minimo;
  return Math.max(minimo, Math.ceil(u + LECTURA_COMPROBADO_MS - o.ahoraMs));
}

/** Pausa de lectura escalada por el ritmo global (acotado a 0,5–2 para que nadie lo use para acelerar). */
export function pausaLectura(ms: number, ritmo = 1): number {
  const r = Math.min(2, Math.max(0.5, Number.isFinite(ritmo) ? ritmo : 1));
  return Math.max(0, Math.round(ms * r));
}

export interface Presupuesto {
  /** Segundos de video ya grabados. */
  usados: number;
  /** Segundos que quedan para los pasos, descontando el cierre. */
  restantes: number;
  excedido: boolean;
}

/** Cuánto video queda, dado que el cierre se agrega al final. */
export function presupuesto(
  inicioMs: number,
  ahoraMs: number,
  tope = TOPE_VIDEO_S,
  cierre = CIERRE_S,
): Presupuesto {
  const usados = Math.max(0, (ahoraMs - inicioMs) / 1000);
  const restantes = tope - cierre - usados;
  return { usados, restantes, excedido: restantes < 0 };
}

export interface IntervaloZoom {
  inicioMs: number;
  finMs?: number;
  factor: number;
}

/** Duración mínima que tendrá el video: portada, cada paso con su mínimo de 7 s y cierre (en ms). */
export function duracionMinimaMs(
  pasos: number,
  portadaS = PORTADA_S,
  cierreS = CIERRE_S,
  pasoMinimoS = PASO_MINIMO_S,
): number {
  return Math.max(0, (portadaS + Math.max(0, pasos) * pasoMinimoS + cierreS) * 1000);
}

/**
 * Registro de las ampliaciones: cuánto tiempo se vio ampliado y si una ampliación nueva cabe en el tope.
 * La regla «(ampliado + nueva) / max(transcurrido + nueva, duración mínima) ≤ 35 %» asegura el tope en el video
 * completo, porque después solo crece el tiempo total y el video nunca dura menos que su mínimo (portada, 7 s por
 * paso y cierre). Sin la duración mínima, una ampliación al comienzo del video nunca cabría.
 */
export class RegistroZoom {
  readonly intervalos: IntervaloZoom[] = [];
  /** Duración mínima del video en ms (0: solo cuenta lo transcurrido). */
  minimoTotalMs = 0;
  constructor(private readonly maxFraccion = ZOOM_MAX_FRACCION) {}

  get activo(): IntervaloZoom | undefined {
    const u = this.intervalos.at(-1);
    return u && u.finMs === undefined ? u : undefined;
  }

  abrir(ahoraMs: number, factor: number): void {
    if (this.activo) {
      this.activo.factor = factor;
      return;
    }
    this.intervalos.push({ inicioMs: ahoraMs, factor });
  }

  cerrar(ahoraMs: number): void {
    const a = this.activo;
    if (a) a.finMs = Math.max(a.inicioMs, ahoraMs);
  }

  ampliadoMs(ahoraMs: number): number {
    return this.intervalos.reduce((s, i) => s + ((i.finMs ?? ahoraMs) - i.inicioMs), 0);
  }

  fraccion(inicioVideoMs: number, ahoraMs: number): number {
    const total = ahoraMs - inicioVideoMs;
    return total > 0 ? this.ampliadoMs(ahoraMs) / total : 0;
  }

  /** ¿Cabe una ampliación de `ms` que empieza ahora? */
  cabe(inicioVideoMs: number, ahoraMs: number, ms: number): boolean {
    const total = Math.max(ahoraMs - inicioVideoMs + ms, this.minimoTotalMs);
    return total > 0 && (this.ampliadoMs(ahoraMs) + ms) / total <= this.maxFraccion + 1e-9;
  }

  /** ¿La ampliación en curso ya alcanzó el tope? (se cierra sola). */
  excedido(inicioVideoMs: number, ahoraMs: number): boolean {
    if (this.activo === undefined) return false;
    const total = Math.max(ahoraMs - inicioVideoMs, this.minimoTotalMs);
    return total > 0 && this.ampliadoMs(ahoraMs) / total > this.maxFraccion;
  }

  /** Intervalos en segundos relativos al inicio del video (para evidencias.json). */
  enSegundos(
    inicioVideoMs: number,
    finVideoMs: number,
  ): Array<{ inicio_s: number; fin_s: number; factor: number }> {
    return this.intervalos.map((i) => ({
      inicio_s: redondear((i.inicioMs - inicioVideoMs) / 1000),
      fin_s: redondear(((i.finMs ?? finVideoMs) - inicioVideoMs) / 1000),
      factor: i.factor,
    }));
  }
}

export const redondear = (s: number, decimales = 3) => {
  const f = 10 ** decimales;
  return Math.round(s * f) / f;
};
