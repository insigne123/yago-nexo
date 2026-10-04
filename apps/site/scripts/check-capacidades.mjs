// Valida src/data/capacidades.json y src/data/release.json antes de cada build.
//
// Regla de veracidad: una capacidad solo puede estar "Disponible" si declara evidencia y cada
// ruta de evidencia existe en el repositorio. Así, cambiar un estado a mano sin respaldo
// rompe el build en vez de publicar algo que no existe.
import { existsSync } from "node:fs";
import { fail, fromRepo, fromSite, readJson } from "./lib.mjs";

const SCRIPT = "check-capacidades.mjs";
const ESTADOS = ["Disponible", "En desarrollo", "Planificado"];

const data = readJson(fromSite("src/data/capacidades.json"));
const release = readJson(fromSite("src/data/release.json"));
const errores = [];

// release.json
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version ?? ""))
  errores.push(`release.json: "version" debe ser semver (actual: ${JSON.stringify(release.version)})`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(release.fecha ?? "") || Number.isNaN(Date.parse(release.fecha)))
  errores.push(
    `release.json: "fecha" debe tener formato AAAA-MM-DD (actual: ${JSON.stringify(release.fecha)})`,
  );
if (typeof release.estado !== "string" || release.estado.trim() === "")
  errores.push('release.json: "estado" es obligatorio (por ejemplo "preliminar")');

// capacidades.json
const grupos = new Set();
for (const g of data.grupos ?? []) {
  if (!g.id || !g.nombre) errores.push(`grupo sin id o nombre: ${JSON.stringify(g)}`);
  if (grupos.has(g.id)) errores.push(`grupo duplicado: ${g.id}`);
  grupos.add(g.id);
}

const ids = new Set();
for (const c of data.capacidades ?? []) {
  const where = `capacidad "${c.id ?? "(sin id)"}"`;
  if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) errores.push(`${where}: id obligatorio en minúsculas y guiones`);
  if (ids.has(c.id)) errores.push(`${where}: id duplicado`);
  ids.add(c.id);
  if (!grupos.has(c.grupo)) errores.push(`${where}: grupo desconocido "${c.grupo}"`);
  if (!c.nombre || !c.descripcion) errores.push(`${where}: nombre y descripcion son obligatorios`);
  if (!ESTADOS.includes(c.estado))
    errores.push(`${where}: estado "${c.estado}" no es uno de ${ESTADOS.join(", ")}`);
  if (c.evidencia !== undefined && !Array.isArray(c.evidencia))
    errores.push(`${where}: evidencia debe ser una lista`);
  if (c.estado === "Disponible") {
    if (!Array.isArray(c.evidencia) || c.evidencia.length === 0) {
      errores.push(`${where}: "Disponible" exige al menos una ruta de evidencia en el repositorio`);
    }
  }
  for (const ruta of c.evidencia ?? []) {
    if (!existsSync(fromRepo(ruta)))
      errores.push(`${where}: la evidencia "${ruta}" no existe en el repositorio`);
  }
}

if ((data.capacidades ?? []).length === 0) errores.push("capacidades.json no tiene capacidades");
if (errores.length > 0) fail(SCRIPT, `\n  - ${errores.join("\n  - ")}`);

const conteo = Object.fromEntries(
  ESTADOS.map((e) => [e, data.capacidades.filter((c) => c.estado === e).length]),
);
console.log(
  `[${SCRIPT}] versión ${release.version} (${release.estado}); ${data.capacidades.length} capacidades:`,
  ESTADOS.map((e) => `${e} ${conteo[e]}`).join(" · "),
);
