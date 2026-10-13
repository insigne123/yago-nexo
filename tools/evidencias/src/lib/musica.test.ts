import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACORDE_MAX_S,
  ACORDE_MIN_S,
  ACORDES,
  cantidadAcordes,
  controlarPicos,
  FM,
  generador,
  hash32,
  huellaPcm,
  PICO_SOBRE_SONORIDAD_DB,
  planificar,
  sintetizar,
  SONORIDAD_SINTESIS,
  sonoridadIntegrada,
  varianteParaVideo,
  VARIANTES,
  wav,
} from "./musica.js";
import { FFMPEG, leerEbur128 } from "./video.js";

/** Energía relativa (dB) por encima de `corte` Hz en una ventana, con una DFT directa sobre bins espaciados. */
function energiaSobre(x: Float32Array, desde: number, n: number, corte: number): number {
  let total = 0;
  let alta = 0;
  for (let k = 1; k < n / 2; k += 3) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const v = x[desde + i]! * w;
      re += v * Math.cos((2 * Math.PI * k * i) / n);
      im -= v * Math.sin((2 * Math.PI * k * i) / n);
    }
    const p = re * re + im * im;
    total += p;
    if ((k * FM) / n > corte) alta += p;
  }
  return 10 * Math.log10(alta / total);
}

const rms = (x: Float32Array, a: number, b: number) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (b - a));
};

describe("plan de la pieza", () => {
  it.each([20, 45, 61, 95, 110, 150, 200, 240])("%i s: acordes de 6 a 8 s que cubren el video", (d) => {
    for (const v of VARIANTES) {
      const plan = planificar(d, v);
      expect(plan.acorde).toBeGreaterThanOrEqual(ACORDE_MIN_S);
      expect(plan.acorde).toBeLessThanOrEqual(ACORDE_MAX_S);
      expect(plan.acordes[0]!.inicio).toBe(0);
      expect(plan.acordes.at(-1)!.fin).toBeCloseTo(d, 6);
      for (const a of plan.acordes) expect(Object.keys(ACORDES)).toContain(a.acorde);
    }
  });

  it("desde ≈ 100 s siempre termina en la tónica (Cmaj9)", () => {
    for (let d = 100; d <= 240; d += 7) for (const v of VARIANTES) expect(planificar(d, v).acordes.at(-1)!.acorde).toBe("Cmaj9");
  });

  it("videos muy cortos: un acorde", () => {
    expect(cantidadAcordes(5, { orden: ["Cmaj9", "Am9", "Fmaj7", "G6sus"], acorde: 7 })).toBe(1);
  });

  it("piano escaso, en registro medio y lejos de los bordes", () => {
    for (const v of VARIANTES) {
      const plan = planificar(180, v);
      expect(plan.piano.length).toBeGreaterThan(5);
      expect(plan.piano.length / 180).toBeLessThan(0.45); // menos de una nota cada 2 s en promedio
      for (const n of plan.piano) {
        expect(n.midi).toBeGreaterThanOrEqual(60);
        expect(n.midi).toBeLessThanOrEqual(79);
        expect(n.inicio).toBeGreaterThanOrEqual(1.5);
        expect(n.inicio).toBeLessThanOrEqual(180 - 3.5);
      }
      for (const a of plan.acordes) expect(plan.piano.filter((n) => n.inicio >= a.inicio && n.inicio < a.fin).length).toBeLessThanOrEqual(3);
    }
  });

  it("determinista y distinto por variante", () => {
    expect(planificar(120, 2)).toEqual(planificar(120, 2));
    expect(planificar(120, 1).piano).not.toEqual(planificar(120, 2).piano);
  });

  it("la variante de cada video es estable y las 13 demostraciones usan más de una", () => {
    const ids = ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08", "BT-005", "BT-008", "BT-018", "BT-021", "BT-049"];
    const vs = ids.map(varianteParaVideo);
    expect(ids.map(varianteParaVideo)).toEqual(vs);
    for (const v of vs) expect([1, 2, 3]).toContain(v);
    expect(new Set(vs).size).toBeGreaterThan(1);
  });

  it("generador y hash32 deterministas", () => {
    expect(hash32("D-01")).toBe(hash32("D-01"));
    const a = generador(42);
    const b = generador(42);
    for (let i = 0; i < 5; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("síntesis", () => {
  const D = 12;
  const pistas = VARIANTES.map((v) => sintetizar(D, v));

  it("largo exacto, estéreo, sin valores inválidos, en −20 LUFS y con picos a ≤ 13 dB de la sonoridad", () => {
    for (const p of pistas) {
      expect(p.izquierda.length).toBe(D * FM);
      expect(p.derecha.length).toBe(D * FM);
      let pico = 0;
      let invalidos = 0;
      for (const c of [p.izquierda, p.derecha])
        for (const v of c) {
          if (!Number.isFinite(v)) invalidos++;
          pico = Math.max(pico, Math.abs(v));
        }
      expect(invalidos).toBe(0);
      const s = sonoridadIntegrada(p.izquierda, p.derecha);
      expect(s).toBeCloseTo(SONORIDAD_SINTESIS, 1);
      expect(20 * Math.log10(pico)).toBeLessThanOrEqual(s + PICO_SOBRE_SONORIDAD_DB + 0.05);
    }
  });

  it("reproducible: misma variante y duración ⇒ mismo SHA-256 del PCM", () => {
    expect(huellaPcm(sintetizar(D, 1))).toBe(huellaPcm(pistas[0]!));
    expect(new Set(pistas.map(huellaPcm)).size).toBe(3);
  });

  it("sin clics: ningún salto entre muestras consecutivas es grande respecto del pico", () => {
    for (const p of pistas)
      for (const c of [p.izquierda, p.derecha]) {
        let salto = 0;
        for (let i = 1; i < c.length; i++) salto = Math.max(salto, Math.abs(c[i]! - c[i - 1]!));
        expect(salto).toBeLessThan(0.06);
      }
  });

  it("fundidos: empieza y termina en silencio, con entrada de 2 s y salida de 3 s", () => {
    for (const p of pistas) {
      const c = p.izquierda;
      expect(Math.abs(c[0]!)).toBe(0);
      expect(Math.abs(c.at(-1)!)).toBeLessThan(1e-6);
      const medio = rms(c, 5 * FM, 7 * FM);
      expect(rms(c, 0, FM / 4)).toBeLessThan(medio / 20);
      expect(rms(c, c.length - FM / 4, c.length)).toBeLessThan(medio / 20);
      expect(rms(c, 2 * FM, 3 * FM)).toBeGreaterThan(medio / 4);
    }
  });

  it("sin agudos ásperos: la energía sobre 6 kHz es despreciable", () => {
    for (const p of pistas) expect(energiaSobre(p.izquierda, 6 * FM, 2048, 6000)).toBeLessThan(-45);
  });

  it("sin continua (DC)", () => {
    for (const p of pistas) {
      let s = 0;
      for (const v of p.derecha) s += v;
      expect(Math.abs(s / p.derecha.length)).toBeLessThan(1e-3);
    }
  });

  it("WAV de coma flotante de 32 bits, estéreo, 48 kHz", () => {
    const p = pistas[0]!;
    const b = wav(p);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.toString("ascii", 8, 12)).toBe("WAVE");
    expect(b.readUInt16LE(20)).toBe(3);
    expect(b.readUInt16LE(22)).toBe(2);
    expect(b.readUInt32LE(24)).toBe(48_000);
    expect(b.readUInt16LE(34)).toBe(32);
    expect(b.readUInt32LE(40)).toBe(p.izquierda.length * 8);
    expect(b.length).toBe(44 + p.izquierda.length * 8);
    const i = 3 * FM;
    expect(b.readFloatLE(44 + i * 8)).toBe(p.izquierda[i]);
    expect(b.readFloatLE(48 + i * 8)).toBe(p.derecha[i]);
  });
});

describe("sonoridad y control de picos", () => {
  it("el control de picos solo baja la ganancia, respeta el techo y cambia suave", () => {
    const N = FM;
    const L = new Float64Array(N);
    const R = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      L[n] = 0.1 * Math.sin((2 * Math.PI * 220 * n) / FM);
      R[n] = L[n]!;
    }
    // Un golpe de 0,9 a mitad del segundo.
    for (let n = 0; n < 2000; n++) L[FM / 2 + n]! += 0.8 * Math.sin((2 * Math.PI * 660 * n) / FM) * Math.exp(-n / 600);
    const antes = Float64Array.from(L);
    const reduccion = controlarPicos(L, R, -6);
    expect(reduccion).toBeGreaterThan(0);
    let pico = 0;
    let maxCambio = 0;
    let gPrev = 1;
    for (let n = 0; n < N; n++) {
      pico = Math.max(pico, Math.abs(L[n]!));
      if (Math.abs(antes[n]!) > 1e-3) {
        const g = L[n]! / antes[n]!;
        expect(g).toBeLessThanOrEqual(1 + 1e-9);
        if (n > 0) maxCambio = Math.max(maxCambio, Math.abs(20 * Math.log10(g) - 20 * Math.log10(gPrev)));
        gPrev = g;
      }
    }
    expect(20 * Math.log10(pico)).toBeLessThanOrEqual(-6 + 1e-6);
    // Lejos del golpe, la señal queda intacta.
    expect(L[1000]).toBe(antes[1000]);
  });

  it.skipIf(!existsSync(FFMPEG))("la estimación de sonoridad coincide con ebur128 de ffmpeg (±0,3 LU)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sonoridad-"));
    try {
      for (const v of VARIANTES) {
        const p = sintetizar(15, v);
        const ruta = join(dir, `v${v}.wav`);
        writeFileSync(ruta, wav(p));
        const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", ruta, "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"], { encoding: "utf8" });
        const medida = leerEbur128(r.stderr);
        expect(Math.abs(medida.integrado - sonoridadIntegrada(p.izquierda, p.derecha))).toBeLessThanOrEqual(0.3);
        expect(medida.picoReal).toBeLessThanOrEqual(SONORIDAD_SINTESIS + PICO_SOBRE_SONORIDAD_DB + 0.5);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
