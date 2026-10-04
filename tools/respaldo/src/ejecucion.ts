// Ejecución de procesos externos (docker, pg_dump, pg_restore, psql). Siempre con lista de
// argumentos, sin shell; las contraseñas viajan por variables de entorno, nunca en la línea de comandos.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Config, ConfigServidor } from "./config.js";

export interface ResultadoProceso {
  codigo: number | null;
  salida: string;
  error: string;
}

const LIMITE_TEXTO = 64 * 1024;

function recortar(acumulado: string, nuevo: string): string {
  const t = acumulado + nuevo;
  return t.length > LIMITE_TEXTO ? t.slice(t.length - LIMITE_TEXTO) : t;
}

/** Ejecuta un comando y devuelve su salida (para comandos con salida breve). */
export function ejecutar(
  comando: string,
  args: string[],
  opciones: { env?: NodeJS.ProcessEnv; entrada?: Readable } = {},
): Promise<ResultadoProceso> {
  return new Promise((ok, mal) => {
    const p = spawn(comando, args, {
      env: opciones.env ?? process.env,
      stdio: [opciones.entrada ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let salida = "";
    let error = "";
    p.stdout!.setEncoding("utf8").on("data", (d: string) => (salida = recortar(salida, d)));
    p.stderr!.setEncoding("utf8").on("data", (d: string) => (error = recortar(error, d)));
    p.on("error", (e) => mal(new Error(`no se pudo ejecutar ${comando}: ${e.message}`)));
    p.on("close", (codigo) => ok({ codigo, salida, error }));
    if (opciones.entrada && p.stdin) {
      opciones.entrada.on("error", (e) => {
        p.kill("SIGTERM");
        mal(e);
      });
      p.stdin.on("error", () => {
        // el proceso cerró su entrada antes de tiempo: el código de salida dirá por qué
      });
      opciones.entrada.pipe(p.stdin);
    }
  });
}

/** Como ejecutar, pero falla si el código de salida no es 0. */
export async function ejecutarOk(
  comando: string,
  args: string[],
  opciones: { env?: NodeJS.ProcessEnv; entrada?: Readable; que?: string } = {},
): Promise<string> {
  const que = opciones.que ?? `${comando} ${args[0] ?? ""}`;
  let r: ResultadoProceso;
  try {
    r = await ejecutar(comando, args, opciones);
  } catch (e) {
    // p. ej. el descifrado de la entrada detectó una alteración
    throw new Error(`${que}: ${(e as Error).message}`, { cause: e });
  }
  if (r.codigo !== 0)
    throw new Error(`${que} terminó con código ${r.codigo}: ${r.error.trim() || r.salida.trim()}`);
  return r.salida;
}

export interface ProcesoEnCurso {
  proceso: ChildProcessByStdio<Writable | null, Readable, Readable>;
  /** Se resuelve al terminar el proceso, con su código y el final de su salida de error. */
  terminado: Promise<{ codigo: number | null; error: string }>;
}

/** Lanza un comando cuya salida estándar se consume como flujo (pg_dump, pg_dumpall). */
export function lanzar(comando: string, args: string[], env: NodeJS.ProcessEnv): ProcesoEnCurso {
  const proceso = spawn(comando, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  proceso.stderr.setEncoding("utf8").on("data", (d: string) => (error = recortar(error, d)));
  const terminado = new Promise<{ codigo: number | null; error: string }>((ok) => {
    proceso.on("error", (e) => {
      error = recortar(error, `no se pudo ejecutar ${comando}: ${e.message}`);
      ok({ codigo: -1, error });
    });
    proceso.on("close", (codigo) => ok({ codigo, error }));
  });
  return { proceso, terminado };
}

export function sufijo(): string {
  return randomBytes(4).toString("hex");
}

// ------------------------------------------------------------------ herramientas de PostgreSQL

export interface ComandoPg {
  comando: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Nombre del contenedor temporal (modo docker), para eliminarlo si algo falla. */
  contenedor?: string;
}

const CA_EN_CONTENEDOR = "/run/nexo-respaldo/ca.crt";

/**
 * Arma la invocación de pg_dump o pg_dumpall contra un servidor: con binarios locales (modo local)
 * o dentro de un contenedor efímero en la red de los servidores (modo docker). Función pura.
 */
export function comandoPg(
  herramienta: "pg_dump" | "pg_dumpall",
  argsHerramienta: string[],
  servidor: ConfigServidor,
  config: Pick<Config, "modo" | "docker" | "local">,
  clave: string,
  entorno: NodeJS.ProcessEnv = process.env,
): ComandoPg {
  const sslmode =
    servidor.tls === "verificar" ? "verify-full" : servidor.tls === "requerido" ? "require" : "disable";
  const conexion = [
    "--host",
    servidor.host,
    "--port",
    String(servidor.puerto),
    "--username",
    servidor.usuario,
    "--no-password",
  ];
  const varsPg: NodeJS.ProcessEnv = { PGPASSWORD: clave, PGSSLMODE: sslmode, PGAPPNAME: "nexo-respaldo" };
  if (config.modo === "local") {
    if (servidor.ca) varsPg.PGSSLROOTCERT = servidor.ca;
    const comando = config.local.binarios ? join(config.local.binarios, herramienta) : herramienta;
    return { comando, args: [...conexion, ...argsHerramienta], env: { ...entorno, ...varsPg } };
  }
  if (servidor.ca) varsPg.PGSSLROOTCERT = CA_EN_CONTENEDOR;
  const contenedor = `nexo-respaldo-volcado-${servidor.nombre}-${sufijo()}`;
  const args = [
    "run",
    "--rm",
    "--name",
    contenedor,
    "--label",
    "nexo-respaldo=volcado",
    "--network",
    config.docker.red!,
  ];
  // "-e NOMBRE" sin valor: docker toma el valor de su propio entorno (no queda en la línea de comandos).
  for (const nombre of Object.keys(varsPg)) args.push("-e", nombre);
  if (servidor.ca) args.push("-v", `${servidor.ca}:${CA_EN_CONTENEDOR}:ro`);
  args.push(config.docker.imagen, herramienta, ...conexion, ...argsHerramienta);
  return { comando: "docker", args, env: { ...entorno, ...varsPg }, contenedor };
}

// ------------------------------------------------------------------ Docker

export async function eliminarContenedor(nombre: string): Promise<void> {
  await ejecutar("docker", ["rm", "-f", "-v", nombre]).catch(() => undefined);
}

/** IP de un contenedor: en la red indicada o, si no se indica, en la primera que tenga. */
export async function ipContenedor(nombre: string, red?: string | null): Promise<string> {
  const formato = red
    ? `{{with index .NetworkSettings.Networks "${red}"}}{{.IPAddress}}{{end}}`
    : "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}";
  const salida = await ejecutarOk("docker", ["inspect", "-f", formato, nombre], {
    que: `docker inspect ${nombre}`,
  });
  const ip = salida.trim().split(/\s+/)[0];
  if (!ip) throw new Error(`el contenedor ${nombre} no tiene IP${red ? ` en la red ${red}` : ""}`);
  return ip;
}

/** Versión de pg_dump que se usará (la imagen en modo docker o el binario en modo local). */
export async function versionPgDump(config: Pick<Config, "modo" | "docker" | "local">): Promise<string> {
  if (config.modo === "docker") {
    const args = [
      "run",
      "--rm",
      "--name",
      `nexo-respaldo-version-${sufijo()}`,
      config.docker.imagen,
      "pg_dump",
      "--version",
    ];
    return (await ejecutarOk("docker", args, { que: "docker run pg_dump --version" })).trim();
  }
  return (
    await ejecutarOk(config.local.binarios ? join(config.local.binarios, "pg_dump") : "pg_dump", [
      "--version",
    ])
  ).trim();
}
