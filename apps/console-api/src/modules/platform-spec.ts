/**
 * Configuración de la plataforma como código para el paquete de exportación (BT-049, BT-060): platform.yaml y los
 * archivos que referencia (flujos de aprobación y guías de estilo). Es la misma regla que aplica
 * `nexo-ctl api export` (tools/nexo-ctl/src/commands/exportacion.ts): rutas relativas a la carpeta de
 * platform.yaml, sin rutas absolutas ni «..» que salgan de ella.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { parse } from "yaml";

export interface ArchivoPlataforma {
  /** Ruta relativa a la carpeta de platform.yaml; en el paquete queda bajo plataforma/. */
  ruta: string;
  nombre: string;
  datos: Uint8Array;
}

export const CARPETA_PLATAFORMA = "plataforma";

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
      datos: new Uint8Array(datos),
    },
  ];
  const agregar = (ruta: string | undefined, nombre: string, campo: string) => {
    if (!ruta) return;
    const rel = rutaRelativaSegura(ruta, campo);
    if (out.some((a) => a.ruta === rel)) return;
    out.push({ ruta: rel, nombre, datos: new Uint8Array(readFileSync(join(base, rel))) });
  };
  agregar(spec.workflows?.file, "flujos de aprobación (extensiones de workflow)", "workflows.file");
  for (const [i, r] of (spec.governance?.rulesets ?? []).entries())
    agregar(r.file, `guía de estilo «${r.name ?? r.file}»`, `governance.rulesets[${i}].file`);
  return out;
}
