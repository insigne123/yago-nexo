// Piezas puras de la tabla de vulnerabilidades y del documento OpenVEX de cada versión (sin E/S).
// Entrada: los JSON de grype de cada imagen. Las usa tools/release/vulnerabilidades.mjs y las prueba
// tools/release/test/vulnerabilidades.test.mjs.

export const SEVERIDADES = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"];
const NOMBRE_SEVERIDAD = {
  Critical: "Crítica",
  High: "Alta",
  Medium: "Media",
  Low: "Baja",
  Negligible: "Insignificante",
  Unknown: "Desconocida",
};
const rango = (s) => {
  const i = SEVERIDADES.indexOf(s);
  return i === -1 ? SEVERIDADES.length : i;
};

/** Estados y justificaciones válidos de OpenVEX 0.2.0. */
export const ESTADOS_VEX = ["not_affected", "affected", "fixed", "under_investigation"];
export const JUSTIFICACIONES_VEX = [
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
];

/**
 * purl de una imagen a partir de su referencia (registro/ruta:etiqueta o @digest).
 * Docker Hub no lleva repository_url; las imágenes oficiales sin namespace van en «library».
 */
export function purlImagen(ref) {
  let resto = ref;
  let digest;
  const arroba = resto.indexOf("@");
  if (arroba !== -1) {
    digest = resto.slice(arroba + 1);
    resto = resto.slice(0, arroba);
  }
  let etiqueta;
  const dosPuntos = resto.lastIndexOf(":");
  if (dosPuntos > resto.lastIndexOf("/")) {
    etiqueta = resto.slice(dosPuntos + 1);
    resto = resto.slice(0, dosPuntos);
  }
  const partes = resto.split("/");
  let registro;
  if (
    partes.length > 1 &&
    (partes[0].includes(".") || partes[0].includes(":") || partes[0] === "localhost")
  ) {
    registro = partes.shift();
  }
  if (registro === "docker.io" || registro === "index.docker.io") registro = undefined;
  if (!registro && partes.length === 1) partes.unshift("library");
  const version = digest ? encodeURIComponent(digest) : (etiqueta ?? "latest");
  return `pkg:docker/${partes.join("/")}@${version}${registro ? `?repository_url=${encodeURIComponent(registro).replace(/%2F/g, "/")}` : ""}`;
}

/** CVE asociados a un hallazgo (el id principal si es CVE y los relacionados). */
function aliasDe(m) {
  const ids = new Set();
  for (const r of m.relatedVulnerabilities ?? []) if (r.id && r.id !== m.vulnerability.id) ids.add(r.id);
  return [...ids].sort();
}

/**
 * Filas de la tabla a partir de los resultados de grype de cada imagen.
 * Recibe [{imagen, tipo: "propia" | "tercero", grype}] y devuelve una fila por imagen + paquete + versión +
 * vulnerabilidad (las ubicaciones repetidas del mismo paquete se cuentan, no se repiten).
 */
export function filasDesdeGrype(entradas) {
  const filas = new Map();
  for (const { imagen, tipo, grype } of entradas) {
    for (const m of grype.matches ?? []) {
      const v = m.vulnerability;
      const a = m.artifact;
      const clave = [imagen, a.name, a.version, a.type, v.id].join("\u0000");
      const existente = filas.get(clave);
      if (existente) {
        existente.ubicaciones += 1;
        continue;
      }
      filas.set(clave, {
        imagen,
        tipoImagen: tipo,
        paquete: a.name,
        version: a.version,
        tipoPaquete: a.type,
        purl: a.purl ?? null,
        vulnerabilidad: v.id,
        alias: aliasDe(m),
        severidad: SEVERIDADES.includes(v.severity) ? v.severity : "Unknown",
        estadoCorreccion: v.fix?.state ?? "unknown",
        correccion: v.fix?.versions ?? [],
        fuente: v.dataSource ?? null,
        ubicaciones: 1,
      });
    }
  }
  return [...filas.values()].sort(
    (x, y) =>
      rango(x.severidad) - rango(y.severidad) ||
      x.imagen.localeCompare(y.imagen) ||
      x.paquete.localeCompare(y.paquete) ||
      x.vulnerabilidad.localeCompare(y.vulnerabilidad),
  );
}

/** Conteo por imagen y severidad (todas las imágenes aparecen, aunque no tengan hallazgos). */
export function resumenPorImagen(entradas, filas) {
  const r = new Map(
    entradas.map((e) => [
      e.imagen,
      { imagen: e.imagen, tipo: e.tipo, ...Object.fromEntries(SEVERIDADES.map((s) => [s, 0])), total: 0 },
    ]),
  );
  for (const f of filas) {
    const fila = r.get(f.imagen);
    fila[f.severidad] += 1;
    fila.total += 1;
  }
  return [...r.values()];
}

/** Busca la decisión de VEX de una vulnerabilidad (por id o alias, y por purl si la decisión lo fija). */
export function decisionPara(decisiones, vulnerabilidad, alias, purl) {
  const ids = new Set([vulnerabilidad, ...alias]);
  return decisiones.find((d) => ids.has(d.id) && (!d.purl || d.purl === purl));
}

/** Valida una decisión según las reglas de OpenVEX; devuelve la lista de errores. */
export function validarDecision(d) {
  const e = [];
  if (!d.id) e.push("falta id");
  if (!ESTADOS_VEX.includes(d.status)) e.push(`${d.id}: status inválido «${d.status}»`);
  if (d.status === "not_affected") {
    if (!d.justification && !d.impact_statement)
      e.push(`${d.id}: not_affected exige justification o impact_statement`);
    if (d.justification && !JUSTIFICACIONES_VEX.includes(d.justification))
      e.push(`${d.id}: justification inválida «${d.justification}»`);
  }
  if (d.status === "affected" && !d.action_statement) e.push(`${d.id}: affected exige action_statement`);
  return e;
}

const md = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");

/** Estado de VEX de una fila crítica (para la columna de la tabla). */
function estadoVexFila(f, decisiones) {
  if (f.severidad !== "Critical") return "";
  return decisionPara(decisiones, f.vulnerabilidad, f.alias, f.purl)?.status ?? "under_investigation";
}

/** Tabla completa en Markdown: resumen por imagen y todas las filas, sin cortar. */
export function tablaMarkdown({ version, generado, herramienta, entradas, filas, decisiones = [] }) {
  const resumen = resumenPorImagen(entradas, filas);
  const total = Object.fromEntries(
    SEVERIDADES.map((s) => [s, filas.filter((f) => f.severidad === s).length]),
  );
  const lineas = [
    `# Vulnerabilidades conocidas · Yago Nexo ${version}`,
    "",
    `Generado el ${generado} por ${herramienta} a partir del SBOM (syft) de cada imagen de la versión.`,
    "Incluye todas las severidades y todas las filas, sin cortar. Las críticas tienen su estado en",
    `\`vex-nexo-${version}.openvex.json\` (OpenVEX). Corrección «—» = grype no conoce una versión corregida.`,
    "",
    "## Resumen por imagen",
    "",
    `| Imagen | Origen | ${SEVERIDADES.map((s) => NOMBRE_SEVERIDAD[s]).join(" | ")} | Total |`,
    `| --- | --- | ${SEVERIDADES.map(() => "---:").join(" | ")} | ---: |`,
    ...resumen.map(
      (r) =>
        `| ${md(r.imagen)} | ${r.tipo === "propia" ? "propia" : "tercero"} | ${SEVERIDADES.map((s) => r[s]).join(" | ")} | ${r.total} |`,
    ),
    `| **Total** | | ${SEVERIDADES.map((s) => `**${total[s]}**`).join(" | ")} | **${filas.length}** |`,
    "",
    "## Detalle",
    "",
  ];
  if (filas.length === 0) {
    lineas.push("Sin vulnerabilidades conocidas en las imágenes de esta versión.", "");
    return lineas.join("\n");
  }
  lineas.push(
    "| Severidad | Imagen | Paquete | Versión | Tipo | Vulnerabilidad | Alias | Corrección | Estado VEX |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...filas.map(
      (f) =>
        `| ${NOMBRE_SEVERIDAD[f.severidad]} | ${md(f.imagen)} | ${md(f.paquete)}${f.ubicaciones > 1 ? ` (×${f.ubicaciones})` : ""} | ${md(f.version)} | ${md(f.tipoPaquete)} | ${md(f.vulnerabilidad)} | ${md(f.alias.join(", "))} | ${md(f.correccion.join(", ") || "—")} | ${estadoVexFila(f, decisiones)} |`,
    ),
    "",
  );
  return lineas.join("\n");
}

/** Tabla en JSON (la misma información que el Markdown). */
export function tablaJson({ version, generado, herramienta, entradas, filas, decisiones = [] }) {
  return {
    producto: "Yago Nexo",
    version,
    generado,
    herramienta,
    resumen: resumenPorImagen(entradas, filas),
    vulnerabilidades: filas.map((f) => ({ ...f, estadoVex: estadoVexFila(f, decisiones) || null })),
  };
}

/**
 * Documento OpenVEX 0.2.0 con una declaración por vulnerabilidad crítica. Lo analizado sale de
 * vex-decisiones.json; lo que no tiene análisis queda «under_investigation» con lo que informa grype.
 */
export function documentoVex({
  generado,
  herramienta,
  autor,
  idDocumento,
  entradas,
  filas,
  decisiones = [],
}) {
  const errores = decisiones.flatMap(validarDecision);
  if (errores.length) throw new Error(`vex-decisiones.json inválido:\n  - ${errores.join("\n  - ")}`);
  const purlPorImagen = new Map(entradas.map((e) => [e.imagen, purlImagen(e.imagen)]));
  const grupos = new Map();
  for (const f of filas.filter((x) => x.severidad === "Critical")) {
    const d = decisionPara(decisiones, f.vulnerabilidad, f.alias, f.purl);
    const k = `${f.vulnerabilidad}\u0000${d ? d.id + (d.purl ?? "") : ""}`;
    const g = grupos.get(k) ?? { filas: [], decision: d };
    g.filas.push(f);
    grupos.set(k, g);
  }
  const statements = [...grupos.values()].map(({ filas: fs, decision }) => {
    const f0 = fs[0];
    const productos = new Map();
    for (const f of fs) {
      const p = productos.get(f.imagen) ?? { "@id": purlPorImagen.get(f.imagen), subcomponents: [] };
      const sub = f.purl ?? `${f.paquete}@${f.version}`;
      if (!p.subcomponents.some((s) => s["@id"] === sub)) p.subcomponents.push({ "@id": sub });
      productos.set(f.imagen, p);
    }
    const st = {
      vulnerability: { name: f0.vulnerabilidad, ...(f0.alias.length ? { aliases: f0.alias } : {}) },
      timestamp: generado,
      products: [...productos.values()],
    };
    if (decision) {
      st.status = decision.status;
      for (const campo of ["justification", "impact_statement", "action_statement", "status_notes"]) {
        if (decision[campo]) st[campo] = decision[campo];
      }
    } else {
      const imagenes = [...productos.keys()].join(", ");
      const paquetes = [...new Set(fs.map((f) => `${f.paquete} ${f.version}`))].join(", ");
      const corr = [...new Set(fs.flatMap((f) => f.correccion))];
      st.status = "under_investigation";
      st.status_notes =
        `Crítica según ${herramienta} en ${paquetes} (${imagenes}). ` +
        (corr.length
          ? `Versión corregida publicada: ${corr.join(", ")}. `
          : "Sin versión corregida publicada. ") +
        "Análisis de explotabilidad pendiente: sin entrada en tools/release/vex-decisiones.json.";
    }
    return st;
  });
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": idDocumento,
    author: autor,
    role: "Fabricante de Yago Nexo",
    timestamp: generado,
    version: 1,
    tooling: herramienta,
    statements,
  };
}

/**
 * Comprueba que la tabla Markdown, el JSON y el OpenVEX de una versión digan lo mismo (caso LAB-PA-055-01):
 * mismas filas, mismos totales y una declaración de VEX para cada crítica. Devuelve la lista de diferencias.
 */
export function comprobarConsistencia({ markdown, json, vex }) {
  const errores = [];
  const nombres = Object.values(NOMBRE_SEVERIDAD).join("|");
  const filasMd = markdown.split("\n").filter((l) => new RegExp(`^\\| (${nombres}) \\|`).test(l));
  if (filasMd.length !== json.vulnerabilidades.length) {
    errores.push(`la tabla Markdown tiene ${filasMd.length} filas y el JSON ${json.vulnerabilidades.length}`);
  }
  for (const v of json.vulnerabilidades) {
    const esperado = `| ${NOMBRE_SEVERIDAD[v.severidad]} | ${md(v.imagen)} | ${md(v.paquete)}`;
    if (!filasMd.some((l) => l.startsWith(esperado) && l.includes(`| ${md(v.vulnerabilidad)} |`))) {
      errores.push(`falta en el Markdown: ${v.imagen} ${v.paquete} ${v.vulnerabilidad}`);
    }
  }
  for (const r of json.resumen) {
    const n = json.vulnerabilidades.filter((v) => v.imagen === r.imagen).length;
    if (n !== r.total) errores.push(`resumen de ${r.imagen}: dice ${r.total} y hay ${n} filas`);
  }
  const criticas = new Set(
    json.vulnerabilidades.filter((v) => v.severidad === "Critical").map((v) => v.vulnerabilidad),
  );
  const declaradas = new Set(vex.statements.map((s) => s.vulnerability.name));
  for (const c of criticas)
    if (!declaradas.has(c)) errores.push(`la crítica ${c} no tiene declaración en el OpenVEX`);
  for (const d of declaradas)
    if (!criticas.has(d)) errores.push(`el OpenVEX declara ${d}, que no es crítica en la tabla`);
  return errores;
}
