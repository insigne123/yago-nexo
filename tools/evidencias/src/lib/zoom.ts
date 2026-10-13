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
  return (
    caja.x < v.x + mx ||
    caja.y < v.y + my ||
    caja.x + caja.width > v.x + v.width - mx ||
    caja.y + caja.height > v.y + v.height - my
  );
}

/** Texto de la insignia: «Ampliación ×1,8 · imagen en vivo». */
export function textoInsignia(factor: number): string {
  const f = (Math.round(factor * 10) / 10).toFixed(1).replace(".", ",").replace(/,0$/, "");
  return `Ampliación ×${f} · imagen en vivo`;
}

/** Esquina de la pantalla donde la narradora dibuja el minimapa «Vista completa» durante una ampliación. */
export type EsquinaMinimapa = "abajo-derecha" | "abajo-izquierda" | "arriba-derecha";

/**
 * Tamaño del minimapa en la pantalla de 1080p (px; estudio.js y estudio.css): lienzo de 330 px de ancho, marco
 * de 6 px por lado, rótulo de una línea y margen al borde. Arriba a la izquierda va la insignia.
 */
export const MINIMAPA = { ancho: 330, marco: 12, rotulo: 26, margen: 18 } as const;

const solape = (a: Caja, b: Caja) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Esquina del minimapa que menos tapa el objetivo ampliado (en la pantalla, ya ampliado ×factor). Por defecto,
 * abajo a la derecha; si ahí tapa más del objetivo que en otra esquina, se cambia (abajo a la izquierda o arriba
 * a la derecha). La pantalla operada se ve 1:1 (la ventana operada mide lo mismo que el área de pantalla).
 */
export function esquinaMinimapa(objetivo: Caja, v: Ventana, vista: Dimensiones): EsquinaMinimapa {
  const f = v.factor;
  const w = MINIMAPA.ancho + MINIMAPA.marco;
  const h =
    Math.round((MINIMAPA.ancho * vista.height) / Math.max(1, vista.width)) + MINIMAPA.marco + MINIMAPA.rotulo;
  const m = MINIMAPA.margen;
  const t: Caja = {
    x: (objetivo.x - v.x) * f,
    y: (objetivo.y - v.y) * f,
    width: objetivo.width * f,
    height: objetivo.height * f,
  };
  const opciones: Array<[EsquinaMinimapa, number, number]> = [
    ["abajo-derecha", vista.width - m - w, vista.height - m - h],
    ["abajo-izquierda", m, vista.height - m - h],
    ["arriba-derecha", vista.width - m - w, m],
  ];
  let mejor: EsquinaMinimapa = "abajo-derecha";
  let menor = Infinity;
  for (const [esquina, x, y] of opciones) {
    const a = solape(t, { x, y, width: w, height: h });
    // Solo se deja la esquina por defecto si otra tapa claramente menos (evita saltos por unos píxeles).
    if (a < menor - 400) {
      menor = a;
      mejor = esquina;
    }
  }
  return mejor;
}
