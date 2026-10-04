import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BancoSchema,
  DIFICULTADES,
  MODULOS_EXAMEN,
  RAIZ_REPO,
  leerBanco,
  leerPractico,
  resumenBanco,
} from "./banco.js";
import { PREGUNTAS_POR_EXAMEN } from "./sorteo.js";

const banco = leerBanco();
const practico = leerPractico();

describe("banco de preguntas", () => {
  it("tiene al menos 80 preguntas y cubre M0 a M6", () => {
    expect(banco.preguntas.length).toBeGreaterThanOrEqual(80);
    const r = resumenBanco(banco);
    for (const m of MODULOS_EXAMEN) expect(r[m].total, m).toBeGreaterThan(0);
  });

  it("alcanza para sortear un examen equilibrado, con las tres dificultades en cada módulo", () => {
    const porModulo = Math.ceil(PREGUNTAS_POR_EXAMEN / MODULOS_EXAMEN.length);
    const r = resumenBanco(banco);
    for (const m of MODULOS_EXAMEN) {
      expect(r[m].total, m).toBeGreaterThanOrEqual(2 * porModulo);
      for (const d of DIFICULTADES) expect(r[m][d], `${m} ${d}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("reparte la respuesta correcta entre las cuatro letras", () => {
    const porLetra = { a: 0, b: 0, c: 0, d: 0 };
    for (const p of banco.preguntas) porLetra[p.correcta]++;
    for (const n of Object.values(porLetra)) expect(n).toBeGreaterThanOrEqual(banco.preguntas.length / 8);
  });

  it("cada referencia apunta a un archivo que existe en el repositorio", () => {
    const faltan = banco.preguntas.filter((p) => p.referencia && !existsSync(join(RAIZ_REPO, p.referencia)));
    expect(faltan.map((p) => `${p.id}: ${p.referencia}`)).toEqual([]);
  });

  it("rechaza preguntas mal formadas", () => {
    const base = banco.preguntas[0]!;
    const conIdAjeno = { ...base, id: "M1-99" };
    expect(BancoSchema.safeParse({ version: "1.0.0", producto: "x", preguntas: [conIdAjeno] }).success).toBe(
      false,
    );
    const repetidas = { ...base, opciones: { a: "x", b: "x", c: "y", d: "z" } };
    expect(BancoSchema.safeParse({ version: "1.0.0", producto: "x", preguntas: [repetidas] }).success).toBe(
      false,
    );
    expect(BancoSchema.safeParse({ version: "1.0.0", producto: "x", preguntas: [base, base] }).success).toBe(
      false,
    );
  });
});

describe("examen práctico", () => {
  const scripts = (
    JSON.parse(readFileSync(join(RAIZ_REPO, "tools/lab-bootstrap/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const makefile = readFileSync(join(RAIZ_REPO, "deploy/compose/Makefile"), "utf8");

  it("tiene entre 4 y 6 tareas que suman 100 puntos y caben en el tiempo del práctico", () => {
    expect(practico.tareas.length).toBeGreaterThanOrEqual(4);
    expect(practico.tareas.length).toBeLessThanOrEqual(6);
    expect(practico.tareas.reduce((s, t) => s + t.puntos, 0)).toBe(100);
    expect(practico.tareas.reduce((s, t) => s + t.tiempo_minutos, 0)).toBeLessThanOrEqual(
      practico.duracion_minutos,
    );
  });

  it("cada verificación automática usa un script o un objetivo que existe en el laboratorio", () => {
    for (const t of practico.tareas) {
      for (const v of t.verificacion) {
        if (v.check) expect(Object.keys(scripts), `${t.id}: ${v.check}`).toContain(v.check);
        if (v.make) expect(makefile, `${t.id}: make ${v.make}`).toMatch(new RegExp(`^${v.make}:`, "m"));
      }
    }
  });

  it("cada tarea se apoya en al menos un script de verificación o un objetivo del Makefile", () => {
    for (const t of practico.tareas)
      expect(
        t.verificacion.some((v) => v.check || v.make),
        t.id,
      ).toBe(true);
  });
});

describe("contenido publicable", () => {
  // Mismo control que el sitio público (apps/site/scripts/lib.mjs): sin clientes, procesos de compra,
  // códigos internos de requisitos, precios ni nombres de personas del equipo.
  type Hallazgo = { match: string; motivo: string };
  const lib = import(pathToFileURL(join(RAIZ_REPO, "apps/site/scripts/lib.mjs")).href) as Promise<{
    findForbidden: (texto: string) => Hallazgo[];
  }>;
  for (const archivo of [
    "tools/certificacion/banco.yaml",
    "tools/certificacion/practico.yaml",
    "tools/lab-bootstrap/ayudas-curso.sh",
  ]) {
    it(`${archivo} pasa el control de contenido publicable del sitio`, async () => {
      const { findForbidden } = await lib;
      const texto = readFileSync(join(RAIZ_REPO, archivo), "utf8");
      expect(findForbidden(texto)).toEqual([]);
    });
  }
});
