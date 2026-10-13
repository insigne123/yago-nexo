import { describe, expect, it } from "vitest";
import { bloquesSubtitulo, capitulosIndice, capitulosVtt, envolver, equilibrar, leerVtt, subtitulosVtt, textoVtt, tiempoVtt, validarPasos, type ArchivoPasos } from "./vtt.js";

const ejemplo = (): ArchivoPasos => ({
  producto: "Yago Nexo",
  version: "1.2.0",
  commit_producto: "abc1234",
  commit_herramientas: "def5678",
  ensayo: false,
  ancho: 1920,
  alto: 1080,
  cps: 30,
  duracion_s: 40,
  pasos: [
    {
      n: 1,
      inicio_s: 11,
      fin_s: 22,
      titulo: "Inventario vacío",
      que_pasa: "La Consola muestra el inventario de APIs descubiertas: todavía no hay hallazgos. El motor recorre el perímetro (gateways heredados y servicios de la red autorizada) y anota cada endpoint.",
      por_que_importa: "Parte de un estado conocido.",
      comprueba: [{ texto: "inventario vacío", ok: true, valor: "0 hallazgos" }],
    },
    {
      n: 2,
      inicio_s: 22,
      fin_s: 30.5,
      titulo: "Escaneo <rápido> & clasificación",
      que_pasa: "Se lanza el escaneo; en 7 s aparecen los endpoints no gobernados.",
      por_que_importa: "Se ve cómo se detecta lo que está fuera del catálogo.",
      comprueba: [{ texto: "escaneo terminado", ok: true, valor: 6.9 }],
    },
  ],
});

describe("validación del archivo de pasos", () => {
  it("acepta el ejemplo, también para publicar", () => {
    expect(validarPasos(ejemplo())).toEqual({ ok: true, problemas: [], pasos: ejemplo() });
    expect(validarPasos(ejemplo(), { publicar: true }).ok).toBe(true);
  });

  it("estructura: numeración, orden, tiempos y campos", () => {
    const p = ejemplo();
    p.pasos[1]!.n = 3;
    p.pasos[1]!.inicio_s = 20;
    p.pasos[1]!.fin_s = 41;
    p.pasos[0]!.que_pasa = " ";
    p.pasos[0]!.comprueba = [{ texto: "x", ok: "sí" as unknown as boolean }];
    const r = validarPasos(p);
    expect(r.ok).toBe(false);
    expect(r.problemas.join("\n")).toMatch(/«n» es 3/);
    expect(r.problemas.join("\n")).toMatch(/antes de que termine el anterior/);
    expect(r.problemas.join("\n")).toMatch(/después del video/);
    expect(r.problemas.join("\n")).toMatch(/falta «que_pasa»/);
    expect(r.problemas.join("\n")).toMatch(/comprobación 1 sin «texto» u «ok»/);
    expect(validarPasos(null).ok).toBe(false);
    expect(validarPasos({ ...ejemplo(), commit_producto: "xyz" }).problemas[0]).toMatch(/commit/);
    expect(validarPasos({ ...ejemplo(), pasos: [] }).ok).toBe(false);
  });

  it("publicación: ensayo, resolución, cps, tope de 240 s, pasos de 7 s y comprobaciones", () => {
    const casos: Array<[Partial<ArchivoPasos>, RegExp]> = [
      [{ ensayo: true }, /ENSAYO/],
      [{ ancho: 1280, alto: 720 }, /resolución 1280×720/],
      [{ cps: 15 }, /15 cps/],
      [{ duracion_s: 241 }, /máximo 240 s/],
    ];
    for (const [cambio, re] of casos) {
      const r = validarPasos({ ...ejemplo(), ...cambio }, { publicar: true });
      expect(r.ok).toBe(false);
      expect(r.problemas.join("\n")).toMatch(re);
      // Sin «publicar» solo se revisa la estructura.
      expect(validarPasos({ ...ejemplo(), ...cambio }).ok).toBe(true);
    }
    expect(validarPasos({ ...ejemplo(), ancho: 1600, alto: 900, cps: 25 }, { publicar: true }).ok).toBe(true);
    const corto = ejemplo();
    corto.pasos[1]!.fin_s = 28.9;
    expect(validarPasos(corto, { publicar: true }).problemas.join()).toMatch(/dura 6\.9 s \(mínimo 7 s\)/);
    const fallida = ejemplo();
    fallida.pasos[0]!.comprueba.push({ texto: "algo", ok: false });
    expect(validarPasos(fallida, { publicar: true }).problemas.join()).toMatch(/no cumplida: algo/);
  });
});

describe("WebVTT", () => {
  it("tiempos", () => {
    expect(tiempoVtt(0)).toBe("00:00:00.000");
    expect(tiempoVtt(3725.5)).toBe("01:02:05.500");
    expect(tiempoVtt(59.9996)).toBe("00:01:00.000");
    expect(tiempoVtt(-1)).toBe("00:00:00.000");
  });

  it("texto seguro: sin marcas, sin saltos y sin flechas", () => {
    expect(textoVtt("a <b> & c\n\nd --> e")).toBe("a &lt;b&gt; &amp; c d --&gt; e");
  });

  it("envolver y equilibrar", () => {
    expect(envolver("uno dos tres", 7)).toEqual(["uno dos", "tres"]);
    expect(envolver("supercalifragilístico", 10)).toEqual(["supercalif", "ragilístic", "o"]);
    const [a, b] = equilibrar("El motor de descubrimiento recorre el perímetro");
    expect(Math.abs(a!.length - b!.length)).toBeLessThan(10);
  });

  it("bloques de hasta 2 líneas de 42 caracteres que conservan todo el texto en orden", () => {
    const texto =
      "Se crea la regla con sensibilidad 3 y volumen mínimo de 20 llamadas por ventana de 30 segundos; el guardián aprende la línea base con 61 ventanas de tráfico normal y bloquea al consumidor B cuando supera el umbral. Fin.";
    const bloques = bloquesSubtitulo(texto);
    for (const b of bloques) {
      expect(b.length).toBeLessThanOrEqual(2);
      for (const l of b) expect(l.length).toBeLessThanOrEqual(42);
    }
    expect(bloques.flat().join(" ")).toBe(texto);
    // Un resto corto («Fin.») no queda solo.
    expect(bloques.at(-1)!.join(" ")).not.toBe("Fin.");
  });

  it("subtítulos: cada paso con su título y «qué pasa», dentro de su tiempo", () => {
    const a = ejemplo();
    const senales = leerVtt(subtitulosVtt(a));
    expect(senales.length).toBeGreaterThanOrEqual(a.pasos.length);
    for (const paso of a.pasos) {
      const propias = senales.filter((s) => s.id?.startsWith(`paso-${paso.n}-`));
      expect(propias.length).toBeGreaterThan(0);
      expect(propias[0]!.inicio).toBeCloseTo(paso.inicio_s, 3);
      expect(propias.at(-1)!.fin).toBeLessThanOrEqual(paso.fin_s);
      expect(propias.at(-1)!.fin).toBeGreaterThan(paso.fin_s - 0.25);
      for (let i = 1; i < propias.length; i++) expect(propias[i]!.inicio).toBeCloseTo(propias[i - 1]!.fin, 3);
      for (const s of propias) {
        const [titulo, ...cuerpo] = s.texto.split("\n");
        expect(titulo).toBe(`<b>${textoVtt(`Paso ${paso.n} de 2 · ${paso.titulo}`)}</b>`);
        expect(cuerpo.length).toBeLessThanOrEqual(2);
      }
      const cuerpo = propias.map((s) => s.texto.split("\n").slice(1).join(" ")).join(" ");
      expect(cuerpo).toBe(textoVtt(paso.que_pasa));
    }
    expect(subtitulosVtt(a)).not.toMatch(/<rápido>/);
  });

  it("capítulos: uno por paso con sus tiempos exactos", () => {
    const a = ejemplo();
    const caps = leerVtt(capitulosVtt(a));
    expect(caps).toEqual([
      { id: "capitulo-1", inicio: 11, fin: 22, texto: "1. Inventario vacío" },
      { id: "capitulo-2", inicio: 22, fin: 30.5, texto: "2. Escaneo &lt;rápido&gt; &amp; clasificación" },
    ]);
    expect(capitulosIndice(a)).toEqual([
      { n: 1, title: "Inventario vacío", start_s: 11, end_s: 22 },
      { n: 2, title: "Escaneo <rápido> & clasificación", start_s: 22, end_s: 30.5 },
    ]);
  });

  it("el lector rechaza archivos que no son WebVTT", () => {
    expect(() => leerVtt("hola\n\n00:00.000 --> 00:01.000\nx")).toThrow(/WEBVTT/);
    expect(leerVtt("WEBVTT\n\nNOTE algo\n\n00:01.500 --> 00:02.000 line:90%\nx")).toEqual([{ inicio: 1.5, fin: 2, texto: "x" }]);
  });
});
