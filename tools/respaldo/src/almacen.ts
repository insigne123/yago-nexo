// Carpeta de respaldos: clave maestra, bloqueo, listado y aplicación de la retención.
//
//   <destino>/
//     .bloqueo                       mientras corre un respaldo
//     .<id>.parcial/                 respaldo en curso (se borra si falla)
//     <id>/                          respaldo completo (solo existe con su manifiesto)
//       manifiesto.json
//       <servidor>/globales.sql.enc
//       <servidor>/<base>.pgdump.enc
//       informe-restauracion.json|md (última prueba de restauración de este respaldo)
//       .en-prueba                   mientras se prueba (la retención no lo borra)
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { generarClaveHex, interpretarClave } from "./cifrado.js";
import type { Config } from "./config.js";
import { ARCHIVO_MANIFIESTO, fechaDeId } from "./manifiesto.js";
import { decidirRetencion, type DecisionRetencion } from "./retencion.js";

export type Registro = (mensaje: string) => void;

export const MARCA_EN_PRUEBA = ".en-prueba";

/** Lee la clave maestra. En el laboratorio la genera la primera vez (si la configuración lo permite). */
export async function cargarClave(config: Config, log: Registro, permitirGenerar: boolean): Promise<Buffer> {
  if (!existsSync(config.clave)) {
    if (!(permitirGenerar && config.generarClaveSiFalta)) {
      throw new Error(
        `no existe el archivo de clave ${config.clave}. Indique su ruta en NEXO_RESPALDO_CLAVE`,
      );
    }
    await mkdir(dirname(config.clave), { recursive: true });
    await writeFile(config.clave, `${generarClaveHex()}\n`, { mode: 0o600, flag: "wx" });
    log(
      `Clave de laboratorio generada en ${config.clave} (ignorada por git). Sin ella los respaldos no se pueden leer.`,
    );
  }
  const info = await stat(config.clave);
  if ((info.mode & 0o077) !== 0) {
    log(
      `AVISO: el archivo de clave es legible por otros usuarios (permisos ${(info.mode & 0o777).toString(8)}); use chmod 600.`,
    );
  }
  return interpretarClave(await readFile(config.clave));
}

function procesoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Impide dos respaldos a la vez sobre el mismo destino (p. ej. dos ejecuciones de cron). */
export async function tomarBloqueo(destino: string, log: Registro): Promise<() => Promise<void>> {
  const ruta = join(destino, ".bloqueo");
  const contenido = JSON.stringify({ pid: process.pid, equipo: hostname(), desde: new Date().toISOString() });
  for (let intento = 0; intento < 2; intento++) {
    try {
      await writeFile(ruta, contenido, { flag: "wx", mode: 0o600 });
      return () => unlink(ruta).catch(() => undefined);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let previo: { pid?: number; equipo?: string; desde?: string } = {};
      try {
        previo = JSON.parse(await readFile(ruta, "utf8")) as typeof previo;
      } catch {
        // bloqueo ilegible: se trata como abandonado
      }
      const mismoEquipo = previo.equipo === hostname();
      if (previo.pid && (!mismoEquipo || procesoVivo(previo.pid))) {
        throw new Error(
          `hay otro respaldo en curso en ${destino} (pid ${previo.pid} en ${previo.equipo}, desde ${previo.desde}). ` +
            `Si no es así, borre ${ruta}`,
          { cause: e },
        );
      }
      log(`AVISO: se encontró un bloqueo abandonado (pid ${previo.pid ?? "?"}); se reemplaza.`);
      await unlink(ruta).catch(() => undefined);
    }
  }
  throw new Error(`no se pudo tomar el bloqueo ${ruta}`);
}

export interface RespaldoEnDisco {
  id: string;
  fecha: Date;
  carpeta: string;
}

/** Respaldos completos (carpetas con nombre de id y manifiesto), del más reciente al más antiguo. */
export async function listarRespaldos(destino: string): Promise<RespaldoEnDisco[]> {
  if (!existsSync(destino)) return [];
  const lista: RespaldoEnDisco[] = [];
  for (const entrada of await readdir(destino, { withFileTypes: true })) {
    if (!entrada.isDirectory()) continue;
    const fecha = fechaDeId(entrada.name);
    const carpeta = join(destino, entrada.name);
    if (fecha && existsSync(join(carpeta, ARCHIVO_MANIFIESTO)))
      lista.push({ id: entrada.name, fecha, carpeta });
  }
  return lista.sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
}

/** Borra respaldos parciales que quedaron de una ejecución interrumpida (se llama con el bloqueo tomado). */
export async function limpiarParciales(destino: string, log: Registro): Promise<void> {
  for (const entrada of await readdir(destino, { withFileTypes: true })) {
    if (entrada.isDirectory() && /^\..+\.parcial$/.test(entrada.name)) {
      await rm(join(destino, entrada.name), { recursive: true, force: true });
      log(`Respaldo parcial abandonado eliminado: ${entrada.name}`);
    }
  }
}

export async function aplicarRetencion(
  config: Config,
  ahora: Date,
  log: Registro,
): Promise<DecisionRetencion> {
  const respaldos = await listarRespaldos(config.destino);
  const decision = decidirRetencion(respaldos, config.retencion, ahora);
  const borrados: DecisionRetencion["borrar"] = [];
  for (const b of decision.borrar) {
    const carpeta = join(config.destino, b.id);
    if (existsSync(join(carpeta, MARCA_EN_PRUEBA))) {
      decision.avisos.push(`${b.id} está en una prueba de restauración: se borrará en la próxima pasada`);
      decision.conservar.push(b.id);
      continue;
    }
    await rm(carpeta, { recursive: true, force: true });
    borrados.push(b);
    log(`Retención: eliminado ${b.id} (${b.motivo})`);
  }
  decision.borrar = borrados;
  for (const a of decision.avisos) log(`AVISO: ${a}`);
  return decision;
}
