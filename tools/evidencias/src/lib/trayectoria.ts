/**
 * Trayectorias del puntero (V02): el cursor del video viaja como lo haría una mano, con aceleración al
 * salir y desaceleración al llegar (perfil de mínimo tirón), por una curva suave y en un tiempo que crece
 * con la distancia (ley de Fitts acotada a 0,7–1,6 s). El cálculo vive aquí (Node) y la página operada
 * solo reproduce los puntos (estudio/cursor.js), así que lo que se ve es exactamente lo que se calculó.
 */

export interface Punto {
  x: number;
  y: number;
}

/** Punto de la trayectoria con su instante en milisegundos desde el inicio del movimiento. */
export interface PuntoTiempo extends Punto {
  t: number;
}

export interface Caja {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MOVIMIENTO_MIN_MS = 700;
export const MOVIMIENTO_MAX_MS = 1600;
/** Pausa con el objetivo enmarcado antes de cada clic (§5.1: «se detiene 0,6 s antes de cada clic»). */
export const PAUSA_ANTES_DE_CLIC_MS = 600;
/** Ritmo de escritura visible (§5.1: «escritura a 80 ms por letra»). */
export const MS_POR_LETRA = 80;

const acotar = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function distancia(a: Punto, b: Punto): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Duración del movimiento según la distancia y el tamaño del objetivo (índice de dificultad de Fitts,
 * log2(1 + D/W)). Un desplazamiento de pocos píxeles no se anima (0 ms); el resto queda entre 0,7 y 1,6 s.
 */
export function duracionMovimiento(
  distanciaPx: number,
  anchoObjetivo = 40,
  o: { minMs?: number; maxMs?: number } = {},
): number {
  const min = o.minMs ?? MOVIMIENTO_MIN_MS;
  const max = o.maxMs ?? MOVIMIENTO_MAX_MS;
  if (!(distanciaPx >= 4)) return 0;
  const indice = Math.log2(1 + distanciaPx / Math.max(12, anchoObjetivo));
  // ID ≈ 1 (objetivo al lado) → mínimo; ID ≥ 6,5 (cruzar la pantalla hacia un botón chico) → máximo.
  const f = acotar((indice - 1) / 5.5, 0, 1);
  return Math.round(min + (max - min) * f);
}

/** Perfil de mínimo tirón: arranca y frena con velocidad y aceleración nulas. */
export function suavizado(t: number): number {
  const u = acotar(t, 0, 1);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/**
 * Puntos de la trayectoria de a hasta b, muestreados a `hz` por segundo. La curva es una Bézier cuadrática
 * con el punto de control desplazado en perpendicular (12 % de la distancia, como máximo 90 px); el sentido
 * de la curva depende de la dirección, así que la misma escena produce siempre la misma trayectoria.
 */
export function trayectoria(a: Punto, b: Punto, ms: number, hz = 60): PuntoTiempo[] {
  const d = distancia(a, b);
  if (ms <= 0 || d < 1) return [{ x: b.x, y: b.y, t: 0 }];
  const curva = Math.min(90, d * 0.12) * (b.x >= a.x ? 1 : -1) * (b.y >= a.y ? 1 : -1);
  const nx = -(b.y - a.y) / d;
  const ny = (b.x - a.x) / d;
  const cx = (a.x + b.x) / 2 + nx * curva;
  const cy = (a.y + b.y) / 2 + ny * curva;
  const pasos = Math.max(2, Math.round((ms / 1000) * hz));
  const puntos: PuntoTiempo[] = [];
  for (let i = 0; i <= pasos; i++) {
    const t = i / pasos;
    const s = suavizado(t);
    const u = 1 - s;
    puntos.push({
      x: Math.round((u * u * a.x + 2 * u * s * cx + s * s * b.x) * 10) / 10,
      y: Math.round((u * u * a.y + 2 * u * s * cy + s * s * b.y) * 10) / 10,
      t: Math.round(t * ms),
    });
  }
  return puntos;
}

/**
 * Punto de llegada dentro del objetivo: el centro, salvo en campos muy anchos (se apunta al primer tercio,
 * como haría una persona que va a escribir) y siempre dentro del área visible.
 */
export function puntoObjetivo(c: Caja, vista?: { width: number; height: number }): Punto {
  let x = c.x + c.width / 2;
  const y = c.y + c.height / 2;
  if (c.width > 360) x = c.x + Math.min(c.width / 3, 220);
  if (!vista) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round(acotar(x, 2, vista.width - 2)), y: Math.round(acotar(y, 2, vista.height - 2)) };
}

/** ¿El objetivo está completo dentro de la vista (con un margen)? Si no, hay que desplazar antes de apuntar. */
export function dentroDeVista(c: Caja, vista: { width: number; height: number }, margen = 24): boolean {
  return c.y >= margen && c.y + c.height <= vista.height - margen && c.x >= 0 && c.x + c.width <= vista.width;
}

/** Desplazamiento vertical que deja el objetivo en el tercio superior-central de la vista. */
export function desplazamientoParaVer(c: Caja, vista: { width: number; height: number }): number {
  const destino = Math.max(80, vista.height * 0.38 - c.height / 2);
  return Math.round(c.y - destino);
}

/** Duración del desplazamiento suave (rueda o barra) según cuántos píxeles se mueve: 0,5 a 1,4 s. */
export function duracionDesplazamiento(px: number): number {
  const d = Math.abs(px);
  if (d < 2) return 0;
  return Math.round(acotar(450 + d * 0.9, 500, 1400));
}

/**
 * Intervalos entre teclas para escribir `texto` a ritmo humano: alrededor de `ms` por letra, algo más
 * lento tras un espacio o un signo, con una variación determinista (la misma frase se escribe igual).
 */
export function ritmoEscritura(texto: string, ms = MS_POR_LETRA): number[] {
  const r: number[] = [];
  let semilla = 17;
  for (const ch of texto) {
    semilla = (semilla * 1103515245 + 12345) & 0x7fffffff;
    const variacion = ((semilla % 1000) / 1000 - 0.5) * 0.4; // ±20 %
    let d = ms * (1 + variacion);
    if (/[\s.,;:@/_-]/.test(ch)) d *= 1.35;
    r.push(Math.round(d));
  }
  return r;
}
