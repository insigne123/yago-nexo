// Acceso tipado a los datos de estado del producto. La fuente única es capacidades.json
// (validado en el build por scripts/check-capacidades.mjs) y release.json.
import capacidadesJson from "./capacidades.json";
import releaseJson from "./release.json";

/**
 * Dos estados, sin beta ni futuro (la versión ofertada debe ser estable):
 * - "Incluida": forma parte de la versión publicada (release.json) y su evidencia existe en el repositorio.
 * - "Servicio": se entrega con el servicio de implementación (desarrollo contratado, con prueba de aceptación).
 */
export type Estado = "Incluida" | "Servicio";

export const ESTADOS: readonly Estado[] = ["Incluida", "Servicio"];

export interface Grupo {
  id: string;
  nombre: string;
  descripcion: string;
}

export interface Capacidad {
  id: string;
  grupo: string;
  nombre: string;
  descripcion: string;
  estado: Estado;
  evidencia?: string[];
}

export interface Release {
  version: string;
  fecha: string;
  estado: string;
}

export const grupos: readonly Grupo[] = capacidadesJson.grupos;
export const capacidades: readonly Capacidad[] = capacidadesJson.capacidades as unknown as Capacidad[];
export const release: Release = releaseJson;

/** Texto exacto de cada estado, tal como se muestra en las insignias y tablas. */
export const ETIQUETA_ESTADO: Record<Estado, string> = {
  Incluida: `Incluida en ${release.version}`,
  Servicio: "Se entrega con el servicio de implementación (desarrollo contratado, con prueba de aceptación)",
};

export const DESCRIPCION_ESTADO: Record<Estado, string> = {
  Incluida: `Forma parte de la versión ${release.version} publicada; la evidencia está en el repositorio de esa versión.`,
  Servicio:
    "No forma parte de la versión publicada: Yago la desarrolla dentro del servicio de implementación contratado y la entrega con su prueba de aceptación.",
};

export function capacidad(id: string): Capacidad {
  const encontrada = capacidades.find((c) => c.id === id);
  if (!encontrada) throw new Error(`Capacidad desconocida en capacidades.json: "${id}"`);
  return encontrada;
}

export function grupo(id: string): Grupo {
  const encontrado = grupos.find((g) => g.id === id);
  if (!encontrado) throw new Error(`Grupo desconocido en capacidades.json: "${id}"`);
  return encontrado;
}

export function capacidadesDe(grupoId: string): Capacidad[] {
  grupo(grupoId);
  const orden = (c: Capacidad) => ESTADOS.indexOf(c.estado);
  return capacidades.filter((c) => c.grupo === grupoId).sort((a, b) => orden(a) - orden(b));
}

export function conteoPorEstado(lista: readonly Capacidad[] = capacidades): Record<Estado, number> {
  return {
    Incluida: lista.filter((c) => c.estado === "Incluida").length,
    Servicio: lista.filter((c) => c.estado === "Servicio").length,
  };
}

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** "2026-10-04" → "4 de octubre de 2026" (sin depender de la zona horaria ni del navegador). */
export function fechaLarga(iso: string): string {
  const [anio, mes, dia] = iso.split("-").map(Number);
  if (!anio || !mes || !dia) return iso;
  return `${dia} de ${MESES[mes - 1]} de ${anio}`;
}
