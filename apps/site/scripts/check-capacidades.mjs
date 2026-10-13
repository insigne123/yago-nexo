// Valida src/data/capacidades.json y src/data/release.json antes de cada build.
//
// Regla de veracidad: una capacidad solo puede estar "Incluida" (en la versión de release.json) si declara
// evidencia y cada ruta de evidencia existe en el repositorio. Lo demás se entrega con el servicio de
// implementación ("Servicio"). Cambiar un estado a mano sin respaldo rompe el build en vez de publicar algo que no
// existe. La versión ofertada debe ser estable: no se admiten estados ni textos de beta o de futuro.
import { existsSync } from "node:fs";
import { fail, fromRepo, fromSite, readJson } from "./lib.mjs";

const SCRIPT = "check-capacidades.mjs";
const ESTADOS = ["Incluida", "Servicio"];
// Textos de beta o de futuro que no acreditan una capacidad (en nombres y descripciones).
const NO_ESTABLE =
  /en desarrollo|planificad|hoja de ruta|vista previa|qu[eé] sigue|pr[oó]xima versi[oó]n|versi[oó]n futura|\bbeta\b/i;

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
if (release.estado !== "publicada")
  errores.push(
    `release.json: "estado" debe ser "publicada": solo se ofrece una versión estable (actual: ${JSON.stringify(release.estado)})`,
  );
if (/-/.test(release.version ?? ""))
  errores.push(
    `release.json: la versión ${release.version} es preliminar; el sitio solo presenta versiones estables`,
  );

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
  if (c.estado === "Incluida") {
    if (!Array.isArray(c.evidencia) || c.evidencia.length === 0) {
      errores.push(`${where}: "Incluida" exige al menos una ruta de evidencia en el repositorio`);
    }
  }
  for (const campo of ["nombre", "descripcion"]) {
    const m = NO_ESTABLE.exec(c[campo] ?? "");
    if (m) errores.push(`${where}: ${campo} usa «${m[0]}» (lo beta o futuro no acredita una capacidad)`);
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
