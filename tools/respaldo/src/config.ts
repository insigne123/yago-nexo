// Configuración de la herramienta: un archivo JSON (respaldo.config.example.json es la del
// laboratorio) más variables de entorno que la sobrescriben, para producción y para cron/CronJob.
//
//   NEXO_RESPALDO_CONFIG       ruta del archivo de configuración
//   NEXO_RESPALDO_MODO         docker | local
//   NEXO_RESPALDO_DESTINO      carpeta donde se escriben los respaldos
//   NEXO_RESPALDO_CLAVE        ruta del archivo con la clave maestra (32 bytes)
//   NEXO_RESPALDO_CONSERVAR    cantidad de respaldos que se conservan
//   NEXO_RESPALDO_MAXIMO_DIAS  antigüedad máxima de un respaldo, en días ("0" o "" = sin máximo)
//   NEXO_RESPALDO_RED          red de Docker de los servidores (modo docker)
//   NEXO_RESPALDO_IMAGEN       imagen con pg_dump/pg_restore (modo docker y prueba de restauración)
//   NEXO_RESPALDO_BINARIOS     carpeta con pg_dump y pg_dumpall (modo local)
//
// Las contraseñas nunca van en el archivo: cada servidor indica la variable de entorno que la tiene.
// Las rutas del archivo son relativas a la carpeta del archivo; las del entorno, a la carpeta actual.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TAMANO_BLOQUE_POR_OMISION } from "./cifrado.js";
import type { PoliticaRetencion } from "./retencion.js";

export type Modo = "docker" | "local";
export type ModoTls = "desactivado" | "requerido" | "verificar";

export interface ConfigServidor {
  nombre: string;
  /** Host y puerto con que pg_dump llega al servidor (en modo docker, el nombre en la red de Docker). */
  host: string;
  puerto: number;
  /** Cómo llega esta herramienta al servidor, si no es igual a host/puerto (p. ej. un puerto publicado). */
  cliente?: { host: string; puerto: number };
  /** Modo docker: contenedor del servidor; si no hay "cliente", se usa su IP en la red. */
  contenedor?: string;
  usuario: string;
  /** Variable de entorno con la contraseña. */
  claveEnv: string;
  bases: "todas" | string[];
  excluir: string[];
  globales: boolean;
  tls: ModoTls;
  /** Certificado de la CA del servidor (tls "verificar"). */
  ca?: string;
}

export interface Config {
  archivo: string;
  modo: Modo;
  destino: string;
  clave: string;
  generarClaveSiFalta: boolean;
  retencion: PoliticaRetencion;
  huellaContenido: boolean;
  tamanoBloque: number;
  docker: { imagen: string; red: string | null };
  local: { binarios: string | null };
  restauracion: { imagen: string; trabajos: number; esperaListoSeg: number };
  /** Objetivos declarados: la prueba falla si el RTO medido supera rtoMinutos; rpoHoras solo avisa. */
  objetivos: { rtoMinutos: number | null; rpoHoras: number | null };
  servidores: ConfigServidor[];
}

export class ErrorConfig extends Error {}

type Obj = Record<string, unknown>;

function objeto(v: unknown, donde: string): Obj {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErrorConfig(`${donde} debe ser un objeto`);
  return v as Obj;
}

function texto(o: Obj, campo: string, donde: string, porOmision?: string): string {
  const v = o[campo];
  if (v === undefined || v === null || v === "") {
    if (porOmision !== undefined) return porOmision;
    throw new ErrorConfig(`falta ${donde}.${campo}`);
  }
  if (typeof v !== "string") throw new ErrorConfig(`${donde}.${campo} debe ser texto`);
  return v;
}

function entero(o: Obj, campo: string, donde: string, porOmision: number, minimo = 1): number {
  const v = o[campo] ?? porOmision;
  if (typeof v !== "number" || !Number.isInteger(v) || v < minimo)
    throw new ErrorConfig(`${donde}.${campo} debe ser un entero mayor o igual a ${minimo}`);
  return v;
}

function booleano(o: Obj, campo: string, donde: string, porOmision: boolean): boolean {
  const v = o[campo] ?? porOmision;
  if (typeof v !== "boolean") throw new ErrorConfig(`${donde}.${campo} debe ser true o false`);
  return v;
}

function enteroEntorno(env: NodeJS.ProcessEnv, nombre: string): number | undefined {
  const v = env[nombre];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ErrorConfig(`${nombre} debe ser un entero (es "${v}")`);
  return n;
}

const NOMBRE_SERVIDOR = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function servidor(crudo: unknown, i: number, dirConfig: string): ConfigServidor {
  const donde = `servidores[${i}]`;
  const o = objeto(crudo, donde);
  const nombre = texto(o, "nombre", donde);
  if (!NOMBRE_SERVIDOR.test(nombre))
    throw new ErrorConfig(`${donde}.nombre debe usar minúsculas, dígitos, "-" o "_" (es "${nombre}")`);
  const cliente = o.cliente === undefined ? undefined : objeto(o.cliente, `${donde}.cliente`);
  const bases = o.bases ?? "todas";
  if (
    bases !== "todas" &&
    !(Array.isArray(bases) && bases.length > 0 && bases.every((b) => typeof b === "string" && b))
  ) {
    throw new ErrorConfig(`${donde}.bases debe ser "todas" o una lista de nombres`);
  }
  const excluir = o.excluir ?? [];
  if (!Array.isArray(excluir) || !excluir.every((b) => typeof b === "string"))
    throw new ErrorConfig(`${donde}.excluir debe ser una lista de nombres`);
  const tls = texto(o, "tls", donde, "desactivado");
  if (!["desactivado", "requerido", "verificar"].includes(tls))
    throw new ErrorConfig(`${donde}.tls debe ser desactivado, requerido o verificar`);
  const ca = o.ca === undefined ? undefined : resolve(dirConfig, texto(o, "ca", donde));
  if (tls === "verificar" && !ca)
    throw new ErrorConfig(`${donde}: tls "verificar" necesita "ca" (certificado de la CA)`);
  const s: ConfigServidor = {
    nombre,
    host: texto(o, "host", donde),
    puerto: entero(o, "puerto", donde, 5432),
    usuario: texto(o, "usuario", donde),
    claveEnv: texto(o, "claveEnv", donde),
    bases: bases as ConfigServidor["bases"],
    excluir: excluir as string[],
    globales: booleano(o, "globales", donde, true),
    tls: tls as ModoTls,
  };
  if (cliente)
    s.cliente = {
      host: texto(cliente, "host", `${donde}.cliente`),
      puerto: entero(cliente, "puerto", `${donde}.cliente`, 5432),
    };
  if (o.contenedor !== undefined) s.contenedor = texto(o, "contenedor", donde);
  if (ca) s.ca = ca;
  return s;
}

/** Valida el archivo ya leído y aplica las variables de entorno. Función pura (sin E/S). */
export function normalizarConfig(
  crudo: unknown,
  opciones: { archivo: string; env: NodeJS.ProcessEnv; cwd: string },
): Config {
  const { env, cwd, archivo } = opciones;
  const dirConfig = dirname(archivo);
  const o = objeto(crudo, "configuración");
  const desdeArchivo = (campo: string, porOmision: string) =>
    resolve(dirConfig, texto(o, campo, "configuración", porOmision));
  const desdeEntorno = (nombre: string) => (env[nombre] ? resolve(cwd, env[nombre]) : undefined);

  const modo = env.NEXO_RESPALDO_MODO || texto(o, "modo", "configuración", "docker");
  if (modo !== "docker" && modo !== "local")
    throw new ErrorConfig(`modo debe ser "docker" o "local" (es "${modo}")`);

  const ret = objeto(o.retencion, "retencion");
  const conservar = enteroEntorno(env, "NEXO_RESPALDO_CONSERVAR") ?? entero(ret, "conservar", "retencion", 7);
  if (conservar < 1) throw new ErrorConfig("NEXO_RESPALDO_CONSERVAR debe ser 1 o más");
  let maximoDias: number | null =
    ret.maximoDias === undefined || ret.maximoDias === null
      ? null
      : entero(ret, "maximoDias", "retencion", 1);
  if (env.NEXO_RESPALDO_MAXIMO_DIAS !== undefined)
    maximoDias = enteroEntorno(env, "NEXO_RESPALDO_MAXIMO_DIAS") || null;

  const docker = objeto(o.docker, "docker");
  const local = objeto(o.local, "local");
  const rest = objeto(o.restauracion, "restauracion");
  const obj = objeto(o.objetivos, "objetivos");
  const opcional = (campo: string) =>
    obj[campo] === undefined || obj[campo] === null ? null : entero(obj, campo, "objetivos", 1);
  const imagen = env.NEXO_RESPALDO_IMAGEN || texto(docker, "imagen", "docker", "postgres:16-alpine");
  const red = env.NEXO_RESPALDO_RED || (docker.red === undefined ? null : texto(docker, "red", "docker"));
  const binarios = env.NEXO_RESPALDO_BINARIOS
    ? resolve(cwd, env.NEXO_RESPALDO_BINARIOS)
    : local.binarios
      ? resolve(dirConfig, texto(local, "binarios", "local"))
      : null;

  if (!Array.isArray(o.servidores) || o.servidores.length === 0)
    throw new ErrorConfig("servidores debe ser una lista con al menos un servidor");
  const servidores = o.servidores.map((s, i) => servidor(s, i, dirConfig));
  const repetido = servidores.find((s, i) => servidores.findIndex((t) => t.nombre === s.nombre) !== i);
  if (repetido) throw new ErrorConfig(`hay dos servidores con el nombre "${repetido.nombre}"`);
  if (modo === "docker" && !red)
    throw new ErrorConfig("el modo docker necesita docker.red (o NEXO_RESPALDO_RED)");

  return {
    archivo,
    modo,
    destino: desdeEntorno("NEXO_RESPALDO_DESTINO") ?? desdeArchivo("destino", "respaldos"),
    clave: desdeEntorno("NEXO_RESPALDO_CLAVE") ?? desdeArchivo("clave", "respaldo.key"),
    // Generar la clave solo tiene sentido en el laboratorio: si la ruta viene del entorno, debe existir.
    generarClaveSiFalta:
      !env.NEXO_RESPALDO_CLAVE && booleano(o, "generarClaveSiFalta", "configuración", false),
    retencion: { conservar, maximoDias },
    huellaContenido: booleano(o, "huellaContenido", "configuración", true),
    tamanoBloque: entero(o, "tamanoBloque", "configuración", TAMANO_BLOQUE_POR_OMISION),
    docker: { imagen, red },
    local: { binarios },
    restauracion: {
      imagen: env.NEXO_RESPALDO_IMAGEN || texto(rest, "imagen", "restauracion", imagen),
      trabajos: entero(rest, "trabajos", "restauracion", 2),
      esperaListoSeg: entero(rest, "esperaListoSeg", "restauracion", 90),
    },
    objetivos: { rtoMinutos: opcional("rtoMinutos"), rpoHoras: opcional("rpoHoras") },
    servidores,
  };
}

const DIR_PAQUETE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** respaldo.config.json si existe (copia local, ignorada por git); si no, la del laboratorio. */
export function rutaConfigPorOmision(): string {
  const local = join(DIR_PAQUETE, "respaldo.config.json");
  return existsSync(local) ? local : join(DIR_PAQUETE, "respaldo.config.example.json");
}

export function cargarConfig(
  ruta?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Config {
  const elegida = ruta ?? env.NEXO_RESPALDO_CONFIG;
  const archivo = elegida ? (isAbsolute(elegida) ? elegida : resolve(cwd, elegida)) : rutaConfigPorOmision();
  if (!existsSync(archivo)) throw new ErrorConfig(`no existe el archivo de configuración ${archivo}`);
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(archivo, "utf8"));
  } catch (e) {
    throw new ErrorConfig(`${archivo} no es JSON válido: ${(e as Error).message}`);
  }
  return normalizarConfig(crudo, { archivo, env, cwd });
}

/** Versión de la herramienta (package.json), para el manifiesto y el informe. */
export function versionHerramienta(): { nombre: string; version: string } {
  const pkg = JSON.parse(readFileSync(join(DIR_PAQUETE, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  return { nombre: pkg.name, version: pkg.version };
}
