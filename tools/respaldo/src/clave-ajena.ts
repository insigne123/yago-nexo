// Caso de aceptación «restaurar un respaldo con otra clave → rechazo antes de escribir» (BT-053).
//
// Intenta restaurar el respaldo más reciente (o el indicado) con una clave nueva y aleatoria, distinta de la que
// lo cifró, y comprueba que:
//   1. la restauración se rechaza por la huella de la clave (el manifiesto guarda la huella de la clave con que
//      se cifró: cifrado.ts, huellaClave);
//   2. no se escribió nada: los archivos de la carpeta del respaldo quedan con el mismo SHA-256 (sin marca de
//      prueba ni informe nuevo) y no se creó ningún servidor temporal de prueba.
// La clave ajena se crea en una carpeta temporal y se borra al terminar; la clave real no se lee.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listarRespaldos, type Registro } from "./almacen.js";
import { generarClaveHex, huellaClave, interpretarClave, sha256Archivo } from "./cifrado.js";
import type { Config } from "./config.js";
import { ejecutar } from "./ejecucion.js";
import { ErrorClaveDistinta } from "./manifiesto.js";
import { restaurar } from "./restaurar.js";

export interface ResultadoClaveAjena {
  ok: boolean;
  respaldo: string;
  huellaClaveAjena: string;
  rechazo: string | null;
  archivosAntes: number;
  /** Archivos agregados, cambiados o quitados en la carpeta del respaldo durante el intento. */
  cambios: string[];
  /** Servidores temporales de prueba creados durante el intento. */
  contenedoresNuevos: string[];
  motivos: string[];
}

export interface Dependencias {
  restaurar: typeof restaurar;
  /** Nombres de los contenedores de prueba de restauración existentes (etiqueta nexo-respaldo=prueba). */
  contenedoresPrueba: () => Promise<string[]>;
}

async function contenedoresPrueba(): Promise<string[]> {
  const r = await ejecutar("docker", [
    "ps",
    "-a",
    "--filter",
    "label=nexo-respaldo=prueba",
    "--format",
    "{{.Names}}",
  ]);
  if (r.codigo !== 0) throw new Error(`docker ps: ${r.error.trim()}`);
  return r.salida.split("\n").filter(Boolean);
}

/** SHA-256 de cada archivo de la carpeta (recursivo), por ruta relativa. */
export async function huellasCarpeta(carpeta: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const recorrer = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) await recorrer(ruta);
      else out.set(relative(carpeta, ruta), (await sha256Archivo(ruta)).sha256);
    }
  };
  await recorrer(carpeta);
  return out;
}

export function diferencias(antes: Map<string, string>, despues: Map<string, string>): string[] {
  const cambios: string[] = [];
  for (const [ruta, h] of despues) {
    if (!antes.has(ruta)) cambios.push(`agregado ${ruta}`);
    else if (antes.get(ruta) !== h) cambios.push(`cambiado ${ruta}`);
  }
  for (const ruta of antes.keys()) if (!despues.has(ruta)) cambios.push(`quitado ${ruta}`);
  return cambios.sort();
}

export async function probarClaveAjena(
  config: Config,
  opciones: { respaldo?: string } = {},
  log: Registro = console.log,
  deps: Dependencias = { restaurar, contenedoresPrueba },
): Promise<ResultadoClaveAjena> {
  const id = opciones.respaldo ?? (await listarRespaldos(config.destino))[0]?.id;
  if (!id) throw new Error(`no hay respaldos completos en ${config.destino}`);
  const carpeta = join(config.destino, id);
  const temporal = await mkdtemp(join(tmpdir(), "nexo-clave-ajena-"));
  const rutaClave = join(temporal, "clave-ajena.key");
  const claveHex = generarClaveHex();
  await writeFile(rutaClave, `${claveHex}\n`, { mode: 0o600, flag: "wx" });
  const huellaAjena = huellaClave(interpretarClave(Buffer.from(claveHex)));
  const resultado: ResultadoClaveAjena = {
    ok: false,
    respaldo: id,
    huellaClaveAjena: huellaAjena,
    rechazo: null,
    archivosAntes: 0,
    cambios: [],
    contenedoresNuevos: [],
    motivos: [],
  };
  try {
    const antes = await huellasCarpeta(carpeta);
    resultado.archivosAntes = antes.size;
    const contenedoresAntes = new Set(await deps.contenedoresPrueba());
    log(
      `Respaldo ${id}: ${antes.size} archivos; se intenta restaurar con una clave ajena (huella ${huellaAjena})`,
    );
    try {
      const { informe } = await deps.restaurar(
        { ...config, clave: rutaClave },
        { respaldo: id },
        () => undefined,
      );
      resultado.motivos.push(`la restauración no rechazó la clave ajena (resultado ${informe.resultado})`);
    } catch (e) {
      if (e instanceof ErrorClaveDistinta) resultado.rechazo = e.message;
      else
        resultado.motivos.push(
          `la restauración falló por otro motivo: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    resultado.cambios = diferencias(antes, await huellasCarpeta(carpeta));
    resultado.contenedoresNuevos = (await deps.contenedoresPrueba()).filter((c) => !contenedoresAntes.has(c));
    if (resultado.cambios.length)
      resultado.motivos.push(`se escribió en la carpeta del respaldo: ${resultado.cambios.join(", ")}`);
    if (resultado.contenedoresNuevos.length)
      resultado.motivos.push(`se creó un servidor temporal: ${resultado.contenedoresNuevos.join(", ")}`);
    resultado.ok = resultado.rechazo !== null && resultado.motivos.length === 0;
    return resultado;
  } finally {
    await rm(temporal, { recursive: true, force: true });
  }
}
