// Falla si el nombre de la institución compradora o el identificador del proceso de compra aparecen en el
// repositorio (contenido o nombres de archivo), sin distinguir mayúsculas. Revisa los archivos versionados y los
// nuevos que git no ignora. Convive con las reglas del sitio y del grabador, que deben nombrar lo que prohíben
// (lista PERMITIDOS de lib/neutralidad.mjs, con un máximo de apariciones por archivo).
//
// Uso: node tools/release/verificar-neutralidad.mjs   (lo corre el job «Neutralidad» de .github/workflows/ci.yml)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMITIDOS, evaluar } from "./lib/neutralidad.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rutas = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: raiz,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const archivos = [];
for (const ruta of new Set(rutas)) {
  const abs = join(raiz, ruta);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;
  archivos.push({ ruta, contenido: readFileSync(abs) });
}

const infracciones = evaluar(archivos);
if (infracciones.length) {
  console.error(
    `Neutralidad: ${infracciones.length} archivo(s) nombran a la institución o al proceso de compra:`,
  );
  for (const i of infracciones) console.error(`  - ${i.ruta}: ${i.detalle}`);
  console.error(
    "El repositorio es público y neutro: quite el nombre (o, si es una regla que lo prohíbe, agréguela a",
  );
  console.error("PERMITIDOS en tools/release/lib/neutralidad.mjs con su motivo).");
  process.exit(1);
}
console.log(
  `Neutralidad: ${archivos.length} archivos revisados, sin nombres de la institución ni del proceso.`,
);
console.log(`  Permitidos (reglas que lo prohíben): ${PERMITIDOS.map((p) => p.ruta).join(", ")}`);
