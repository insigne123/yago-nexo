// Piezas puras del SBOM CycloneDX de Yago Nexo (sin E/S): purls, clasificación ejecución/desarrollo,
// componentes propios @nexo/* y armado del documento. Las usa tools/release/generar-sbom.mjs y las prueba
// tools/release/test/sbom.test.mjs.

/** Licencias de copyleft fuerte: no pueden venir incrustadas en el código propio (npm). */
export const DENEGADAS_EN_CODIGO = /\b(GPL-[23]|AGPL|LGPL|SSPL|BUSL|CC-BY-NC)/i;

/**
 * Licencia del código propio de Yago: referencia SPDX a una licencia no listada (LicenseRef-*). CycloneDX solo
 * acepta identificadores de la lista SPDX en license.id, así que va como expresión.
 */
export const LICENCIA_PROPIA = "LicenseRef-Yago-Nexo";

const PROVEEDOR = { name: "Sociedad de Inversiones Yago SpA", url: ["https://yago-nexo.web.app"] };

/**
 * purl de un paquete npm según la especificación de purl: el «@» del scope va codificado como %40 y el
 * nombre y la versión se codifican por segmento (pkg:npm/%40scope/nombre@1.2.3).
 */
export function purlNpm(nombre, version) {
  const segmentos = nombre.split("/");
  const cod = (s) => encodeURIComponent(s);
  const ruta =
    segmentos.length === 2 && segmentos[0].startsWith("@")
      ? `${cod(segmentos[0])}/${cod(segmentos[1])}`
      : cod(nombre);
  return `pkg:npm/${ruta}@${cod(String(version))}`;
}

/** Licencia CycloneDX: un id SPDX simple va en «id»; una expresión (OR/AND/WITH) va en «expression». */
export function licenciaCdx(lic) {
  const limpia = String(lic)
    .trim()
    .replace(/^\((.*)\)$/, "$1");
  if (/\s(OR|AND|WITH)\s/.test(limpia)) return { expression: limpia };
  if (/^[A-Za-z0-9.+-]+$/.test(limpia) && !/\s/.test(limpia)) return { license: { id: limpia } };
  return { license: { name: limpia } };
}

/** Texto de una licencia CycloneDX (para el inventario legible). */
export function textoLicencia(l) {
  return l.expression ?? l.license?.id ?? l.license?.name ?? "desconocida";
}

/**
 * Convierte la salida de `pnpm licenses list --json` en una lista plana {nombre, version, licencia, web}.
 * Resuelve las licencias «Unknown» con los overrides verificados y devuelve los problemas encontrados.
 */
export function aplanarLicenciasPnpm(crudo, overrides = {}) {
  const paquetes = [];
  const problemas = [];
  for (const [licencia, lista] of Object.entries(crudo)) {
    for (const p of lista) {
      let lic = licencia;
      if (lic === "Unknown") {
        const o = overrides[p.name];
        if (!o) {
          problemas.push(
            `Licencia desconocida sin resolver: ${p.name} (agréguela a overrides-licencias.json con su licencia verificada)`,
          );
          continue;
        }
        lic = o.licencia;
      }
      const versiones = Array.isArray(p.versions) ? p.versions : [p.version].filter(Boolean);
      for (const v of versiones.length ? versiones : ["0.0.0"]) {
        paquetes.push({ nombre: p.name, version: String(v), licencia: lic, web: p.homepage || undefined });
      }
    }
  }
  return { paquetes, problemas };
}

const clave = (p) => `${p.nombre}@${p.version}`;

/**
 * Separa los paquetes npm de terceros en ejecución y desarrollo.
 * - ejecucion: dependencias de producción de los paquetes del workspace que se entregan para correr
 *   (sbom-config.json → ejecucion), con sus dependencias del workspace.
 * - desarrollo: todo lo demás del lockfile (devDependencies y herramientas de construcción, pruebas,
 *   laboratorio y documentación).
 * Un mismo nombre@versión que aparece en ambos lados queda en ejecución.
 */
export function clasificarNpm(todos, deEjecucion) {
  const enEjecucion = new Set(deEjecucion.map(clave));
  const vistos = new Set();
  const salida = [];
  for (const p of todos) {
    const k = clave(p);
    if (vistos.has(k)) continue;
    vistos.add(k);
    salida.push({ ...p, uso: enEjecucion.has(k) ? "ejecucion" : "desarrollo" });
  }
  // Lo que solo aparece en la lista de ejecución también entra (no debería pasar, pero no se pierde).
  for (const p of deEjecucion) {
    const k = clave(p);
    if (!vistos.has(k)) {
      vistos.add(k);
      salida.push({ ...p, uso: "ejecucion" });
    }
  }
  return salida;
}

/** Paquetes npm con copyleft fuerte (de ejecución o de desarrollo): ninguno se acepta en el workspace. */
export function licenciasDenegadas(paquetes) {
  return paquetes
    .filter((p) => DENEGADAS_EN_CODIGO.test(p.licencia))
    .map((p) => `Licencia no permitida en código propio: ${p.nombre}@${p.version} → ${p.licencia}`);
}

/** Propiedades CycloneDX que marcan el uso del componente. */
function propiedadesUso(uso, extra = []) {
  const props = [{ name: "nexo:uso", value: uso }, ...extra];
  // Taxonomía oficial de CycloneDX para npm: marca las dependencias de desarrollo.
  if (uso === "desarrollo") props.push({ name: "cdx:npm:package:development", value: "true" });
  return props;
}

/** scope de CycloneDX: lo que corre en producción es «required»; lo de desarrollo, «excluded». */
const alcance = (uso) => (uso === "ejecucion" ? "required" : "excluded");

/** Componente CycloneDX de un paquete npm de terceros. */
export function componenteNpm(p) {
  const purl = purlNpm(p.nombre, p.version);
  return {
    type: "library",
    "bom-ref": purl,
    name: p.nombre,
    version: p.version,
    scope: alcance(p.uso),
    purl,
    licenses: [licenciaCdx(p.licencia)],
    ...(p.web ? { externalReferences: [{ type: "website", url: p.web }] } : {}),
    properties: propiedadesUso(p.uso),
  };
}

/**
 * Componentes propios del workspace (@nexo/*). Recibe [{nombre, version, ruta, descripcion, uso}].
 * Los de packages/* son bibliotecas; el resto, aplicaciones.
 */
export function componentesPropios(paquetes) {
  return paquetes.map((p) => {
    const purl = purlNpm(p.nombre, p.version);
    return {
      type: p.ruta.startsWith("packages/") ? "library" : "application",
      "bom-ref": purl,
      supplier: PROVEEDOR,
      name: p.nombre,
      version: p.version,
      ...(p.descripcion ? { description: p.descripcion } : {}),
      scope: alcance(p.uso),
      purl,
      licenses: [{ expression: LICENCIA_PROPIA }],
      properties: propiedadesUso(p.uso, [
        { name: "nexo:origen", value: "propio" },
        { name: "nexo:ruta", value: p.ruta },
      ]),
    };
  });
}

/** Componentes de ejecución que no vienen de npm (contenedores y bibliotecas Java). */
export function componentesPlataforma(lista) {
  return lista.map((c) => ({
    type: c.purl?.startsWith("pkg:docker/") ? "container" : "library",
    "bom-ref": c.purl ?? `${c.nombre}@${c.version}`,
    name: c.nombre,
    version: c.version,
    scope: c.uso === "laboratorio" ? "excluded" : "required",
    ...(c.purl ? { purl: c.purl } : {}),
    licenses: [licenciaCdx(c.licencia)],
    externalReferences: [{ type: "website", url: c.url }],
    properties: [
      { name: "nexo:uso", value: c.uso === "laboratorio" ? "laboratorio" : "ejecucion" },
      { name: "nexo:rol", value: c.rol },
      ...(c.nota ? [{ name: "nexo:nota", value: c.nota }] : []),
    ],
  }));
}

/** Documento CycloneDX 1.6 completo. */
export function construirBom({ version, timestamp, propios, plataforma, npm, serial }) {
  const componentes = [...propios, ...plataforma, ...npm].sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)),
  );
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    ...(serial ? { serialNumber: serial } : {}),
    version: 1,
    metadata: {
      timestamp,
      component: {
        type: "application",
        "bom-ref": `pkg:generic/yago-nexo@${version}`,
        name: "Yago Nexo",
        version,
        description:
          "Plataforma de gestión de APIs e integración de Yago, construida sobre WSO2 (base abierta).",
        supplier: PROVEEDOR,
        purl: `pkg:generic/yago-nexo@${version}`,
        licenses: [{ expression: LICENCIA_PROPIA }],
      },
      supplier: PROVEEDOR,
      licenses: [{ expression: LICENCIA_PROPIA }],
      tools: { components: [{ type: "application", name: "generar-sbom.mjs", group: "yago-nexo" }] },
      properties: [
        {
          name: "nexo:licencia",
          value:
            "Código propio de Yago (LicenseRef-Yago-Nexo); cada componente de terceros conserva su licencia.",
        },
        {
          name: "nexo:alcance",
          value:
            "scope=required: se entrega y corre en producción; scope=excluded: desarrollo, pruebas, laboratorio o construcción.",
        },
      ],
    },
    components: componentes,
  };
}

/** Resumen por uso y tipo, para el inventario y la consola. */
export function resumen(bom) {
  const r = { total: bom.components.length, ejecucion: 0, desarrollo: 0, laboratorio: 0, propios: 0 };
  for (const c of bom.components) {
    const uso = c.properties?.find((p) => p.name === "nexo:uso")?.value;
    if (uso && uso in r) r[uso] += 1;
    if (c.properties?.some((p) => p.name === "nexo:origen" && p.value === "propio")) r.propios += 1;
  }
  return r;
}
