// Genera las tablas de roles y permisos de docs/seguridad.md desde la versión COMPILADA de
// @nexo/shared (packages/shared/dist/roles.js), que es la misma matriz que usará la API de la
// Consola para autorizar. Requiere compilar antes: pnpm --filter @nexo/shared build
//
// Salidas (parciales de Docusaurus, no son páginas):
//   docs/_generated/matriz-roles.md         matriz rol-permiso
//   docs/_generated/roles.md                roles y responsabilidades
//   docs/_generated/cuatro-ojos.md          acciones que exigen segregación (quien inicia no aprueba)
//   docs/_generated/severidad-ejemplos.md   ejemplos de la matriz de severidades (severity.js)
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { banner, cell, code, fail, fromRepo, fromSite, table, writeGenerated } from "./lib.mjs";

const SCRIPT = "gen-matrix.mjs";
const DIST = fromRepo("packages/shared/dist/roles.js");
const FUENTE = "packages/shared/dist/roles.js (compilado de packages/shared/src/roles.ts)";

if (!existsSync(DIST)) {
  fail(SCRIPT, `no existe ${DIST}.\n  Compile primero la biblioteca: pnpm --filter @nexo/shared build`);
}

const { ROLES, ROLE_DESCRIPTIONS, PERMISSIONS, FOUR_EYES_ACTIONS, permissionMatrix } = await import(
  pathToFileURL(DIST).href
);

if (!Array.isArray(ROLES) || !Array.isArray(PERMISSIONS) || typeof permissionMatrix !== "function") {
  fail(SCRIPT, `${DIST} no exporta ROLES, PERMISSIONS y permissionMatrix() como se esperaba`);
}

/** Descripción en lenguaje simple de cada permiso (la fuente de verdad es roles.ts). */
const DESCRIPCION = {
  "catalog:read": "Consultar el catálogo de APIs y sus fichas",
  "catalog:write": "Editar los metadatos de gobierno de una API",
  "impact:simulate": "Simular el impacto de un cambio",
  "discovery:read": "Consultar escaneos y hallazgos de descubrimiento",
  "discovery:scan": "Iniciar un escaneo de descubrimiento",
  "discovery:triage": "Clasificar un hallazgo de descubrimiento",
  "anomaly:read": "Consultar reglas, anomalías y bloqueos",
  "anomaly:rules:write": "Crear y modificar reglas de detección de anomalías",
  "anomaly:block:approve": "Aprobar un bloqueo propuesto",
  "anomaly:block:release": "Liberar un bloqueo activo",
  "rollout:read": "Consultar despliegues progresivos",
  "rollout:create": "Crear un despliegue canary o blue-green",
  "rollout:approve": "Aprobar el inicio de un despliegue en producción",
  "rollout:abort": "Detener y revertir un despliegue",
  "continuity:read": "Consultar el estado de los sitios y del quórum",
  "continuity:drill": "Iniciar un simulacro de conmutación",
  "continuity:failback:approve": "Aprobar el retorno al sitio principal",
  "usage:read:all": "Consultar el consumo de todos los consumidores",
  "usage:read:own": "Consultar el consumo propio",
  "dlq:read": "Consultar los mensajes fallidos",
  "dlq:reprocess:approve": "Aprobar el reproceso de un mensaje fallido",
  "audit:read": "Consultar los eventos de auditoría",
  "audit:verify": "Verificar la cadena de hash de la auditoría",
  "compliance:read": "Consultar las matrices de cumplimiento",
  "export:create": "Generar paquetes de exportación",
  "admin:connectors:write": "Configurar los conectores de la plataforma",
  "admin:settings:write": "Cambiar parámetros de la plataforma",
};

const sinDescripcion = PERMISSIONS.filter((p) => !DESCRIPCION[p]);
if (sinDescripcion.length > 0) {
  console.warn(`[${SCRIPT}] aviso: permisos sin descripción en el sitio: ${sinDescripcion.join(", ")}`);
}

const titulo = (rol) => rol.charAt(0).toUpperCase() + rol.slice(1);
const filas = permissionMatrix();

const matriz = table(
  ["Permiso", "Qué permite", ...ROLES.map(titulo)],
  filas.map((fila) => [
    code(fila.permission, { inTable: true }),
    cell(DESCRIPCION[fila.permission] ?? "—"),
    ...ROLES.map((rol) => (fila[rol] ? "✓" : "—")),
  ]),
  ["left", "left", ...ROLES.map(() => "center")],
);

writeGenerated(
  fromSite("docs/_generated/matriz-roles.md"),
  `${banner(SCRIPT, FUENTE)}
${matriz}

✓ = el rol tiene el permiso · — = no lo tiene. ${ROLES.length} roles y ${PERMISSIONS.length} permisos.
`,
);

writeGenerated(
  fromSite("docs/_generated/roles.md"),
  `${banner(SCRIPT, FUENTE)}
${table(
  ["Rol", "Responsabilidad", "Permisos"],
  ROLES.map((rol) => [
    code(rol, { inTable: true }),
    cell(ROLE_DESCRIPTIONS?.[rol] ?? "—"),
    String(filas.filter((f) => f[rol]).length),
  ]),
)}
`,
);

const holders = (accion) => ROLES.filter((rol) => filas.find((f) => f.permission === accion)?.[rol]);
writeGenerated(
  fromSite("docs/_generated/cuatro-ojos.md"),
  `${banner(SCRIPT, FUENTE)}
${table(
  ["Acción", "Qué permite", "Roles que pueden aprobar"],
  [...FOUR_EYES_ACTIONS].map((accion) => [
    code(accion, { inTable: true }),
    cell(DESCRIPCION[accion] ?? "—"),
    holders(accion)
      .map((r) => code(r, { inTable: true }))
      .join(", ") || "—",
  ]),
)}
`,
);

// Ejemplos de la matriz de severidades (packages/shared/dist/severity.js), para Ciclo de vida y soporte.
const DIST_SEVERIDAD = fromRepo("packages/shared/dist/severity.js");
if (!existsSync(DIST_SEVERIDAD))
  fail(SCRIPT, `no existe ${DIST_SEVERIDAD}. Compile: pnpm --filter @nexo/shared build`);
const { SEVERITY_EXAMPLES } = await import(pathToFileURL(DIST_SEVERIDAD).href);
if (!SEVERITY_EXAMPLES || typeof SEVERITY_EXAMPLES !== "object")
  fail(SCRIPT, "severity.js no exporta SEVERITY_EXAMPLES");
writeGenerated(
  fromSite("docs/_generated/severidad-ejemplos.md"),
  `${banner(SCRIPT, "packages/shared/dist/severity.js (compilado de packages/shared/src/severity.ts)")}
${table(
  ["Severidad", "Ejemplos"],
  Object.entries(SEVERITY_EXAMPLES).map(([sev, ejemplos]) => [
    `**${cell(sev)}**`,
    ejemplos.map((e) => cell(e)).join("<br />"),
  ]),
)}
`,
);

console.log(
  `[${SCRIPT}] matriz rol-permiso: ${ROLES.length} roles, ${PERMISSIONS.length} permisos, ` +
    `${FOUR_EYES_ACTIONS.length} acciones de cuatro ojos; ejemplos de ${Object.keys(SEVERITY_EXAMPLES).length} severidades`,
);
