// Tabla de vulnerabilidades (Markdown y JSON, sin cortar) y documento OpenVEX de las críticas de una versión,
// a partir de los resultados de grype sobre el SBOM de cada imagen. Lo corre .github/workflows/release.yml.
//
// Uso:
//   node tools/release/vulnerabilidades.mjs --version 1.2.0 --manifiesto <imagenes.json> --salida release/1.2.0
//     [--decisiones tools/release/vex-decisiones.json] [--id-documento <IRI>]
// El manifiesto es una lista [{ "imagen": "<referencia>", "tipo": "propia" | "tercero", "grype": "<ruta JSON>" }];
// las rutas relativas se resuelven desde la carpeta del manifiesto.
// Escribe vulnerabilidades-nexo-<v>.md, vulnerabilidades-nexo-<v>.json y vex-nexo-<v>.openvex.json.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  documentoVex,
  filasDesdeGrype,
  resumenPorImagen,
  tablaJson,
  tablaMarkdown,
} from "./lib/vulnerabilidades.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: op } = parseArgs({
  options: {
    version: { type: "string" },
    manifiesto: { type: "string" },
    salida: { type: "string" },
    decisiones: { type: "string", default: join(raiz, "tools/release/vex-decisiones.json") },
    "id-documento": { type: "string" },
  },
});
for (const req of ["version", "manifiesto", "salida"]) {
  if (!op[req]) {
    console.error(
      `Falta --${req}. Uso: node tools/release/vulnerabilidades.mjs --version X --manifiesto M --salida D`,
    );
    process.exit(2);
  }
}

const manifiesto = resolve(op.manifiesto);
const lista = JSON.parse(readFileSync(manifiesto, "utf8"));
const entradas = lista.map((e) => ({
  imagen: e.imagen,
  tipo: e.tipo === "propia" ? "propia" : "tercero",
  grype: JSON.parse(readFileSync(resolve(dirname(manifiesto), e.grype), "utf8")),
}));
const decisiones = JSON.parse(readFileSync(resolve(op.decisiones), "utf8")).decisiones ?? [];

const d0 = entradas[0]?.grype?.descriptor;
const herramienta = d0
  ? `grype ${d0.version}${d0.db?.status?.built ? ` (base de datos del ${d0.db.status.built})` : ""}`
  : "grype";
const generado = new Date().toISOString();
const filas = filasDesdeGrype(entradas);
const comun = { version: op.version, generado, herramienta, entradas, filas, decisiones };
const repo = process.env.GITHUB_REPOSITORY;
const idDocumento =
  op["id-documento"] ??
  (repo
    ? `https://github.com/${repo}/releases/download/v${op.version}/vex-nexo-${op.version}.openvex.json`
    : `urn:uuid:${randomUUID()}`);

const vex = documentoVex({ ...comun, autor: "Sociedad de Inversiones Yago SpA", idDocumento });
const salida = resolve(op.salida);
mkdirSync(salida, { recursive: true });
writeFileSync(join(salida, `vulnerabilidades-nexo-${op.version}.md`), tablaMarkdown(comun));
writeFileSync(
  join(salida, `vulnerabilidades-nexo-${op.version}.json`),
  JSON.stringify(tablaJson(comun), null, 2) + "\n",
);
writeFileSync(join(salida, `vex-nexo-${op.version}.openvex.json`), JSON.stringify(vex, null, 2) + "\n");

console.log(`Vulnerabilidades de Yago Nexo ${op.version} (${herramienta}):`);
for (const r of resumenPorImagen(entradas, filas)) {
  console.log(
    `  ${r.imagen}: ${r.Critical} críticas, ${r.High} altas, ${r.Medium} medias, ${r.Low} bajas (${r.total} en total)`,
  );
}
const pendientes = vex.statements.filter((s) => s.status === "under_investigation").length;
console.log(`  VEX: ${vex.statements.length} críticas declaradas (${pendientes} en análisis).`);
