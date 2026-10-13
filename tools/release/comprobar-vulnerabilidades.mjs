// Comprueba que la tabla de vulnerabilidades (Markdown), su JSON y el OpenVEX de una versión coincidan: mismas
// filas, mismos totales y una declaración de VEX por cada crítica. Parte del caso LAB-PA-055-01.
//
// Uso: node tools/release/comprobar-vulnerabilidades.mjs <carpeta con los archivos de la versión> <versión>
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { comprobarConsistencia } from "./lib/vulnerabilidades.mjs";

const [carpeta, version] = process.argv.slice(2);
if (!carpeta || !version) {
  console.error("Uso: node tools/release/comprobar-vulnerabilidades.mjs <carpeta> <versión>");
  process.exit(2);
}
const leer = (f) => readFileSync(join(resolve(carpeta), f), "utf8");
const json = JSON.parse(leer(`vulnerabilidades-nexo-${version}.json`));
const vex = JSON.parse(leer(`vex-nexo-${version}.openvex.json`));
const errores = comprobarConsistencia({ markdown: leer(`vulnerabilidades-nexo-${version}.md`), json, vex });
if (errores.length) {
  console.error(`Tabla, JSON y OpenVEX de ${version} no coinciden:\n  - ${errores.join("\n  - ")}`);
  process.exit(1);
}
const criticas = json.vulnerabilidades.filter((v) => v.severidad === "Critical").length;
console.log(
  `Tabla, JSON y OpenVEX de ${version} coinciden: ${json.vulnerabilidades.length} filas, ${criticas} críticas, ${vex.statements.length} declaraciones de VEX.`,
);
