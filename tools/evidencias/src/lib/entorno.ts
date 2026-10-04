/**
 * Datos de la grabación: rutas del repositorio, versión y commit de Nexo, máquina y ambiente.
 * Las credenciales del laboratorio se leen de deploy/compose/.env (las mismas que usa `make`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const desdeRaiz = (...p: string[]) => resolve(RAIZ, ...p);
export const PAQUETE = desdeRaiz("tools/evidencias");
export const SALIDA = desdeRaiz("release/evidencias");
export const ZONA = "America/Santiago";

/** Carga deploy/compose/.env en process.env sin pisar lo que ya venga definido. */
export function cargarEnv(): void {
  const archivo = desdeRaiz("deploy/compose/.env");
  if (!existsSync(archivo)) throw new Error(`falta ${archivo} (ejecute make env en deploy/compose)`);
  for (const linea of readFileSync(archivo, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" }).trim();
}

export interface Meta {
  version: string;
  commit: string;
  commitCompleto: string;
  /** Cambios sin confirmar en el árbol de trabajo al grabar (se registra; por defecto se rechaza). */
  cambiosLocales: string[];
  maquina: string;
  ambiente: string;
}

export function meta(): Meta {
  const release = JSON.parse(readFileSync(desdeRaiz("apps/site/src/data/release.json"), "utf8")) as { version: string };
  // Sin trim: la primera columna de --porcelain puede ser un espacio (« M archivo»).
  const cambios = execFileSync("git", ["status", "--porcelain"], { cwd: RAIZ, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  const maquina = hostname();
  return {
    version: release.version,
    commit: git("rev-parse", "--short=7", "HEAD"),
    commitCompleto: git("rev-parse", "HEAD"),
    cambiosLocales: cambios,
    maquina,
    ambiente: `Laboratorio Yago Nexo · Docker Compose · ${maquina}`,
  };
}

/** Fecha y hora en Santiago con su desfase, p. ej. "4 de octubre de 2026, 13:20:05 (UTC−03:00)". */
export function fechaSantiago(d = new Date()): string {
  const f = new Intl.DateTimeFormat("es-CL", {
    timeZone: ZONA,
    dateStyle: "long",
    timeStyle: "medium",
  }).format(d);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: ZONA, timeZoneName: "longOffset" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value.replace("GMT", "UTC");
  return `${f} (${ZONA}, ${off ?? ""})`;
}

/** ISO 8601 con el desfase de Santiago (p. ej. 2026-10-04T13:20:05-03:00). */
export function isoSantiago(d = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const off = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}
