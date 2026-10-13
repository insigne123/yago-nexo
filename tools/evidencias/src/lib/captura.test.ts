import { describe, expect, it } from "vitest";
import { listaConcat, MuestreadorCFR } from "./captura.js";

describe("MuestreadorCFR (V01: 30 cps según la hora real de cada cuadro)", () => {
  it("cada cuadro dura hasta que llega el siguiente, redondeado a 1/30 s", () => {
    const m = new MuestreadorCFR(30);
    expect(m.cuadro(0)).toBe(0);
    expect(m.cuadro(0.01)).toBe(1); // el de t=0 se ve 1 vez (0 a 1/30)
    expect(m.cuadro(0.05)).toBe(1);
    expect(m.cuadro(0.1)).toBe(1);
    expect(m.cerrar(0.2)).toBe(3); // el último cubre hasta el final (0,1 a 0,2 s)
    expect(m.escritosTotal).toBe(6);
    expect(m.unicos).toBe(4);
    expect(m.descartados).toBe(0);
  });

  it("si dos cuadros caen en el mismo 1/30 s queda el último (nunca se acelera)", () => {
    const m = new MuestreadorCFR(30);
    m.cuadro(0);
    expect(m.cuadro(0.001)).toBe(1);
    expect(m.cuadro(0.002)).toBe(0); // el de 0,001 se descarta: el de 0,002 lo reemplaza
    expect(m.descartados).toBe(1);
    expect(m.cerrar(1)).toBe(29);
    expect(m.escritosTotal).toBe(30);
  });

  it("una pantalla quieta repite la misma imagen el tiempo real que estuvo quieta", () => {
    const m = new MuestreadorCFR(30);
    m.cuadro(0);
    expect(m.cuadro(2.5)).toBe(75);
    expect(m.cerrar(3)).toBe(15);
    expect(m.escritosTotal).toBe(90);
    expect(m.huecos).toEqual([2.5]);
  });

  it("la duración del video es la de la toma, sea cual sea el ritmo de llegada", () => {
    for (const cps of [25, 30]) {
      const m = new MuestreadorCFR(cps);
      let t = 0;
      let semilla = 7;
      while (t < 20) {
        m.cuadro(t);
        semilla = (semilla * 48271) % 2147483647;
        t += 0.004 + (semilla % 1000) / 8000; // llegadas irregulares de 4 a 129 ms
      }
      m.cerrar(20);
      // Exacta salvo, a lo sumo, un cuadro: el último que llegó se ve siempre al menos una vez.
      expect(m.escritosTotal).toBeGreaterThanOrEqual(20 * cps);
      expect(m.escritosTotal).toBeLessThanOrEqual(20 * cps + 1);
      expect(m.unicos + m.descartados).toBe(m.recibidos);
    }
  });

  it("mide el ritmo de cuadros distintos en los segundos con movimiento", () => {
    const m = new MuestreadorCFR(30);
    for (let i = 0; i < 60; i++) m.cuadro(i / 20); // 20 por segundo durante 3 s
    m.cerrar(10); // y 7 s quietos
    const r = m.ritmoEnMovimiento();
    expect(r.p50).toBe(20);
    expect(m.percentilHueco(0.95)).toBeCloseTo(0.05, 5);
  });
});

describe("listaConcat", () => {
  it("escribe la duración exacta de cada cuadro y repite el último", () => {
    const l = listaConcat(
      [
        { archivo: "c000001.jpg", veces: 3 },
        { archivo: "c000002.jpg", veces: 0 },
        { archivo: "c'3.jpg", veces: 30 },
      ],
      30,
    );
    expect(l).toBe(["ffconcat version 1.0", "file 'c000001.jpg'", "duration 0.100000", "file 'c'\\''3.jpg'", "duration 1.000000", "file 'c'\\''3.jpg'", ""].join("\n"));
  });
});
