import { describe, expect, it } from "vitest";
import {
  dentroDeVista,
  desplazamientoParaVer,
  distancia,
  duracionDesplazamiento,
  duracionMovimiento,
  MOVIMIENTO_MAX_MS,
  MOVIMIENTO_MIN_MS,
  MS_POR_LETRA,
  puntoObjetivo,
  ritmoEscritura,
  suavizado,
  trayectoria,
} from "./trayectoria.js";

describe("duracionMovimiento (V02: 0,7 a 1,6 s según la distancia)", () => {
  it("no anima desplazamientos de menos de 4 px", () => {
    expect(duracionMovimiento(0)).toBe(0);
    expect(duracionMovimiento(3.9)).toBe(0);
    expect(duracionMovimiento(Number.NaN)).toBe(0);
  });

  it("queda siempre entre 0,7 y 1,6 s", () => {
    for (const d of [4, 20, 80, 300, 900, 1900, 5000]) {
      for (const w of [8, 40, 300]) {
        const ms = duracionMovimiento(d, w);
        expect(ms).toBeGreaterThanOrEqual(MOVIMIENTO_MIN_MS);
        expect(ms).toBeLessThanOrEqual(MOVIMIENTO_MAX_MS);
      }
    }
  });

  it("crece con la distancia y con objetivos más chicos (ley de Fitts)", () => {
    expect(duracionMovimiento(900, 40)).toBeGreaterThan(duracionMovimiento(120, 40));
    expect(duracionMovimiento(600, 16)).toBeGreaterThan(duracionMovimiento(600, 300));
    expect(duracionMovimiento(30, 40)).toBe(MOVIMIENTO_MIN_MS);
    expect(duracionMovimiento(1800, 12)).toBe(MOVIMIENTO_MAX_MS);
  });
});

describe("trayectoria", () => {
  const a = { x: 100, y: 600 };
  const b = { x: 1100, y: 140 };

  it("parte en el origen, llega al destino y dura lo pedido", () => {
    const p = trayectoria(a, b, 1200);
    expect(p[0]).toMatchObject({ x: a.x, y: a.y, t: 0 });
    expect(p.at(-1)).toMatchObject({ x: b.x, y: b.y, t: 1200 });
    for (let i = 1; i < p.length; i++) expect(p[i]!.t).toBeGreaterThan(p[i - 1]!.t);
    expect(p.length).toBe(Math.round(1.2 * 60) + 1);
  });

  it("acelera al salir y frena al llegar (más lento en los extremos que al medio)", () => {
    const p = trayectoria(a, b, 1200);
    const paso = (i: number) => distancia(p[i]!, p[i + 1]!);
    const medio = Math.floor(p.length / 2);
    expect(paso(0)).toBeLessThan(paso(medio) / 5);
    expect(paso(p.length - 2)).toBeLessThan(paso(medio) / 5);
  });

  it("es una curva suave (no una recta) y siempre la misma", () => {
    const p = trayectoria(a, b, 1000);
    const q = trayectoria(a, b, 1000);
    expect(q).toEqual(p);
    const m = p[Math.floor(p.length / 2)]!;
    // Distancia del punto medio a la recta a-b: la curva se separa, como máximo 90 px.
    const d = Math.abs((b.y - a.y) * m.x - (b.x - a.x) * m.y + b.x * a.y - b.y * a.x) / distancia(a, b);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThanOrEqual(90);
  });

  it("sin duración o sin distancia devuelve solo el destino", () => {
    expect(trayectoria(a, b, 0)).toEqual([{ x: b.x, y: b.y, t: 0 }]);
    expect(trayectoria(a, a, 900)).toEqual([{ x: a.x, y: a.y, t: 0 }]);
  });

  it("suavizado de mínimo tirón: 0 → 0, 0,5 → 0,5, 1 → 1", () => {
    expect(suavizado(0)).toBe(0);
    expect(suavizado(0.5)).toBeCloseTo(0.5, 10);
    expect(suavizado(1)).toBe(1);
    expect(suavizado(-1)).toBe(0);
    expect(suavizado(2)).toBe(1);
  });
});

describe("punto de llegada y vista", () => {
  it("apunta al centro de un botón y al primer tercio de un campo ancho", () => {
    expect(puntoObjetivo({ x: 100, y: 200, width: 80, height: 30 })).toEqual({ x: 140, y: 215 });
    expect(puntoObjetivo({ x: 100, y: 200, width: 900, height: 40 })).toEqual({ x: 320, y: 220 });
  });

  it("nunca apunta fuera del área visible", () => {
    expect(puntoObjetivo({ x: -50, y: 700, width: 40, height: 60 }, { width: 800, height: 720 })).toEqual({ x: 2, y: 718 });
  });

  it("dentroDeVista exige el objetivo completo con margen vertical", () => {
    const vista = { width: 1280, height: 720 };
    expect(dentroDeVista({ x: 10, y: 100, width: 100, height: 30 }, vista)).toBe(true);
    expect(dentroDeVista({ x: 10, y: 10, width: 100, height: 30 }, vista)).toBe(false);
    expect(dentroDeVista({ x: 10, y: 690, width: 100, height: 30 }, vista)).toBe(false);
    expect(dentroDeVista({ x: 1200, y: 100, width: 100, height: 30 }, vista)).toBe(false);
  });

  it("desplazamientoParaVer deja el objetivo en el tercio superior", () => {
    const dy = desplazamientoParaVer({ x: 0, y: 1500, width: 100, height: 40 }, { width: 1280, height: 720 });
    expect(1500 - dy).toBeCloseTo(720 * 0.38 - 20, 0);
  });

  it("duracionDesplazamiento: 0 para menos de 2 px y entre 0,5 y 1,4 s para el resto", () => {
    expect(duracionDesplazamiento(1)).toBe(0);
    expect(duracionDesplazamiento(10)).toBe(500);
    expect(duracionDesplazamiento(-600)).toBe(990);
    expect(duracionDesplazamiento(5000)).toBe(1400);
  });
});

describe("ritmoEscritura (teclado visible a ritmo humano)", () => {
  it("un intervalo por letra (también con tildes y emojis), determinista", () => {
    const t = "Concesiones ñandú 2026";
    const r = ritmoEscritura(t);
    expect(r).toHaveLength([...t].length);
    expect(ritmoEscritura(t)).toEqual(r);
  });

  it("promedia cerca de 80 ms por letra, ±20 % por letra, más lento tras un espacio", () => {
    const r = ritmoEscritura("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
    const prom = r.reduce((s, x) => s + x, 0) / r.length;
    expect(prom).toBeGreaterThan(MS_POR_LETRA * 0.9);
    expect(prom).toBeLessThan(MS_POR_LETRA * 1.1);
    for (const x of r) {
      expect(x).toBeGreaterThanOrEqual(MS_POR_LETRA * 0.8 - 1);
      expect(x).toBeLessThanOrEqual(MS_POR_LETRA * 1.2 + 1);
    }
    const conEspacio = ritmoEscritura("a b", 100);
    expect(conEspacio[1]).toBeGreaterThanOrEqual(100 * 0.8 * 1.35 - 1);
  });
});
