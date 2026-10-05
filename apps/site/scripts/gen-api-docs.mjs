// Genera la referencia de la API de la Consola Nexo desde apps/console-api/openapi.yaml.
//
// Salidas:
//   docs/referencia-api/<etiqueta>.md   una página por etiqueta (operaciones, parámetros, cuerpos y respuestas)
//   docs/referencia-api/esquemas.md     esquemas de components.schemas con sus campos
//   docs/_generated/api-indice.md       índice de secciones (lo incluye docs/api-consola.md)
//   static/openapi.yaml                 copia descargable del contrato
//
// El contrato fuente contiene referencias internas de trazabilidad (códigos de requisitos y el
// nombre de un cliente). El sitio es público, así que el texto se sanea con reglas explícitas y,
// si después del saneamiento queda algo no publicable, el script falla en vez de publicarlo.
import { readFileSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  assertPublic,
  banner,
  cell,
  code,
  fail,
  fromRepo,
  fromSite,
  mdText,
  readJson,
  table,
  writeGenerated,
} from "./lib.mjs";

const SCRIPT = "gen-api-docs.mjs";
const FUENTE = "apps/console-api/openapi.yaml";
const DIR_SALIDA = fromSite("docs/referencia-api");
const URL_BASE = "/docs/referencia-api";

// ------------------------------------------------------------------ saneamiento del texto público

const CODIGO = String.raw`(?:BT|D)-\d{2,3}`;
const LISTA_CODIGOS = String.raw`${CODIGO}(?:\s*(?:,|y)\s*${CODIGO})*`;
const SOLO_CODIGOS = new RegExp(String.raw`^\s*${LISTA_CODIGOS}\s*$`);
const REEMPLAZOS = [
  // Proveedores de identidad de un despliegue concreto → descripción genérica.
  [
    /\(\s*Keycloak de la institución,\s*Supabase Auth en la demo\s*\)/g,
    "(emitido por el Keycloak de la institución)",
  ],
  // Códigos de requisitos entre paréntesis: "(BT-024)", "(BT-031 y BT-032)".
  [new RegExp(String.raw`\s*\(\s*${LISTA_CODIGOS}\s*\)`, "g"), ""],
];
const limpiar = (texto) => REEMPLAZOS.reduce((acc, [re, reemplazo]) => acc.replace(re, reemplazo), texto);

const raw = readFileSync(fromRepo(FUENTE), "utf8");
const doc = YAML.parseDocument(raw);
if (doc.errors.length > 0) fail(SCRIPT, `${FUENTE} no es YAML válido: ${doc.errors[0].message}`);

YAML.visit(doc, {
  Pair(_, pair) {
    // Descripciones que solo contienen códigos internos (por ejemplo, en las etiquetas) se omiten.
    if (
      YAML.isScalar(pair.key) &&
      pair.key.value === "description" &&
      YAML.isScalar(pair.value) &&
      typeof pair.value.value === "string" &&
      SOLO_CODIGOS.test(pair.value.value)
    ) {
      return YAML.visit.REMOVE;
    }
    return undefined;
  },
  Scalar(key, node) {
    if (key !== "key" && typeof node.value === "string") node.value = limpiar(node.value);
  },
});

const spec = doc.toJS();
if (!spec?.openapi || !spec.paths) fail(SCRIPT, `${FUENTE} no parece un contrato OpenAPI`);

// Copia descargable: se sanea el texto crudo para conservar el formato original del archivo y se
// comprueba que su contenido sea idéntico al del documento saneado nodo a nodo.
const encabezado =
  `# Yago Nexo · API de la Consola Nexo · contrato OpenAPI ${spec.info?.version ?? ""}\n` +
  `# Copia pública de ${FUENTE}, generada por apps/site/scripts/${SCRIPT}.\n` +
  "# Se omiten referencias internas de trazabilidad; las rutas y los esquemas son los del contrato.\n";
const crudoSaneado = limpiar(raw)
  .replace(new RegExp(String.raw`,\s*description:\s*${LISTA_CODIGOS}\s*(?=\})`, "g"), " ")
  .replace(new RegExp(String.raw`^[ \t]*description:\s*${LISTA_CODIGOS}[ \t]*\r?\n`, "gm"), "");
let yamlPublico;
if (isDeepStrictEqual(YAML.parse(crudoSaneado), spec)) {
  yamlPublico = encabezado + crudoSaneado;
} else {
  console.warn(`[${SCRIPT}] aviso: el saneamiento textual difiere del estructural; se reescribe el YAML`);
  yamlPublico = encabezado + doc.toString({ lineWidth: 0 });
}

// ------------------------------------------------------------------ utilidades del contrato

const METODOS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];
const UBICACION = { path: "ruta", query: "consulta", header: "encabezado", cookie: "cookie" };

function resolver(ref) {
  if (!ref.startsWith("#/")) fail(SCRIPT, `referencia externa no soportada: ${ref}`);
  let actual = spec;
  for (const parte of ref.slice(2).split("/")) {
    actual = actual?.[parte.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (actual === undefined) fail(SCRIPT, `referencia no encontrada en el contrato: ${ref}`);
  return actual;
}
const nombreRef = (ref) => ref.split("/").pop();
const deref = (obj) => (obj?.$ref ? resolver(obj.$ref) : obj);

const esquemas = spec.components?.schemas ?? {};
const anclaEsquema = (nombre) => `esquema-${nombre.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
{
  const vistas = new Map();
  for (const nombre of Object.keys(esquemas)) {
    const ancla = anclaEsquema(nombre);
    if (vistas.has(ancla))
      fail(SCRIPT, `los esquemas ${vistas.get(ancla)} y ${nombre} producen la misma ancla`);
    vistas.set(ancla, nombre);
  }
}
const enlaceEsquema = (nombre) => `[${nombre}](${URL_BASE}/esquemas#${anclaEsquema(nombre)})`;

function valor(v) {
  return code(typeof v === "string" ? v : JSON.stringify(v), { inTable: true });
}

/** Tipo corto y legible de un esquema (con enlace si es una referencia). */
function tipo(schema) {
  if (!schema) return "—";
  if (schema.$ref) return enlaceEsquema(nombreRef(schema.$ref));
  if (schema.allOf) return schema.allOf.map(tipo).join(" + ");
  if (schema.oneOf) return schema.oneOf.map(tipo).join(" o ");
  if (schema.anyOf) return schema.anyOf.map(tipo).join(" o ");
  if (schema.type === "array") {
    const items = schema.items ?? {};
    if (!items.$ref && (items.type === "object" || items.properties)) return "arreglo de objetos";
    return `arreglo de ${tipo(items)}`;
  }
  if (schema.type === "object" || schema.properties) {
    if (!schema.properties && schema.additionalProperties) return "objeto (campos libres)";
    return "objeto";
  }
  const base = Array.isArray(schema.type) ? schema.type.join(" o ") : (schema.type ?? "cualquiera");
  return code(schema.format ? `${base} (${schema.format})` : base, { inTable: true });
}

/** Restricciones y notas de un esquema, en una línea. */
function detalle(schema, descripcion) {
  const partes = [];
  const texto = descripcion ?? schema?.description;
  if (texto) partes.push(cell(texto));
  if (!schema || schema.$ref) return partes.join(". ") || "";
  if (schema.enum) partes.push(`valores: ${schema.enum.map(valor).join(", ")}`);
  if (schema.default !== undefined) partes.push(`por omisión ${valor(schema.default)}`);
  if (schema.minimum !== undefined && schema.maximum !== undefined)
    partes.push(`entre ${schema.minimum} y ${schema.maximum}`);
  else if (schema.minimum !== undefined) partes.push(`mínimo ${schema.minimum}`);
  else if (schema.maximum !== undefined) partes.push(`máximo ${schema.maximum}`);
  if (schema.minLength !== undefined) partes.push(`mínimo ${schema.minLength} caracteres`);
  if (schema.maxLength !== undefined) partes.push(`máximo ${schema.maxLength} caracteres`);
  if (schema.examples) partes.push(`ejemplos: ${schema.examples.map(valor).join(", ")}`);
  if (schema.type === "array" && schema.items?.enum)
    partes.push(`valores: ${schema.items.enum.map(valor).join(", ")}`);
  return partes.join("; ");
}

/** Filas de campos de un objeto, aplanando objetos en línea (a.b, a[].b). */
function filasCampos(schema, prefijo = "", profundidad = 0) {
  const filas = [];
  const requeridos = new Set(schema?.required ?? []);
  for (const [nombre, prop] of Object.entries(schema?.properties ?? {})) {
    const ruta = prefijo ? `${prefijo}.${nombre}` : nombre;
    filas.push([
      code(ruta, { inTable: true }),
      tipo(prop),
      requeridos.has(nombre) ? "Sí" : "No",
      detalle(prop) || " ",
    ]);
    if (profundidad >= 3 || prop.$ref) continue;
    if (prop.type === "object" || prop.properties) {
      filas.push(...filasCampos(prop, ruta, profundidad + 1));
    } else if (
      prop.type === "array" &&
      prop.items &&
      !prop.items.$ref &&
      (prop.items.type === "object" || prop.items.properties)
    ) {
      filas.push(...filasCampos(prop.items, `${ruta}[]`, profundidad + 1));
    }
  }
  return filas;
}

function tablaCampos(schema) {
  const filas = filasCampos(schema);
  if (filas.length === 0)
    return schema?.additionalProperties ? "Objeto con campos libres." : "Objeto sin campos declarados.";
  return table(["Campo", "Tipo", "Obligatorio", "Detalle"], filas);
}

/** Referencias directas a esquemas dentro de un esquema en línea. */
function refsDe(schema, acc = new Set()) {
  if (!schema || typeof schema !== "object") return acc;
  if (schema.$ref) {
    acc.add(nombreRef(schema.$ref));
    return acc;
  }
  for (const v of Object.values(schema)) {
    if (Array.isArray(v)) v.forEach((x) => refsDe(x, acc));
    else if (v && typeof v === "object") refsDe(v, acc);
  }
  return acc;
}

// ------------------------------------------------------------------ operaciones por etiqueta

const NOMBRE_ETIQUETA = {
  sesion: "Sesión",
  inicio: "Inicio",
  catalogo: "Catálogo",
  impacto: "Dependencias e impacto",
  descubrimiento: "Descubrimiento",
  anomalias: "Anomalías",
  despliegues: "Despliegues",
  continuidad: "Continuidad",
  consumo: "Consumo",
  "mensajes-fallidos": "Mensajes fallidos",
  auditoria: "Auditoría",
  cumplimiento: "Cumplimiento",
  exportacion: "Exportación",
};
const RESUMEN_ETIQUETA = {
  sesion: "Usuario actual, roles y permisos efectivos.",
  inicio: "Resumen de la plataforma: sitios, APIs, alertas, consumo y despliegues.",
  catalogo: "Catálogo de APIs, fichas, metadatos de gobierno y sincronización con API Manager.",
  impacto: "Grafo de dependencias y simulación del impacto de un cambio.",
  descubrimiento: "Escaneos, hallazgos de APIs no gobernadas y reporte de exposición.",
  anomalias: "Reglas de detección, eventos de anomalía y bloqueos en el gateway.",
  despliegues: "Despliegues canary y blue-green: creación, aprobación, estado y reversa.",
  continuidad: "Estado de los sitios y del quórum, modo de operación, simulacros y retorno.",
  consumo: "Consumo atribuido por consumidor, API, endpoint o día, y su exportación.",
  "mensajes-fallidos": "Mensajes no procesados y reproceso autorizado.",
  auditoria: "Eventos de auditoría y verificación de la cadena de hash.",
  cumplimiento: "Matriz rol-permiso vigente y matriz de canales TLS.",
  exportacion: "Paquetes exportados con su manifiesto de contenido.",
};
const nombreEtiqueta = (t) => NOMBRE_ETIQUETA[t] ?? t.charAt(0).toUpperCase() + t.slice(1).replace(/-/g, " ");

const operaciones = [];
for (const [ruta, item] of Object.entries(spec.paths)) {
  const comunes = item.parameters ?? [];
  for (const metodo of METODOS) {
    const op = item[metodo];
    if (!op) continue;
    const ancla = `${metodo}-${ruta}`
      .toLowerCase()
      .replace(/[{}]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    operaciones.push({
      ruta,
      metodo,
      op,
      ancla,
      etiqueta: op.tags?.[0] ?? "otros",
      parametros: [...comunes, ...(op.parameters ?? [])],
    });
  }
}
{
  const anclas = new Set();
  for (const o of operaciones) {
    if (anclas.has(o.ancla)) fail(SCRIPT, `ancla duplicada para ${o.metodo.toUpperCase()} ${o.ruta}`);
    anclas.add(o.ancla);
  }
}

const etiquetas = [...(spec.tags ?? []).map((t) => t.name)];
for (const o of operaciones) if (!etiquetas.includes(o.etiqueta)) etiquetas.push(o.etiqueta);
const etiquetasConOperaciones = etiquetas.filter((t) => operaciones.some((o) => o.etiqueta === t));

const usoEsquema = new Map(); // esquema → [{texto, enlace}]
function registrarUso(nombre, o) {
  const lista = usoEsquema.get(nombre) ?? [];
  if (!lista.some((u) => u.ancla === o.ancla))
    lista.push({ ancla: o.ancla, etiqueta: o.etiqueta, texto: `${o.metodo.toUpperCase()} ${o.ruta}` });
  usoEsquema.set(nombre, lista);
}

const consola = readJson(fromSite("src/data/capacidades.json")).capacidades.find((c) => c.id === "consola");
if (!consola) fail(SCRIPT, 'capacidades.json no tiene la capacidad "consola"');
const avisoEstado =
  consola.estado === "Disponible"
    ? `:::info Implementación\n\nLa API de la Consola está en estado <EstadoCapacidad id="consola" />. Esta referencia se genera desde su contrato OpenAPI ${mdText(spec.info?.version ?? "")}.\n\n:::`
    : `:::note Contrato de diseño\n\nLa API de la Consola está en estado <EstadoCapacidad id="consola" />. Esta referencia se genera desde su contrato OpenAPI ${mdText(spec.info?.version ?? "")} y describe la interfaz prevista; puede cambiar mientras se implementa.\n\n:::`;

function renderOperacion(o) {
  const { op } = o;
  const partes = [`## ${code(o.metodo.toUpperCase())} ${code(o.ruta)} {#${o.ancla}}`, ""];
  if (op.summary) partes.push(mdText(op.summary), "");
  if (op.description) partes.push(mdText(op.description), "");
  if (op.deprecated) partes.push("**Obsoleta.** Se mantiene por compatibilidad.", "");

  if (o.parametros.length > 0) {
    const filas = o.parametros.map((p0) => {
      const p = deref(p0);
      refsDe(p.schema).forEach((n) => registrarUso(n, o));
      return [
        code(p.name, { inTable: true }),
        UBICACION[p.in] ?? cell(p.in),
        tipo(p.schema),
        p.required || p.in === "path" ? "Sí" : "No",
        detalle(p.schema, p.description) || " ",
      ];
    });
    partes.push(
      "**Parámetros**",
      "",
      table(["Nombre", "Ubicación", "Tipo", "Obligatorio", "Detalle"], filas),
      "",
    );
  }

  if (op.requestBody) {
    const rb = deref(op.requestBody);
    partes.push(`**Cuerpo de la solicitud** (${rb.required ? "obligatorio" : "opcional"})`, "");
    for (const [media, contenido] of Object.entries(rb.content ?? {})) {
      const schema = contenido.schema;
      refsDe(schema).forEach((n) => registrarUso(n, o));
      if (schema && !schema.$ref && (schema.type === "object" || schema.properties)) {
        partes.push(`${code(media)}: objeto con estos campos:`, "", tablaCampos(schema), "");
      } else {
        partes.push(`${code(media)}: ${tipo(schema)}`, "");
      }
    }
  }

  const respuestas = Object.entries(op.responses ?? {});
  if (respuestas.length > 0) {
    const filas = respuestas.map(([codigo, r0]) => {
      const r = deref(r0);
      const contenido = Object.entries(r.content ?? {}).map(([media, c]) => {
        refsDe(c.schema).forEach((n) => registrarUso(n, o));
        return `${code(media, { inTable: true })}: ${tipo(c.schema)}`;
      });
      return [code(codigo, { inTable: true }), cell(r.description ?? "—"), contenido.join("<br />") || "—"];
    });
    partes.push("**Respuestas**", "", table(["Código", "Descripción", "Contenido"], filas), "");
  }
  return partes.join("\n");
}

const autenticacion = Object.keys(spec.components?.securitySchemes ?? {}).length
  ? "Todas las operaciones exigen `Authorization: Bearer <JWT>`. La autorización de cada acción se basa en la [matriz rol-permiso](/docs/seguridad#matriz-rol-permiso)."
  : "";
const rutaBase = spec.servers?.[0]?.url ? `Ruta base: ${code(spec.servers[0].url)}.` : "";

rmSync(DIR_SALIDA, { recursive: true, force: true });
const generados = [];

etiquetasConOperaciones.forEach((etiqueta, i) => {
  const ops = operaciones.filter((o) => o.etiqueta === etiqueta);
  const titulo = nombreEtiqueta(etiqueta);
  const cuerpo = ops.map(renderOperacion).join("\n");
  const resumen = table(
    ["Método", "Ruta", "Resumen"],
    ops.map((o) => [
      code(o.metodo.toUpperCase(), { inTable: true }),
      `[${code(o.ruta, { inTable: true })}](#${o.ancla})`,
      cell(o.op.summary ?? "—"),
    ]),
  );
  const usados = [
    ...new Set(
      ops.flatMap((o) =>
        [...usoEsquema.entries()].filter(([, u]) => u.some((x) => x.ancla === o.ancla)).map(([n]) => n),
      ),
    ),
  ];
  const contenido = `---
title: ${JSON.stringify(titulo)}
sidebar_label: ${JSON.stringify(titulo)}
sidebar_position: ${i + 1}
description: ${JSON.stringify(`Referencia de la API de la Consola Nexo: ${titulo}.`)}
custom_edit_url: null
---

${banner(SCRIPT, FUENTE)}
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

${avisoEstado}

${mdText(RESUMEN_ETIQUETA[etiqueta] ?? "")} ${rutaBase} ${autenticacion}

${resumen}

${cuerpo}
${usados.length > 0 ? `## Esquemas de esta sección {#esquemas-de-esta-seccion}\n\n${usados.sort().map(enlaceEsquema).join(" · ")}\n` : ""}`;
  generados.push({ ruta: `${DIR_SALIDA}/${etiqueta}.md`, contenido });
});

// ------------------------------------------------------------------ esquemas

const usoEntreEsquemas = new Map();
for (const [nombre, schema] of Object.entries(esquemas)) {
  for (const ref of refsDe(schema)) {
    if (ref === nombre) continue;
    usoEntreEsquemas.set(ref, [...(usoEntreEsquemas.get(ref) ?? []), nombre]);
  }
}

function renderEsquema(nombre, schema) {
  const partes = [`## ${nombre} {#${anclaEsquema(nombre)}}`, ""];
  if (schema.description) partes.push(mdText(schema.description), "");
  if (schema.allOf) {
    const refs = schema.allOf.filter((s) => s.$ref).map((s) => enlaceEsquema(nombreRef(s.$ref)));
    const enLinea = schema.allOf.filter((s) => !s.$ref);
    partes.push(`Incluye todos los campos de ${refs.join(" y ")}${enLinea.length ? " y además:" : "."}`, "");
    for (const parte of enLinea) partes.push(tablaCampos(parte), "");
  } else if (schema.enum) {
    partes.push(
      `${tipo({ type: schema.type ?? "string" })} con uno de estos valores: ${schema.enum.map((v) => code(v)).join(", ")}.`,
      "",
    );
  } else if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    partes.push(tablaCampos(schema), "");
  } else {
    partes.push(`Tipo: ${tipo(schema)}. ${detalle(schema)}`, "");
  }
  const usos = usoEsquema.get(nombre) ?? [];
  const padres = usoEntreEsquemas.get(nombre) ?? [];
  const lineas = [];
  if (usos.length)
    lineas.push(
      `Operaciones: ${usos.map((u) => `[${code(u.texto)}](${URL_BASE}/${u.etiqueta}#${u.ancla})`).join(", ")}.`,
    );
  if (padres.length) lineas.push(`Esquemas: ${[...new Set(padres)].map(enlaceEsquema).join(", ")}.`);
  if (lineas.length) partes.push(`**Se usa en.** ${lineas.join(" ")}`, "");
  return partes.join("\n");
}

generados.push({
  ruta: `${DIR_SALIDA}/esquemas.md`,
  contenido: `---
title: "Esquemas"
sidebar_label: "Esquemas"
sidebar_position: ${etiquetasConOperaciones.length + 1}
description: "Esquemas de datos de la API de la Consola Nexo."
custom_edit_url: null
---

${banner(SCRIPT, FUENTE)}
import EstadoCapacidad from '@site/src/components/EstadoCapacidad';

${avisoEstado}

Esquemas definidos en ${code("components.schemas")} del contrato (${Object.keys(esquemas).length} en total). Los campos de objetos anidados se muestran con su ruta (${code("a.b")}; ${code("a[].b")} para elementos de un arreglo).

${Object.entries(esquemas)
  .map(([n, s]) => renderEsquema(n, s))
  .join("\n")}`,
});

// ------------------------------------------------------------------ índice (parcial)

generados.push({
  ruta: fromSite("docs/_generated/api-indice.md"),
  contenido: `${banner(SCRIPT, FUENTE)}
${table(
  ["Sección", "Operaciones", "Qué cubre"],
  [
    ...etiquetasConOperaciones.map((t) => [
      `[${cell(nombreEtiqueta(t))}](${URL_BASE}/${t})`,
      String(operaciones.filter((o) => o.etiqueta === t).length),
      cell(
        RESUMEN_ETIQUETA[t] ??
          operaciones
            .filter((o) => o.etiqueta === t)
            .map((o) => o.op.summary)
            .join("; "),
      ),
    ]),
    [
      `[Esquemas](${URL_BASE}/esquemas)`,
      "—",
      `${Object.keys(esquemas).length} esquemas de datos con sus campos.`,
    ],
  ],
)}

Contrato OpenAPI ${code(spec.openapi)}, versión ${code(spec.info?.version ?? "—")}: ${operaciones.length} operaciones en ${etiquetasConOperaciones.length} secciones.
`,
});

// ------------------------------------------------------------------ escritura con control de contenido

assertPublic("static/openapi.yaml", yamlPublico);
for (const g of generados) assertPublic(g.ruta, g.contenido);

writeGenerated(fromSite("static/openapi.yaml"), yamlPublico);
for (const g of generados) writeGenerated(g.ruta, g.contenido);

console.log(
  `[${SCRIPT}] ${operaciones.length} operaciones en ${etiquetasConOperaciones.length} secciones, ` +
    `${Object.keys(esquemas).length} esquemas; copia pública en static/openapi.yaml`,
);
