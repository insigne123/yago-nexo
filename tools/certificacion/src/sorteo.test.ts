import { describe, expect, it } from "vitest";
import { azarConSemilla, barajar } from "./azar.js";
import { LETRAS, MODULOS_EXAMEN, leerBanco } from "./banco.js";
import { PREGUNTAS_POR_EXAMEN, examenMarkdown, plantillaHoja, repartir, sortearExamen } from "./sorteo.js";

const banco = leerBanco();
const porId = new Map(banco.preguntas.map((p) => [p.id, p]));
const SEMILLAS = Array.from({ length: 40 }, (_, i) => `curso-prueba-${i}`);

describe("generador con semilla", () => {
  it("la misma semilla da la misma secuencia y otra semilla da otra", () => {
    const a = azarConSemilla("x");
    const b = azarConSemilla("x");
    const c = azarConSemilla("y");
    const sa = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(sa);
    expect(Array.from({ length: 5 }, c)).not.toEqual(sa);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });

  it("barajar no pierde ni repite elementos", () => {
    const lista = Array.from({ length: 50 }, (_, i) => i);
    const b = barajar(azarConSemilla("z"), lista);
    expect([...b].sort((x, y) => x - y)).toEqual(lista);
    expect(b).not.toEqual(lista);
  });
});

describe("sorteo del examen", () => {
  it("tiene 40 preguntas distintas, de todos los módulos, con diferencia máxima de una entre módulos", () => {
    for (const s of SEMILLAS) {
      const ex = sortearExamen(banco, s);
      expect(ex.preguntas).toHaveLength(PREGUNTAS_POR_EXAMEN);
      expect(new Set(ex.preguntas.map((p) => p.id)).size).toBe(PREGUNTAS_POR_EXAMEN);
      const conteo = MODULOS_EXAMEN.map((m) => ex.preguntas.filter((p) => p.modulo === m).length);
      expect(Math.min(...conteo)).toBeGreaterThanOrEqual(
        Math.floor(PREGUNTAS_POR_EXAMEN / MODULOS_EXAMEN.length),
      );
      expect(Math.max(...conteo) - Math.min(...conteo)).toBeLessThanOrEqual(1);
      expect(conteo).toEqual(MODULOS_EXAMEN.map((m) => ex.distribucion[m]));
      expect(ex.preguntas.map((p) => p.n)).toEqual(
        Array.from({ length: PREGUNTAS_POR_EXAMEN }, (_, i) => i + 1),
      );
    }
  });

  it("incluye las tres dificultades en cada módulo", () => {
    for (const s of SEMILLAS) {
      const ex = sortearExamen(banco, s);
      for (const m of MODULOS_EXAMEN) {
        const difs = new Set(ex.preguntas.filter((p) => p.modulo === m).map((p) => p.dificultad));
        expect(difs.size, `${s} ${m}`).toBe(3);
      }
    }
  });

  it("es reproducible: la misma semilla produce exactamente el mismo examen", () => {
    const a = sortearExamen(banco, "2026-11-curso-a-p07");
    const b = sortearExamen(banco, "2026-11-curso-a-p07");
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(examenMarkdown(b)).toBe(examenMarkdown(a));
  });

  it("semillas distintas producen exámenes distintos", () => {
    const firmas = new Set(
      SEMILLAS.map((s) =>
        sortearExamen(banco, s)
          .preguntas.map((p) => p.id)
          .join(","),
      ),
    );
    expect(firmas.size).toBe(SEMILLAS.length);
  });

  it("baraja las alternativas sin perder la respuesta correcta", () => {
    const ex = sortearExamen(banco, "alternativas");
    let movidas = 0;
    for (const p of ex.preguntas) {
      const original = porId.get(p.id)!;
      expect(p.opciones.map((o) => o.letra)).toEqual([...LETRAS]);
      expect(p.opciones.map((o) => o.texto).sort()).toEqual(LETRAS.map((l) => original.opciones[l]).sort());
      const elegida = p.opciones.find((o) => o.letra === p.correcta)!;
      expect(elegida.texto).toBe(original.opciones[original.correcta]);
      if (p.correcta !== original.correcta) movidas++;
    }
    expect(movidas).toBeGreaterThan(0);
  });

  it("el reparto elige con la semilla qué módulos llevan una pregunta extra", () => {
    const extras = new Set(
      SEMILLAS.map((s) => {
        const d = repartir(azarConSemilla(s), PREGUNTAS_POR_EXAMEN);
        return MODULOS_EXAMEN.filter((m) => d[m] === 6).join(",");
      }),
    );
    expect(extras.size).toBeGreaterThan(1);
  });

  it("rechaza una semilla vacía y un banco insuficiente", () => {
    expect(() => sortearExamen(banco, "  ")).toThrow(/semilla/);
    const chico = {
      ...banco,
      preguntas: banco.preguntas.filter((p) => p.modulo !== "M4" || p.id === "M4-01"),
    };
    expect(() => sortearExamen(chico, "x")).toThrow(/M4/);
  });

  it("el enunciado y la hoja en blanco no revelan las respuestas", () => {
    const ex = sortearExamen(banco, "sin-respuestas");
    const md = examenMarkdown(ex);
    for (const p of ex.preguntas.slice(0, 5)) expect(md).not.toContain(p.justificacion);
    const hoja = plantillaHoja(ex, ["P1", "P2"]);
    expect(hoja).toContain(`examen: "sin-respuestas"`);
    expect(hoja).toContain('  40: ""');
    expect(hoja).toContain("    P2: pendiente");
  });
});
