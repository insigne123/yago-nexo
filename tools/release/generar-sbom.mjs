// Genera el SBOM CycloneDX 1.6 de una versión de Yago Nexo y el inventario de licencias.
//
// Qué incluye:
//   - los componentes propios del workspace (@nexo/*), con su versión y purl;
//   - los paquetes npm de terceros del lockfile (pnpm licenses list), separados en ejecución (scope required:
//     dependencias de producción de los paquetes de sbom-config.json) y desarrollo (scope excluded);
//   - los componentes de ejecución que no vienen de npm (componentes-plataforma.json).
// Falla si alguna licencia queda sin resolver o si un paquete npm trae copyleft fuerte.
// La versión sale del package.json raíz. También escribe CHECKSUMS.txt de la carpeta; el flujo de versión lo
// rehace al final con tools/release/sumas.mjs, cuando ya están los SBOM por imagen (syft) y las vulnerabilidades.
//
// Uso: node tools/release/generar-sbom.mjs [carpeta de salida]   (por omisión release/<versión>)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aplanarLicenciasPnpm,
  clasificarNpm,
  componenteNpm,
  componentesPlataforma,
  componentesPropios,
  construirBom,
  licenciasDenegadas,
  resumen,
  textoLicencia,
} from "./lib/sbom.mjs";
import { escribirSumas } from "./lib/sumas.mjs";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const leer = (ruta) => JSON.parse(readFileSync(join(raiz, ruta), "utf8"));
const pnpm = (...args) =>
  JSON.parse(execFileSync("pnpm", args, { cwd: raiz, maxBuffer: 128 * 1024 * 1024, encoding: "utf8" }));

const version = leer("package.json").version;
const salida = process.argv[2] ? resolve(process.argv[2]) : join(raiz, "release", version);
const overrides = leer("tools/release/overrides-licencias.json");
const plataforma = leer("tools/release/componentes-plataforma.json").componentes;
const config = leer("tools/release/sbom-config.json");
const paquetesEjecucion = config.ejecucion.map((e) => e.paquete);

// --- workspace: proyectos propios y cuáles se entregan para ejecución ---
const proyectos = pnpm("ls", "-r", "--depth", "-1", "--json").filter((p) => p.name?.startsWith("@nexo/"));
const conocidos = new Set(proyectos.map((p) => p.name));
const faltan = paquetesEjecucion.filter((n) => !conocidos.has(n));
if (faltan.length) {
  console.error(`SBOM: sbom-config.json nombra paquetes que no están en el workspace: ${faltan.join(", ")}`);
  process.exit(1);
}
const filtros = paquetesEjecucion.flatMap((n) => ["--filter", `${n}...`]);
const propiosEjecucion = new Set(pnpm(...filtros, "ls", "--depth", "-1", "--json").map((p) => p.name));
const propios = componentesPropios(
  proyectos
    .map((p) => {
      const pkg = JSON.parse(readFileSync(join(p.path, "package.json"), "utf8"));
      return {
        nombre: p.name,
        version: p.version,
        ruta: relative(raiz, p.path),
        descripcion: pkg.description,
        uso: propiosEjecucion.has(p.name) ? "ejecucion" : "desarrollo",
      };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre)),
);

// --- paquetes npm de terceros: todo el lockfile y la parte de ejecución ---
const todos = aplanarLicenciasPnpm(pnpm("licenses", "list", "--json"), overrides);
const ejecucion = aplanarLicenciasPnpm(pnpm(...filtros, "licenses", "list", "--prod", "--json"), overrides);
const npm = clasificarNpm(todos.paquetes, ejecucion.paquetes);
const problemas = [...new Set([...todos.problemas, ...ejecucion.problemas]), ...licenciasDenegadas(npm)];
if (problemas.length) {
  console.error("SBOM: no se puede generar por problemas de licencias:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}

const bom = construirBom({
  version,
  timestamp: new Date().toISOString(),
  serial: `urn:uuid:${randomUUID()}`,
  propios,
  plataforma: componentesPlataforma(plataforma),
  npm: npm.map(componenteNpm),
});
const r = resumen(bom);

mkdirSync(salida, { recursive: true });
const nombreSbom = `sbom-nexo-${version}.cdx.json`;
writeFileSync(join(salida, nombreSbom), JSON.stringify(bom, null, 2) + "\n");

// --- inventario de licencias legible ---
const porLic = new Map();
for (const c of bom.components) {
  if (c.properties?.some((p) => p.name === "nexo:origen" && p.value === "propio")) continue;
  const l = textoLicencia(c.licenses[0]);
  const fila = porLic.get(l) ?? { ejecucion: 0, desarrollo: 0, laboratorio: 0 };
  const uso = c.properties?.find((p) => p.name === "nexo:uso")?.value ?? "desarrollo";
  fila[uso] += 1;
  porLic.set(l, fila);
}
const terceros = r.total - r.propios;
const md = [
  `# Inventario de licencias · Yago Nexo ${version}`,
  "",
  `Generado el ${new Date().toISOString().slice(0, 10)} a partir del SBOM CycloneDX 1.6 (\`${nombreSbom}\`).`,
  "",
  `- Componentes en el SBOM: **${r.total}**: ${r.propios} propios (@nexo/*) y ${terceros} de terceros.`,
  `- Por uso: **${r.ejecucion}** de ejecución (scope \`required\`), **${r.desarrollo}** de desarrollo y construcción y **${r.laboratorio}** solo de laboratorio (scope \`excluded\`).`,
  `- Licencias distintas entre los componentes de terceros: **${porLic.size}**.`,
  "",
  "Yago Nexo es software propietario de Sociedad de Inversiones Yago SpA (`LicenseRef-Yago-Nexo`), construido",
  "sobre una base de código abierto. Cada componente de terceros conserva su propia licencia. Ningún paquete npm",
  "(de ejecución ni de desarrollo) usa copyleft fuerte; Grafana (AGPL-3.0) se ejecuta como servicio separado y",
  "sin modificaciones.",
  "",
  "| Licencia | Ejecución | Desarrollo | Laboratorio |",
  "| --- | ---: | ---: | ---: |",
  ...[...porLic.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([l, f]) => `| ${l} | ${f.ejecucion} | ${f.desarrollo} | ${f.laboratorio} |`),
  "",
  "## Componentes propios",
  "",
  "| Paquete | Versión | Uso | Ruta |",
  "| --- | --- | --- | --- |",
  ...propios.map(
    (c) =>
      `| ${c.name} | ${c.version} | ${c.scope === "required" ? "ejecución" : "desarrollo"} | ${c.properties.find((p) => p.name === "nexo:ruta").value} |`,
  ),
  "",
  "## Componentes de ejecución que no vienen de npm",
  "",
  "| Componente | Versión | Licencia | Uso | Rol |",
  "| --- | --- | --- | --- | --- |",
  ...plataforma.map(
    (c) =>
      `| ${c.nombre} | ${c.version} | ${c.licencia} | ${c.uso === "laboratorio" ? "laboratorio" : "ejecución"} | ${c.rol} |`,
  ),
  "",
];
writeFileSync(join(salida, "LICENCIAS.md"), md.join("\n"));
escribirSumas(salida);

console.log(`SBOM de Yago Nexo ${version}:`);
console.log(
  `  componentes: ${r.total} (${r.propios} propios; ${r.ejecucion} ejecución, ${r.desarrollo} desarrollo, ${r.laboratorio} laboratorio) · ${porLic.size} licencias`,
);
console.log(`  ${relative(raiz, join(salida, nombreSbom))}`);
console.log(`  ${relative(raiz, join(salida, "LICENCIAS.md"))}`);
console.log(`  ${relative(raiz, join(salida, "CHECKSUMS.txt"))}`);
