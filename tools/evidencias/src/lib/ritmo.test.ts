import { describe, expect, it } from "vitest";
import { RegistroPasos, validarPasos, type PasosJson } from "./pasos.js";
import {
  CIERRE_S,
  duracionMinimaMs,
  esperaAlCerrar,
  esperaParaMinimo,
  LECTURA_COMPROBADO_MS,
  pausaLectura,
  PASO_MINIMO_S,
  PORTADA_S,
  presupuesto,
  RegistroZoom,
  TOPE_VIDEO_S,
  ZOOM_MAX_FRACCION,
} from "./ritmo.js";

describe("ritmo (V03)", () => {
  it("mínimo de 7 s por paso y tope de 240 s por video", () => {
    expect(PASO_MINIMO_S).toBe(7);
    expect(TOPE_VIDEO_S).toBe(240);
  });

  it("esperaParaMinimo: lo que falta para los 7 s (0 si ya se cumplieron)", () => {
    expect(esperaParaMinimo(1000, 4000)).toBe(4000);
    expect(esperaParaMinimo(1000, 8000)).toBe(0);
    expect(esperaParaMinimo(1000, 9000)).toBe(0);
    expect(esperaParaMinimo(0, 2000, 12)).toBe(10_000);
  });

  it("esperaAlCerrar deja a la vista la última verificación antes de cambiar de paso", () => {
    // Paso de 9 s cuya última verificación llegó hace 0,5 s: se esperan 2 s más.
    expect(esperaAlCerrar({ inicioMs: 0, ahoraMs: 9000, ultimaComprobacionMs: 8500, restantesS: 100 })).toBe(
      LECTURA_COMPROBADO_MS - 500,
    );
    // Sin verificaciones en el paso (o de un paso anterior): solo el mínimo.
    expect(esperaAlCerrar({ inicioMs: 10_000, ahoraMs: 12_000, ultimaComprobacionMs: 9000 })).toBe(5000);
    expect(esperaAlCerrar({ inicioMs: 0, ahoraMs: 9000 })).toBe(0);
    // El mínimo manda si es mayor.
    expect(esperaAlCerrar({ inicioMs: 0, ahoraMs: 3000, ultimaComprobacionMs: 2900 })).toBe(4000);
    // Cerca del tope no se agrega la pausa de lectura.
    expect(esperaAlCerrar({ inicioMs: 0, ahoraMs: 9000, ultimaComprobacionMs: 8900, restantesS: 10 })).toBe(
      0,
    );
  });

  it("pausaLectura escala solo entre 0,5 y 2 (nadie acelera con el ritmo)", () => {
    expect(pausaLectura(1000)).toBe(1000);
    expect(pausaLectura(1000, 1.5)).toBe(1500);
    expect(pausaLectura(1000, 0.1)).toBe(500);
    expect(pausaLectura(1000, 9)).toBe(2000);
    expect(pausaLectura(1000, Number.NaN)).toBe(1000);
    expect(pausaLectura(-5)).toBe(0);
  });

  it("presupuesto descuenta el cierre del tope", () => {
    const p = presupuesto(0, 200_000);
    expect(p.usados).toBe(200);
    expect(p.restantes).toBe(TOPE_VIDEO_S - CIERRE_S - 200);
    expect(p.excedido).toBe(false);
    expect(presupuesto(0, (TOPE_VIDEO_S - CIERRE_S - 1) * 1000).excedido).toBe(false);
    expect(presupuesto(0, (TOPE_VIDEO_S - CIERRE_S + 1) * 1000).excedido).toBe(true);
  });
});

describe("RegistroZoom (como máximo 35 % del video ampliado)", () => {
  it("mide la fracción ampliada y la convierte a segundos del video", () => {
    const z = new RegistroZoom();
    z.abrir(1000, 1.8);
    expect(z.activo).toBeDefined();
    z.cerrar(4000);
    expect(z.activo).toBeUndefined();
    expect(z.ampliadoMs(10_000)).toBe(3000);
    expect(z.fraccion(0, 10_000)).toBeCloseTo(0.3);
    expect(z.enSegundos(0, 10_000)).toEqual([{ inicio_s: 1, fin_s: 4, factor: 1.8 }]);
  });

  it("cabe() rechaza una ampliación que dejaría más del 35 % ampliado", () => {
    const z = new RegistroZoom();
    z.abrir(0, 1.8);
    z.cerrar(3000);
    expect(z.cabe(0, 10_000, 500)).toBe(true); // 3,5 / 10,5 = 33 %
    expect(z.cabe(0, 10_000, 1000)).toBe(false); // 4 / 11 = 36 %
  });

  it("excedido() avisa cuando la ampliación en curso pasa el tope", () => {
    const z = new RegistroZoom();
    z.abrir(0, 2);
    expect(z.excedido(0, 1000)).toBe(true);
    const y = new RegistroZoom();
    y.abrir(9000, 2);
    expect(y.excedido(0, 10_000)).toBe(false);
  });

  it("con la duración mínima del video, una ampliación al comienzo cabe y el tope se cumple al final", () => {
    // 5 pasos: portada + 5 × 7 s + cierre.
    const minimo = duracionMinimaMs(5);
    expect(minimo).toBe((PORTADA_S + 5 * PASO_MINIMO_S + CIERRE_S) * 1000);
    const sin = new RegistroZoom();
    expect(sin.cabe(0, 8000, 4700)).toBe(false); // 4,7 / 12,7 = 37 % de lo transcurrido
    const z = new RegistroZoom();
    z.minimoTotalMs = minimo;
    expect(z.cabe(0, 8000, 4700)).toBe(true); // 4,7 / 42 = 11 %
    z.abrir(8000, 1.8);
    expect(z.excedido(0, 12_700)).toBe(false); // ya no se cierra sola a los 12,7 s
    z.cerrar(12_700);
    // Aunque el video dure solo su mínimo, lo ampliado queda bajo el 35 %.
    expect(z.fraccion(0, minimo)).toBeLessThanOrEqual(ZOOM_MAX_FRACCION);
    // El tope sigue valiendo: no cabe una que deje más del 35 % de la duración mínima.
    expect(z.cabe(0, 13_000, 0.35 * minimo)).toBe(false);
  });

  it("abrir con una ampliación activa solo cambia el factor", () => {
    const z = new RegistroZoom();
    z.abrir(0, 1.8);
    z.abrir(500, 1.5);
    expect(z.intervalos).toHaveLength(1);
    expect(z.intervalos[0]!.factor).toBe(1.5);
  });
});

describe("RegistroPasos y pasos.json", () => {
  const def = (titulo: string) => ({
    titulo,
    quePasa: `qué pasa en ${titulo}`,
    porQueImporta: `por qué importa ${titulo}`,
  });

  it("registra pasos con tiempos relativos al primer cuadro y las verificaciones en vivo de cada uno", () => {
    const r = new RegistroPasos(() => 10_000);
    r.comprobar({ texto: "antes del primer paso", ok: true });
    expect(r.abrir(def("uno"), 21_000)).toBe(1);
    r.comprobar({ texto: "a", ok: true, valor: 3 });
    expect(r.abrir(def("dos"), 30_500)).toBe(2);
    r.comprobar({ texto: "b", ok: false });
    r.cerrar(40_000);
    r.comprobar({ texto: "tras cerrar", ok: true });
    const p = r.pasos(50_000);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({
      n: 1,
      inicio_s: 11,
      fin_s: 20.5,
      titulo: "uno",
      que_pasa: "qué pasa en uno",
      por_que_importa: "por qué importa uno",
    });
    expect(p[0]!.comprueba).toEqual([
      { texto: "antes del primer paso", ok: true },
      { texto: "a", ok: true, valor: 3 },
    ]);
    expect(p[1]).toMatchObject({ n: 2, inicio_s: 20.5, fin_s: 30 });
    expect(p[1]!.comprueba).toEqual([
      { texto: "b", ok: false },
      { texto: "tras cerrar", ok: true },
    ]);
    expect(r.duraciones(50_000)).toEqual([9.5, 9.5]);
    expect(r.titulos()).toEqual(["uno", "dos"]);
  });

  it("un paso abierto termina al final del video", () => {
    const r = new RegistroPasos(() => 0);
    r.abrir(def("único"), 11_000);
    expect(r.pasos(30_000)[0]!.fin_s).toBe(30);
  });

  const base = (): PasosJson => ({
    producto: "Yago Nexo",
    version: "1.2.0",
    commit_producto: "abc1234",
    commit_herramientas: "def5678",
    ensayo: false,
    ancho: 1920,
    alto: 1080,
    cps: 30,
    duracion_s: 60,
    pasos: [
      {
        n: 1,
        inicio_s: 11,
        fin_s: 25,
        titulo: "uno",
        que_pasa: "q",
        por_que_importa: "p",
        comprueba: [{ texto: "x", ok: true }],
      },
      { n: 2, inicio_s: 25, fin_s: 46, titulo: "dos", que_pasa: "q", por_que_importa: "p", comprueba: [] },
    ],
  });

  it("validarPasos acepta un video en norma", () => {
    expect(validarPasos(base())).toEqual([]);
  });

  it("validarPasos rechaza pasos de menos de 7 s, videos de más de 240 s, verificaciones fallidas y textos vacíos", () => {
    const p = base();
    p.duracion_s = 241;
    p.pasos[0]!.fin_s = 17;
    p.pasos[1]!.inicio_s = 17;
    p.pasos[1]!.comprueba = [{ texto: "y", ok: false }];
    p.pasos[1]!.que_pasa = " ";
    const r = validarPasos(p);
    expect(r.some((x) => x.includes("241") && x.includes("240"))).toBe(true);
    expect(r.some((x) => x.startsWith("paso 1 dura 6.0 s"))).toBe(true);
    expect(r).toContain("paso 2 tiene verificaciones fallidas");
    expect(r).toContain("paso 2 sin «qué pasa» o «por qué importa»");
  });

  it("validarPasos exige producto, versión y los dos commits", () => {
    const p = base();
    p.commit_herramientas = "";
    p.version = "";
    expect(validarPasos(p)).toEqual(
      expect.arrayContaining(["falta producto o versión", "faltan los commits de producto y herramientas"]),
    );
  });

  it("validarPasos detecta pasos superpuestos o fuera del video", () => {
    const p = base();
    p.pasos[1]!.inicio_s = 20;
    p.pasos[1]!.fin_s = 70;
    const r = validarPasos(p);
    expect(r).toContain("paso 2 empieza antes de que termine el anterior");
    expect(r).toContain("paso 2 termina después del final del video");
  });
});

describe("portada y cierre (V07)", () => {
  it("la portada dura 3–4 s y el cierre 2–3 s; la imagen de portada (segundo 3) cae dentro de la portada", () => {
    expect(PORTADA_S).toBeGreaterThanOrEqual(3);
    expect(PORTADA_S).toBeLessThanOrEqual(4);
    expect(CIERRE_S).toBeGreaterThanOrEqual(2);
    expect(CIERRE_S).toBeLessThanOrEqual(3);
    expect(PORTADA_S).toBeGreaterThan(3);
  });
});
