/**
 * Datos de la grabación: rutas del repositorio, versión y commits de Nexo, máquina y ambiente.
 * Las credenciales del laboratorio se leen de deploy/compose/.env (las mismas que usa `make`).
 *
 * Regla de versión (V10, §5.3.5): un video oficial se graba desde un worktree cuyo HEAD es la etiqueta de la
 * versión (p. ej. v1.2.0) más, a lo sumo, cambios en tools/evidencias y tools/aceptacion, y sin cambios sin
 * confirmar. El rótulo lleva dos commits: el del producto (la etiqueta) y el de las herramientas de grabación
 * (HEAD). La versión que se muestra («Yago Nexo 1.2.0») se lee del package.json raíz y debe coincidir con la
 * etiqueta.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const desdeRaiz = (...p: string[]) => resolve(RAIZ, ...p);
export const PAQUETE = desdeRaiz("tools/evidencias");
export const SALIDA = desdeRaiz("release/evidencias");
/**
 * Salida de los ensayos: una subcarpeta (fuera de git) que copiar-evidencias.mjs no recorre y que nunca entra en
 * evidencias.json; cada archivo además va rotulado ENSAYO y su pasos.json dice ensayo:true.
 */
export const SALIDA_ENSAYO = desdeRaiz("release/evidencias/ensayo");
export const ZONA = "America/Santiago";
export const PRODUCTO = "Yago Nexo";
export const ETIQUETA_POR_DEFECTO = "v1.2.0";
/** Rutas que pueden diferir de la etiqueta en el worktree de grabación. */
export const EXCLUIDAS_DE_LA_ETIQUETA = ["tools/evidencias", "tools/aceptacion"];
/** Archivos que escribe la propia grabación (no cuentan como cambios sin confirmar). */
export const SALIDAS_DE_GRABACION = ["release/evidencias", "apps/site/src/data/evidencias.json", "apps/site/src/data/SHA256SUMS"];

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
  return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Versión del producto: la del package.json raíz. */
export function leerVersion(raiz = RAIZ): string {
  return (JSON.parse(readFileSync(resolve(raiz, "package.json"), "utf8")) as { version: string }).version;
}

export interface RevisionEtiqueta {
  etiqueta: string;
  existe: boolean;
  /** Commit de la etiqueta (completo y corto). */
  commit?: string;
  commitCorto?: string;
  /** Versión del package.json raíz en la etiqueta. */
  versionEtiqueta?: string;
  /** Archivos que difieren entre la etiqueta y HEAD fuera de las rutas permitidas. */
  diferencias: string[];
  /** Cambios sin confirmar (fuera de las salidas de la propia grabación). */
  sinConfirmar: string[];
  head: string;
  headCorto: string;
}

/** Cambios sin confirmar del árbol de trabajo, sin contar lo que escribe la grabación. */
export function cambiosSinConfirmar(): string[] {
  // Sin trim: la primera columna de --porcelain puede ser un espacio (« M archivo»).
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: RAIZ, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !SALIDAS_DE_GRABACION.some((s) => f === s || f.startsWith(`${s}/`) || f.startsWith(s)));
}

/** Compara el worktree con la etiqueta: `git diff --quiet <etiqueta> HEAD -- . ':(exclude)tools/evidencias' …`. */
export function revisarEtiqueta(etiqueta: string): RevisionEtiqueta {
  const head = git("rev-parse", "HEAD");
  const base: RevisionEtiqueta = { etiqueta, existe: false, diferencias: [], sinConfirmar: cambiosSinConfirmar(), head, headCorto: head.slice(0, 7) };
  const r = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${etiqueta}^{commit}`], { cwd: RAIZ, encoding: "utf8" });
  if (r.status !== 0) return base;
  const commit = r.stdout.trim();
  const excluir = EXCLUIDAS_DE_LA_ETIQUETA.map((p) => `:(exclude)${p}`);
  const diff = spawnSync("git", ["diff", "--quiet", etiqueta, "HEAD", "--", ".", ...excluir], { cwd: RAIZ });
  const diferencias = diff.status === 0 ? [] : git("diff", "--name-only", etiqueta, "HEAD", "--", ".", ...excluir).split("\n").filter(Boolean);
  let versionEtiqueta: string | undefined;
  try {
    versionEtiqueta = (JSON.parse(git("show", `${etiqueta}:package.json`)) as { version?: string }).version;
  } catch {
    versionEtiqueta = undefined;
  }
  return { ...base, existe: true, commit, commitCorto: commit.slice(0, 7), versionEtiqueta, diferencias };
}

/** Por qué no se puede grabar en modo oficial (vacío: se puede). */
export function problemasModoOficial(r: RevisionEtiqueta, version: string): string[] {
  const p: string[] = [];
  if (!r.existe) {
    p.push(`la etiqueta ${r.etiqueta} no existe: publique la versión (o indique otra con --etiqueta) o use --ensayo para iterar sin laboratorio`);
    return p;
  }
  const esperada = r.etiqueta.replace(/^v/, "");
  if (r.versionEtiqueta !== esperada) p.push(`la etiqueta ${r.etiqueta} tiene version ${r.versionEtiqueta ?? "?"} en package.json (se espera ${esperada})`);
  if (version !== esperada) p.push(`package.json dice ${version} y la etiqueta es ${r.etiqueta}`);
  if (r.diferencias.length)
    p.push(
      `HEAD difiere de ${r.etiqueta} fuera de ${EXCLUIDAS_DE_LA_ETIQUETA.join(" y ")} (${r.diferencias.length} archivos: ${r.diferencias.slice(0, 5).join(", ")}${r.diferencias.length > 5 ? "…" : ""}); grabe desde un worktree limpio de la etiqueta`,
    );
  if (r.sinConfirmar.length)
    p.push(`hay cambios sin confirmar (${r.sinConfirmar.slice(0, 5).join(", ")}${r.sinConfirmar.length > 5 ? "…" : ""}); el commit de herramientas no los identificaría`);
  return p;
}

export interface Meta {
  version: string;
  /** Commit del producto (= commitProducto; se mantiene por compatibilidad con evidencias.json). */
  commit: string;
  commitCompleto: string;
  /** Commit de la etiqueta de la versión (en ensayo sin etiqueta: HEAD). */
  commitProducto: string;
  /** Commit de las herramientas de grabación (HEAD). */
  commitHerramientas: string;
  etiqueta: string;
  etiquetaExiste: boolean;
  /** Cambios sin confirmar en el árbol de trabajo al grabar (en modo oficial no se permiten). */
  cambiosLocales: string[];
  maquina: string;
  ambiente: string;
  ensayo: boolean;
}

export function metaGrabacion(o: { ensayo: boolean; etiqueta?: string }): Meta {
  const etiqueta = o.etiqueta ?? ETIQUETA_POR_DEFECTO;
  const r = revisarEtiqueta(etiqueta);
  const maquina = hostname();
  const productoCompleto = r.commit ?? r.head;
  return {
    version: leerVersion(),
    commit: productoCompleto.slice(0, 7),
    commitCompleto: productoCompleto,
    commitProducto: productoCompleto.slice(0, 7),
    commitHerramientas: r.headCorto,
    etiqueta,
    etiquetaExiste: r.existe,
    cambiosLocales: r.sinConfirmar,
    maquina,
    ambiente: o.ensayo ? `ENSAYO sin laboratorio · servidor de ensayo local · ${maquina}` : `Laboratorio Yago Nexo · Docker Compose · ${maquina}`,
    ensayo: o.ensayo,
  };
}

/** Compatibilidad: metadatos de una grabación oficial con la etiqueta por defecto. */
export function meta(): Meta {
  return metaGrabacion({ ensayo: false });
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
