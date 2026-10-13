/**
 * Paquete de exportación (BT-049, BT-060): un zip por API en el formato de proyecto de WSO2 (compatible con
 * apictl), la configuración de la plataforma como código (wso2/apim/platform.yaml con los archivos que referencia:
 * flujos de aprobación y guías de estilo) y un manifiesto con el SHA-256 de cada archivo. Así el paquete basta para
 * reconstruir la configuración sin leer el repositorio Git.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { parse } from "yaml";

export interface ItemExportacion {
  tipo: "api" | "plataforma";
  nombre: string;
  archivo: string;
  sha256: string;
}

export interface Manifiesto {
  generadoEn: string;
  origen: string;
  version: "1";
  items: ItemExportacion[];
}

export interface ArchivoPlataforma {
  /** Ruta relativa a la carpeta de platform.yaml (se conserva dentro de plataforma/). */
  ruta: string;
  nombre: string;
  datos: Buffer;
}

export const CARPETA_PLATAFORMA = "plataforma";

/** Ruta relativa segura: sin absolutas ni «..» que salgan de la carpeta de la especificación. */
function rutaRelativaSegura(ruta: string, campo: string): string {
  const n = normalize(ruta);
  if (isAbsolute(ruta) || n === ".." || n.startsWith(`..${sep}`))
    throw new Error(`${campo}: la ruta ${ruta} sale de la carpeta de la especificación de plataforma`);
  return n.split(sep).join("/");
}

/** platform.yaml y los archivos que referencia (workflows.file y governance.rulesets[].file). */
export function archivosPlataforma(specPath: string): ArchivoPlataforma[] {
  const datos = readFileSync(specPath);
  const spec = parse(datos.toString("utf8")) as {
    workflows?: { file?: string };
    governance?: { rulesets?: Array<{ name?: string; file?: string }> };
  } | null;
  if (!spec || typeof spec !== "object")
    throw new Error(`${specPath} no es una especificación de plataforma (YAML vacío o inválido)`);
  const base = dirname(specPath);
  const out: ArchivoPlataforma[] = [
    {
      ruta: "platform.yaml",
      nombre: "configuración de la plataforma (ambientes, planes, flujos de aprobación y gobierno)",
      datos,
    },
  ];
  const agregar = (ruta: string | undefined, nombre: string, campo: string) => {
    if (!ruta) return;
    const rel = rutaRelativaSegura(ruta, campo);
    if (out.some((a) => a.ruta === rel)) return;
    out.push({ ruta: rel, nombre, datos: readFileSync(join(base, rel)) });
  };
  agregar(spec.workflows?.file, "flujos de aprobación (extensiones de workflow)", "workflows.file");
  for (const [i, r] of (spec.governance?.rulesets ?? []).entries())
    agregar(r.file, `guía de estilo «${r.name ?? r.file}»`, `governance.rulesets[${i}].file`);
  return out;
}

const sha256 = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

/** Escribe el paquete en outDir y devuelve el manifiesto (también escrito como manifiesto.json). */
export function escribirPaquete(
  outDir: string,
  apis: Array<{ nombre: string; version: string; zip: Uint8Array }>,
  plataforma: ArchivoPlataforma[],
  origen: string,
  ahora = new Date(),
): Manifiesto {
  mkdirSync(outDir, { recursive: true });
  const items: ItemExportacion[] = [];
  for (const a of apis) {
    const archivo = `${a.nombre}-${a.version}.zip`.replace(/[^\w.-]+/g, "_");
    writeFileSync(join(outDir, archivo), a.zip);
    items.push({ tipo: "api", nombre: `${a.nombre} ${a.version}`, archivo, sha256: sha256(a.zip) });
  }
  for (const p of plataforma) {
    const archivo = `${CARPETA_PLATAFORMA}/${p.ruta}`;
    mkdirSync(dirname(join(outDir, archivo)), { recursive: true });
    writeFileSync(join(outDir, archivo), p.datos);
    items.push({ tipo: "plataforma", nombre: p.nombre, archivo, sha256: sha256(p.datos) });
  }
  const manifiesto: Manifiesto = { generadoEn: ahora.toISOString(), origen, version: "1", items };
  writeFileSync(join(outDir, "manifiesto.json"), JSON.stringify(manifiesto, null, 2));
  return manifiesto;
}
