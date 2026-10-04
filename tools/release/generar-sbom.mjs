// Genera el SBOM CycloneDX de una versión de Yago Nexo, el inventario de licencias y los checksums.
// Fuentes: los paquetes npm del monorepo (pnpm licenses list) y los componentes de ejecución fijados en
// deploy/compose (tools/release/componentes-plataforma.json). Falla si alguna licencia queda sin resolver
// o si aparece una licencia de copyleft fuerte dentro del código propio (npm), que no debe redistribuirse así.
//
// Uso: node tools/release/generar-sbom.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const release = JSON.parse(readFileSync(join(raiz, "apps/site/src/data/release.json"), "utf8"));
const version = release.version;
const salida = join(raiz, "release", version);
const overrides = JSON.parse(readFileSync(join(raiz, "tools/release/overrides-licencias.json"), "utf8"));
const plataforma = JSON.parse(readFileSync(join(raiz, "tools/release/componentes-plataforma.json"), "utf8")).componentes;

// Copyleft fuerte: no puede venir incrustado en nuestro código (npm). En contenedores separados se permite
// y se marca (p. ej. Grafana AGPL, que se ejecuta sin modificar).
const DENEGADAS_EN_CODIGO = /\b(GPL-[23]|AGPL|LGPL|SSPL|BUSL|CC-BY-NC)/i;

function spdx(lic) {
  // Normaliza una expresión SPDX simple; deja las compuestas tal cual entre paréntesis.
  return lic.replace(/^\(|\)$/g, "");
}

// --- paquetes npm de todo el workspace ---
const crudo = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], { cwd: raiz, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }));
const npm = [];
const problemas = [];
for (const [licencia, paquetes] of Object.entries(crudo)) {
  for (const p of paquetes) {
    let lic = licencia;
    if (lic === "Unknown") {
      const o = overrides[p.name];
      if (!o) {
        problemas.push(`Licencia desconocida sin resolver: ${p.name} (agréguela a overrides-licencias.json con su licencia verificada)`);
        continue;
      }
      lic = o.licencia;
    }
    if (DENEGADAS_EN_CODIGO.test(lic)) problemas.push(`Licencia no permitida en código propio: ${p.name} → ${lic}`);
    const versiones = Array.isArray(p.versions) ? p.versions : [p.version].filter(Boolean);
    for (const v of versiones.length ? versiones : ["0.0.0"]) {
      npm.push({
        type: "library",
        name: p.name,
        version: String(v),
        purl: `pkg:npm/${p.name}@${v}`,
        licenses: [{ license: spdx(lic).includes(" OR ") || spdx(lic).includes(" AND ") ? { name: lic } : { id: spdx(lic) } }],
        ...(p.homepage ? { externalReferences: [{ type: "website", url: p.homepage }] } : {}),
      });
    }
  }
}
if (problemas.length) {
  console.error("SBOM: no se puede generar por problemas de licencias:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}

// --- componentes de ejecución (contenedores y bibliotecas Java) ---
const infra = plataforma.map((c) => ({
  type: "application",
  name: c.nombre,
  version: c.version,
  ...(c.purl ? { purl: c.purl } : {}),
  licenses: [{ license: c.licencia.includes(" ") ? { name: c.licencia } : { id: c.licencia } }],
  externalReferences: [{ type: "website", url: c.url }],
  properties: [{ name: "nexo:rol", value: c.rol }],
}));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "Yago Nexo", version, description: "Plataforma de gestión de APIs e integración de Yago, construida sobre WSO2 (base abierta)." },
    supplier: { name: "Sociedad de Inversiones Yago SpA" },
    licenses: [{ license: { name: "Propietaria (Yago); componentes de terceros bajo sus propias licencias" } }],
    tools: [{ name: "generar-sbom.mjs", vendor: "Yago Nexo" }],
  },
  components: [...infra, ...npm].sort((a, b) => a.name.localeCompare(b.name)),
};

mkdirSync(salida, { recursive: true });
const sbomPath = join(salida, `sbom-nexo-${version}.cdx.json`);
writeFileSync(sbomPath, JSON.stringify(bom, null, 2) + "\n");

// --- inventario de licencias legible ---
const porLic = new Map();
for (const c of bom.components) {
  const l = c.licenses[0].license.id ?? c.licenses[0].license.name;
  (porLic.get(l) ?? porLic.set(l, []).get(l)).push(c);
}
const md = [
  `# Inventario de licencias · Yago Nexo ${version}`,
  "",
  `Generado el ${new Date().toISOString().slice(0, 10)} a partir del SBOM CycloneDX (\`${`sbom-nexo-${version}.cdx.json`}\`).`,
  `Total de componentes de terceros: **${bom.components.length}** (${infra.length} de ejecución + ${npm.length} de npm), en **${porLic.size}** licencias distintas.`,
  "",
  "Yago Nexo es software propietario de Sociedad de Inversiones Yago SpA, construido sobre una base de código",
  "abierto. Cada componente de terceros conserva su propia licencia. Ningún componente incrustado en el código",
  "propio usa copyleft fuerte; Grafana (AGPL‑3.0) se ejecuta como servicio separado y sin modificaciones.",
  "",
  "| Licencia | Componentes |",
  "| --- | --- |",
  ...[...porLic.entries()].sort().map(([l, cs]) => `| ${l} | ${cs.length} |`),
  "",
  "## Componentes de ejecución",
  "",
  "| Componente | Versión | Licencia | Rol |",
  "| --- | --- | --- | --- |",
  ...plataforma.map((c) => `| ${c.nombre} | ${c.version} | ${c.licencia} | ${c.rol} |`),
  "",
];
writeFileSync(join(salida, "LICENCIAS.md"), md.join("\n"));

// --- checksums de los artefactos de la versión ---
const archivos = readdirSync(salida).filter((f) => f !== "CHECKSUMS.txt" && statSync(join(salida, f)).isFile());
const sumas = archivos.sort().map((f) => `${createHash("sha256").update(readFileSync(join(salida, f))).digest("hex")}  ${f}`);
writeFileSync(join(salida, "CHECKSUMS.txt"), sumas.join("\n") + "\n");

console.log(`SBOM de Yago Nexo ${version}:`);
console.log(`  componentes: ${bom.components.length} (${infra.length} ejecución + ${npm.length} npm) · ${porLic.size} licencias`);
console.log(`  ${sbomPath.replace(raiz + "/", "")}`);
console.log(`  ${join(salida, "LICENCIAS.md").replace(raiz + "/", "")}`);
console.log(`  ${join(salida, "CHECKSUMS.txt").replace(raiz + "/", "")}`);
