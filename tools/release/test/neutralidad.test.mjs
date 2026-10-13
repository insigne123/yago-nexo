import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PERMITIDOS, TERMINOS, buscar, evaluar } from "../lib/neutralidad.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));
// Los textos de prueba se arman por partes: este archivo tampoco contiene los términos literales.
const NOMBRE = ["SU", "BT", "EL"].join("");
const ID = ["60", "6-", "26"].join("");

test("detecta el nombre sin distinguir mayúsculas, con línea y columna", () => {
  const h = buscar(`hola\nla ${NOMBRE.toLowerCase()} y ${NOMBRE}`);
  assert.equal(h.length, 2);
  assert.deepEqual(
    h.map((x) => [x.linea, x.columna]),
    [
      [2, 4],
      [2, 13],
    ],
  );
});

test("detecta el identificador del proceso, pero no trozos de UUID o hashes", () => {
  assert.equal(buscar(`proceso ${ID}-LE26`).length, 1);
  assert.equal(buscar(`id 1${ID}b4-aa`).length, 0);
  assert.equal(buscar(`a${ID}`).length, 0);
});

test("falla con un archivo nuevo que nombra a la institución y con un nombre de archivo", () => {
  const r = evaluar([
    { ruta: "apps/x/datos.json", contenido: `{"cliente": "${NOMBRE}"}` },
    { ruta: `docs/${NOMBRE.toLowerCase()}.md`, contenido: "neutro" },
    { ruta: "apps/x/limpio.ts", contenido: "export const a = 1;" },
  ]);
  assert.deepEqual(
    r.map((i) => i.ruta),
    ["apps/x/datos.json", `docs/${NOMBRE.toLowerCase()}.md`],
  );
});

test("convive con las reglas permitidas, pero no acepta más apariciones de las declaradas", () => {
  const regla = { ruta: "apps/site/scripts/lib.mjs", maximo: 2, motivo: "regla" };
  assert.deepEqual(evaluar([{ ruta: regla.ruta, contenido: `/${NOMBRE}/i y /${ID}-LE26/` }], [regla]), []);
  const r = evaluar([{ ruta: regla.ruta, contenido: `/${NOMBRE}/ /${ID}/ y ${NOMBRE}` }], [regla]);
  assert.equal(r.length, 1);
  assert.match(r[0].detalle, /más que las 2 permitidas/);
});

test("omite los archivos binarios", () => {
  const binario = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(NOMBRE)]);
  assert.deepEqual(evaluar([{ ruta: "a.png", contenido: binario }]), []);
});

test("ni la guarda ni sus pruebas contienen los términos literales", () => {
  for (const archivo of ["../lib/neutralidad.mjs", "../verificar-neutralidad.mjs", "neutralidad.test.mjs"]) {
    const texto = readFileSync(join(aqui, archivo), "utf8");
    assert.deepEqual(buscar(texto), [], archivo);
  }
  assert.equal(TERMINOS.length, 2);
  assert.ok(PERMITIDOS.every((p) => p.motivo && p.maximo > 0));
});
