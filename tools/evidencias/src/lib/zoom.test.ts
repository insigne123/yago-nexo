import { describe, expect, it } from "vitest";
import { fueraDeVentana, textoInsignia, ventanaZoom, ZOOM_FACTOR_POR_DEFECTO } from "./zoom.js";

const VISTA = { width: 1290, height: 860 };

describe("ventanaZoom (V05: ampliación en vivo ×1,8)", () => {
  it("amplía ×1,8 por defecto, centrado en el objetivo", () => {
    const v = ventanaZoom({ x: 600, y: 400, width: 120, height: 40 }, VISTA);
    expect(ZOOM_FACTOR_POR_DEFECTO).toBe(1.8);
    expect(v.factor).toBe(1.8);
    expect(v.width).toBeCloseTo(VISTA.width / 1.8, 0);
    expect(v.height).toBeCloseTo(VISTA.height / 1.8, 0);
    expect(v.x + v.width / 2).toBeCloseTo(660, 0);
    expect(v.y + v.height / 2).toBeCloseTo(420, 0);
  });

  it("no se sale de la pantalla operada cerca de los bordes", () => {
    const v = ventanaZoom({ x: 1250, y: 840, width: 30, height: 16 }, VISTA);
    expect(v.x + v.width).toBeCloseTo(VISTA.width, 0);
    expect(v.y + v.height).toBeCloseTo(VISTA.height, 0);
    const w = ventanaZoom({ x: 0, y: 0, width: 30, height: 16 }, VISTA);
    expect(w.x).toBe(0);
    expect(w.y).toBe(0);
  });

  it("reduce el factor si el objetivo no cabe ampliado con aire (y nunca amplía bajo ×1)", () => {
    const v = ventanaZoom({ x: 100, y: 100, width: 700, height: 200 }, VISTA);
    expect(v.factor).toBeLessThan(1.8);
    expect(v.factor).toBeGreaterThanOrEqual(1.5);
    expect(v.width).toBeGreaterThanOrEqual(700 * 1.12);
    expect(ventanaZoom({ x: 0, y: 0, width: 2000, height: 2000 }, VISTA).factor).toBe(1);
    expect(ventanaZoom({ x: 0, y: 0, width: 300, height: 700 }, VISTA).factor).toBeCloseTo(
      860 / (700 * 1.12),
      1,
    );
  });

  it("un objetivo más ancho que lo ampliado (fila de tabla) se amplía ×1,5 desde su borde izquierdo", () => {
    const fila = { x: 80, y: 500, width: 1180, height: 46 };
    const v = ventanaZoom(fila, VISTA);
    expect(v.factor).toBe(1.5);
    expect(v.x).toBeGreaterThanOrEqual(0);
    expect(v.x).toBeLessThanOrEqual(fila.x);
    expect(fila.x - v.x).toBeLessThan(v.width * 0.05);
    expect(v.y + v.height / 2).toBeCloseTo(523, 0);
  });

  it("acota el factor pedido a ×2,5", () => {
    expect(ventanaZoom({ x: 600, y: 400, width: 20, height: 10 }, VISTA, 9).factor).toBe(2.5);
  });
});

describe("seguimiento y rótulo", () => {
  const v = { x: 100, y: 100, width: 700, height: 470 };
  it("fueraDeVentana: dentro con margen → no sigue; pegado al borde o fuera → sigue", () => {
    expect(fueraDeVentana({ x: 300, y: 300, width: 80, height: 30 }, v)).toBe(false);
    expect(fueraDeVentana({ x: 105, y: 300, width: 80, height: 30 }, v)).toBe(true);
    expect(fueraDeVentana({ x: 900, y: 300, width: 80, height: 30 }, v)).toBe(true);
    expect(fueraDeVentana({ x: 300, y: 560, width: 80, height: 30 }, v)).toBe(true);
  });

  it("insignia «Ampliación ×1,8 · imagen en vivo» con coma decimal", () => {
    expect(textoInsignia(1.8)).toBe("Ampliación ×1,8 · imagen en vivo");
    expect(textoInsignia(2)).toBe("Ampliación ×2 · imagen en vivo");
    expect(textoInsignia(1.53)).toBe("Ampliación ×1,5 · imagen en vivo");
  });
});
