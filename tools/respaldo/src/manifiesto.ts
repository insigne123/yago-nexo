// Manifiesto de un respaldo: qué se respaldó, con qué versión, cuántas filas tenía cada tabla en
// el instante del snapshot y la suma SHA-256 de cada archivo cifrado. Va firmado con HMAC-SHA256
// (clave derivada de la clave maestra): la prueba de restauración compara contra cifras auténticas.
import { ALGORITMO, ESQUEMA, firmar, firmaValida, KDF } from "./cifrado.js";

export const FORMATO_MANIFIESTO = "nexo-respaldo/1";
export const ARCHIVO_MANIFIESTO = "manifiesto.json";

export interface Artefacto {
  /** Ruta relativa a la carpeta del respaldo. */
  archivo: string;
  /** Tamaño del archivo cifrado. */
  bytes: number;
  bytesSinCifrar: number;
  /** SHA-256 del archivo cifrado, tal como queda en disco. */
  sha256: string;
}

export interface ConteoTabla {
  esquema: string;
  tabla: string;
  filas: number;
  /** Huella del contenido, independiente del orden de las filas (opcional). */
  huella?: string;
}

/** Estado de la cadena de auditoría de la Consola (tabla nexo.audit_event) en el snapshot. */
export interface SondaAuditoria {
  eventos: number;
  ultimoSeq: number | null;
  ultimoHash: string | null;
}

export interface BaseRespaldada extends Artefacto {
  nombre: string;
  snapshot: string;
  /** Instante del snapshot (inicio de la transacción que lo exportó). */
  instanteSnapshot: string;
  /** Posición del WAL en ese instante: permite combinarlo con el archivo continuo de WAL. */
  lsn: string | null;
  duracionMs: number;
  tablas: ConteoTabla[];
  totalFilas: number;
  sondas: { auditoria?: SondaAuditoria };
}

export interface ServidorRespaldado {
  nombre: string;
  versionPg: string;
  versionPgNum: number;
  globales: (Artefacto & { instante: string }) | null;
  bases: BaseRespaldada[];
}

export interface Manifiesto {
  formato: typeof FORMATO_MANIFIESTO;
  id: string;
  herramienta: { nombre: string; version: string };
  modo: "docker" | "local";
  inicio: string;
  fin: string;
  duracionMs: number;
  versionPgDump: string;
  huellaContenido: boolean;
  cifrado: { algoritmo: string; esquema: string; kdf: string; tamanoBloque: number; huellaClave: string };
  servidores: ServidorRespaldado[];
  totales: { servidores: number; bases: number; tablas: number; filas: number; bytes: number };
  firma: { algoritmo: "HMAC-SHA256"; valor: string };
}

export type DatosManifiesto = Omit<Manifiesto, "formato" | "totales" | "firma" | "cifrado"> & {
  cifrado: { tamanoBloque: number; huellaClave: string };
};

/** JSON con las claves ordenadas: la firma no depende del orden en que se armó el objeto. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor) ?? "null";
  if (Array.isArray(valor))
    return `[${valor.map((v) => (v === undefined ? "null" : jsonCanonico(v))).join(",")}]`;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`;
}

function sinFirma(m: Omit<Manifiesto, "firma"> & { firma?: unknown }): Omit<Manifiesto, "firma"> {
  const { firma: _firma, ...resto } = m;
  return resto;
}

export function calcularTotales(servidores: ServidorRespaldado[]): Manifiesto["totales"] {
  let bases = 0;
  let tablas = 0;
  let filas = 0;
  let bytes = 0;
  for (const s of servidores) {
    bytes += s.globales?.bytes ?? 0;
    for (const b of s.bases) {
      bases++;
      tablas += b.tablas.length;
      filas += b.totalFilas;
      bytes += b.bytes;
    }
  }
  return { servidores: servidores.length, bases, tablas, filas, bytes };
}

/** Arma el manifiesto completo (totales y firma) a partir de los datos del respaldo. */
export function construirManifiesto(datos: DatosManifiesto, clave: Buffer): Manifiesto {
  const base: Omit<Manifiesto, "firma"> = {
    formato: FORMATO_MANIFIESTO,
    ...datos,
    cifrado: { algoritmo: ALGORITMO, esquema: ESQUEMA, kdf: KDF, ...datos.cifrado },
    totales: calcularTotales(datos.servidores),
  };
  return { ...base, firma: { algoritmo: "HMAC-SHA256", valor: firmar(clave, jsonCanonico(base)) } };
}

export class ErrorManifiesto extends Error {}

/**
 * Valida la forma del manifiesto leído de disco y su firma. Lanza ErrorManifiesto si no es un
 * manifiesto de esta herramienta, si se cifró con otra clave o si fue modificado.
 */
export function verificarManifiesto(datos: unknown, clave: Buffer, huellaEsperada: string): Manifiesto {
  if (!datos || typeof datos !== "object") throw new ErrorManifiesto("el manifiesto no es un objeto JSON");
  const m = datos as Partial<Manifiesto>;
  if (m.formato !== FORMATO_MANIFIESTO)
    throw new ErrorManifiesto(`formato de manifiesto desconocido: ${String(m.formato)}`);
  if (!Array.isArray(m.servidores) || typeof m.id !== "string")
    throw new ErrorManifiesto("manifiesto incompleto");
  if (m.cifrado?.huellaClave !== huellaEsperada) {
    throw new ErrorManifiesto(
      `el respaldo se cifró con otra clave (huella ${String(m.cifrado?.huellaClave)}; la clave configurada tiene huella ${huellaEsperada})`,
    );
  }
  if (m.firma?.algoritmo !== "HMAC-SHA256" || typeof m.firma.valor !== "string")
    throw new ErrorManifiesto("el manifiesto no está firmado");
  if (!firmaValida(clave, jsonCanonico(sinFirma(m as Manifiesto)), m.firma.valor)) {
    throw new ErrorManifiesto("la firma del manifiesto no coincide: el manifiesto fue modificado");
  }
  return m as Manifiesto;
}

/** Todos los artefactos del manifiesto, en el orden en que se restauran. */
export function artefactos(m: Manifiesto): Artefacto[] {
  return m.servidores.flatMap((s) => [...(s.globales ? [s.globales] : []), ...s.bases]);
}

// ------------------------------------------------------------------ identificadores

const PATRON_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** Identificador de respaldo a partir de su instante de inicio, en UTC: 20261004T163012Z. */
export function idDeFecha(fecha: Date): string {
  return fecha
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function fechaDeId(id: string): Date | undefined {
  const m = PATRON_ID.exec(id);
  if (!m) return undefined;
  const [, a, me, d, h, mi, s] = m;
  const fecha = new Date(`${a}-${me}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(fecha.getTime()) ? undefined : fecha;
}

/** Nombre de archivo seguro para una base de datos (los nombres de PostgreSQL admiten casi todo). */
export function nombreArchivo(nombre: string): string {
  const limpio = nombre.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
  return limpio === nombre ? limpio : `${limpio}-${Buffer.from(nombre, "utf8").toString("hex").slice(0, 12)}`;
}
