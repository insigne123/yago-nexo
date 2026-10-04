import { describe, expect, it } from "vitest";
import { leerBanco, leerPractico } from "./banco.js";
import { corregir, informe, validarHoja, type Hoja } from "./correccion.js";
import { sortearExamen, type Examen } from "./sorteo.js";

const banco = leerBanco();
const practico = leerPractico();
const examen = sortearExamen(banco, "correccion");

const incorrecta = (l: string) => ({ a: "b", b: "c", c: "d", d: "a" })[l]!;

/** Respuestas con exactamente `buenas` correctas (las primeras) y el resto incorrectas. */
function respuestas(ex: Examen, buenas: number): Record<string, string> {
  return Object.fromEntries(
    ex.preguntas.map((p, i) => [String(p.n), i < buenas ? p.correcta : incorrecta(p.correcta)]),
  );
}

const practicoAprobado = {
  evaluador: "Instructora de prueba",
  tareas: { P1: "aprobada", P2: "aprobada", P3: "aprobada", P4: "aprobada", P5: "aprobada" },
} as const;

function hoja(parcial: Partial<Hoja> = {}): Hoja {
  return validarHoja({
    examen: examen.id,
    participante: { nombre: "Persona de Prueba", documento: "11.111.111-1" },
    respuestas: respuestas(examen, 40),
    practico: practicoAprobado,
    ...parcial,
  });
}

describe("corrección del teórico", () => {
  it("todas correctas: 100 % y aprobado", () => {
    const r = corregir(examen, practico, hoja());
    expect(r.teorico.correctas).toBe(40);
    expect(r.teorico.porcentaje).toBe(100);
    expect(r.teorico.aprobado).toBe(true);
    expect(r.aprobado).toBe(true);
  });

  it("28 de 40 (70 %) aprueba y 27 de 40 (67,5 %) reprueba", () => {
    const r28 = corregir(examen, practico, hoja({ respuestas: respuestas(examen, 28) }));
    expect(r28.teorico.porcentaje).toBe(70);
    expect(r28.teorico.aprobado).toBe(true);
    expect(r28.aprobado).toBe(true);
    const r27 = corregir(examen, practico, hoja({ respuestas: respuestas(examen, 27) }));
    expect(r27.teorico.porcentaje).toBe(67.5);
    expect(r27.teorico.aprobado).toBe(false);
    expect(r27.aprobado).toBe(false);
  });

  it("una respuesta en blanco o nula cuenta como incorrecta y se aceptan mayúsculas", () => {
    const resp = respuestas(examen, 40);
    const p1 = examen.preguntas[0]!;
    const p2 = examen.preguntas[1]!;
    const p3 = examen.preguntas[2]!;
    const r = corregir(
      examen,
      practico,
      hoja({
        respuestas: {
          ...resp,
          [p1.n]: "",
          [p2.n]: null as unknown as string,
          [p3.n]: p3.correcta.toUpperCase(),
        },
      }),
    );
    expect(r.teorico.correctas).toBe(38);
    expect(r.teorico.detalle.find((d) => d.n === p1.n)?.respuesta).toBeNull();
  });

  it("entrega el detalle por módulo y suma el total", () => {
    const r = corregir(examen, practico, hoja({ respuestas: respuestas(examen, 30) }));
    const suma = Object.values(r.teorico.porModulo).reduce((s, x) => s + x.correctas, 0);
    const total = Object.values(r.teorico.porModulo).reduce((s, x) => s + x.total, 0);
    expect(suma).toBe(30);
    expect(total).toBe(40);
    for (const [m, x] of Object.entries(r.teorico.porModulo))
      expect(x.total).toBe(examen.distribucion[m as keyof typeof examen.distribucion]);
  });

  it("rechaza letras inválidas, preguntas inexistentes y una hoja de otro examen", () => {
    expect(() => corregir(examen, practico, hoja({ respuestas: { 1: "e" } }))).toThrow(/a, b, c ni d/);
    expect(() => corregir(examen, practico, hoja({ respuestas: { 41: "a" } }))).toThrow(/no existen/);
    expect(() => corregir(examen, practico, hoja({ examen: "otro" }))).toThrow(/otro/);
  });

  it("exige nombre y documento del participante", () => {
    expect(() => validarHoja({ examen: "x", participante: { nombre: "", documento: "1" } })).toThrow(
      /nombre/,
    );
  });
});

describe("corrección del práctico", () => {
  it("teórico aprobado con práctico reprobado no aprueba", () => {
    const r = corregir(
      examen,
      practico,
      hoja({
        practico: {
          evaluador: "Instructora",
          tareas: { P1: "aprobada", P2: "aprobada", P3: "aprobada", P4: "reprobada", P5: "reprobada" },
        },
      }),
    );
    expect(r.teorico.aprobado).toBe(true);
    expect(r.practico.puntos).toBe(60);
    expect(r.practico.aprobado).toBe(false);
    expect(r.aprobado).toBe(false);
  });

  it("70 puntos no bastan si falta la tarea obligatoria P1", () => {
    const sinP1 = {
      ...practico,
      tareas: practico.tareas.map((t) => (t.id === "P5" ? { ...t, puntos: 40 } : t)),
    };
    const r = corregir(
      examen,
      sinP1,
      hoja({
        practico: {
          evaluador: "Instructora",
          tareas: { P1: "reprobada", P2: "aprobada", P3: "aprobada", P4: "aprobada", P5: "aprobada" },
        },
      }),
    );
    expect(r.practico.puntos * 100).toBeGreaterThanOrEqual(70 * r.practico.maximo);
    expect(r.practico.aprobado).toBe(false);
    expect(r.practico.motivos.join(" ")).toMatch(/obligatorias no aprobadas: P1/);
  });

  it("cuatro de cinco tareas con P1 aprueban (80 puntos)", () => {
    const r = corregir(
      examen,
      practico,
      hoja({
        practico: {
          evaluador: "Instructora",
          tareas: { P1: "aprobada", P2: "aprobada", P3: "reprobada", P4: "aprobada", P5: "aprobada" },
        },
      }),
    );
    expect(r.practico.puntos).toBe(80);
    expect(r.practico.aprobado).toBe(true);
    expect(r.aprobado).toBe(true);
  });

  it("tareas sin evaluar o sin evaluador dejan el práctico reprobado", () => {
    const pendiente = corregir(
      examen,
      practico,
      hoja({ practico: { evaluador: "Instructora", tareas: { P1: "aprobada" } } }),
    );
    expect(pendiente.practico.aprobado).toBe(false);
    expect(pendiente.practico.motivos.join(" ")).toMatch(/sin evaluar/);
    const sinEvaluador = corregir(
      examen,
      practico,
      hoja({ practico: { ...practicoAprobado, evaluador: "" } }),
    );
    expect(sinEvaluador.practico.aprobado).toBe(false);
  });

  it("rechaza tareas que no existen en el práctico", () => {
    expect(() =>
      corregir(examen, practico, hoja({ practico: { evaluador: "x", tareas: { P9: "aprobada" } } })),
    ).toThrow(/P9/);
  });

  it("el informe resume teórico, práctico y resultado final", () => {
    const texto = informe(corregir(examen, practico, hoja()));
    expect(texto).toContain("Teórico: 40 de 40 (100 %) → APROBADO");
    expect(texto).toContain("Práctico: 100 de 100 puntos");
    expect(texto).toContain("Resultado final: APROBADO");
  });
});
