/**
 * Geometría de la ampliación en vivo (V05). La imagen que se amplía es la pantalla del navegador operado
 * tal como llega en vivo: el narrador solo la escala (×1,8 por defecto) y la encuadra en el objetivo. Aquí
 * se calcula qué parte de la pantalla operada queda visible («ventana», en píxeles CSS de la página
 * operada); estudio/estudio.js la convierte en una transformación CSS con transición de 0,7 s.
 */
import type { Caja } from "./trayectoria.js";

export const ZOOM_FACTOR_POR_DEFECTO = 1.8;
export const ZOOM_FACTOR_MIN = 1.2;
export const ZOOM_FACTOR_MAX = 2.5;
export const ZOOM_TRANSICION_MS = 700;

export interface Dimensiones {
  width: number;
  height: number;
}

export interface Ventana extends Caja {
  /** Factor efectivo (puede ser menor que el pedido si el objetivo no cabe ampliado). */
  factor: number;
}

const acotar = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Factor mínimo cuando el objetivo es más ancho que lo ampliado (una fila de tabla, una barra): en vez de
 * bajar a ×1,2 para que quepa entero, se amplía al menos ×1,5 y se encuadra desde su borde izquierdo, que
 * es donde se lee (id, nombre).
 */
export const ZOOM_FACTOR_ANCHO_MIN = 1.5;

/**
 * Ventana visible al ampliar `caja` con `factor` dentro de una pantalla de `vista`. Si el objetivo no cabe
 * con un 12 % de aire, se reduce el factor; por el ancho, nunca bajo ×1,5 (se encuadra desde el borde
 * izquierdo); por el alto sí (y si queda bajo ×1,2 no vale la pena ampliar y el motor lo omite con aviso).
 */
export function ventanaZoom(caja: Caja, vista: Dimensiones, factorPedido = ZOOM_FACTOR_POR_DEFECTO): Ventana {
  const pedido = acotar(factorPedido, 1, ZOOM_FACTOR_MAX);
  const cabeAncho = vista.width / Math.max(1, caja.width * 1.12);
  const cabeAlto = vista.height / Math.max(1, caja.height * 1.12);
  const ajustado = Math.min(pedido, cabeAncho, cabeAlto);
  const porAncho = Math.min(pedido, ZOOM_FACTOR_ANCHO_MIN, cabeAlto);
  // Redondeo hacia abajo: así el objetivo que «cabe justo» sigue cabiendo con su aire.
  const factor = Math.floor(Math.max(1, ajustado, porAncho) * 100 + 1e-6) / 100;
  const width = vista.width / factor;
  const height = vista.height / factor;
  // Si no cabe a lo ancho, se lee desde la izquierda (con un 4 % de aire); si cabe, va centrado.
  const cx = caja.width * 1.12 > width ? caja.x - width * 0.04 + width / 2 : caja.x + caja.width / 2;
  const cy = caja.y + caja.height / 2;
  return {
    x: Math.round(acotar(cx - width / 2, 0, vista.width - width) * 10) / 10,
    y: Math.round(acotar(cy - height / 2, 0, vista.height - height) * 10) / 10,
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
    factor,
  };
}

/** ¿El objetivo quedó fuera (o pegado al borde) de la ventana ampliada? Entonces la ampliación lo sigue. */
export function fueraDeVentana(caja: Caja, v: Caja, margen = 0.08): boolean {
  const mx = v.width * margen;
  const my = v.height * margen;
  return caja.x < v.x + mx || caja.y < v.y + my || caja.x + caja.width > v.x + v.width - mx || caja.y + caja.height > v.y + v.height - my;
}

/** Texto de la insignia: «Ampliación ×1,8 · imagen en vivo». */
export function textoInsignia(factor: number): string {
  const f = (Math.round(factor * 10) / 10).toFixed(1).replace(".", ",").replace(/,0$/, "");
  return `Ampliación ×${f} · imagen en vivo`;
}
