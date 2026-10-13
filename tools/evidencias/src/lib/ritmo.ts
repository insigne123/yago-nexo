/**
 * Ritmo de los videos (V03 y §5.1): cada paso dura al menos 7 s (si termina antes, se espera con la imagen
 * en vivo), la portada dura 11 s, el cierre 14 s y ningún video pasa de 240 s. Las pausas de lectura se
 * pueden escalar con un factor global; las esperas que forman parte de una medición nunca se tocan.
 */

export const PASO_MINIMO_S = 7;
export const TOPE_VIDEO_S = 240;
export const PORTADA_S = 11;
export const CIERRE_S = 14;
/** Fracción máxima del video que puede verse ampliada (§5.1). */
export const ZOOM_MAX_FRACCION = 0.35;

/** Milisegundos que faltan para que un paso iniciado en `inicioMs` cumpla su mínimo. */
export function esperaParaMinimo(inicioMs: number, ahoraMs: number, minimoS = PASO_MINIMO_S): number {
  return Math.max(0, Math.ceil(inicioMs + minimoS * 1000 - ahoraMs));
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
export function presupuesto(inicioMs: number, ahoraMs: number, tope = TOPE_VIDEO_S, cierre = CIERRE_S): Presupuesto {
  const usados = Math.max(0, (ahoraMs - inicioMs) / 1000);
  const restantes = tope - cierre - usados;
  return { usados, restantes, excedido: restantes < 0 };
}

export interface IntervaloZoom {
  inicioMs: number;
  finMs?: number;
  factor: number;
}

/**
 * Registro de las ampliaciones: cuánto tiempo se vio ampliado y si una ampliación nueva cabe en el tope.
 * La regla «(ampliado + nueva) / (transcurrido + nueva) ≤ 35 %» asegura el tope en el video completo,
 * porque después solo crece el tiempo total.
 */
export class RegistroZoom {
  readonly intervalos: IntervaloZoom[] = [];
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
    const total = ahoraMs - inicioVideoMs + ms;
    return total > 0 && (this.ampliadoMs(ahoraMs) + ms) / total <= this.maxFraccion + 1e-9;
  }

  /** ¿La ampliación en curso ya alcanzó el tope? (se cierra sola). */
  excedido(inicioVideoMs: number, ahoraMs: number): boolean {
    return this.activo !== undefined && this.fraccion(inicioVideoMs, ahoraMs) > this.maxFraccion;
  }

  /** Intervalos en segundos relativos al inicio del video (para evidencias.json). */
  enSegundos(inicioVideoMs: number, finVideoMs: number): Array<{ inicio_s: number; fin_s: number; factor: number }> {
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
