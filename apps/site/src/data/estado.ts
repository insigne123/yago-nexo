// Acceso tipado a los datos de estado del producto. La fuente única es capacidades.json
// (validado en el build por scripts/check-capacidades.mjs) y release.json.
import capacidadesJson from "./capacidades.json";
import releaseJson from "./release.json";

export type Estado = "Disponible" | "En desarrollo" | "Planificado";

export const ESTADOS: readonly Estado[] = ["Disponible", "En desarrollo", "Planificado"];

export const DESCRIPCION_ESTADO: Record<Estado, string> = {
  Disponible: "Implementado y verificable en el repositorio de esta versión.",
  "En desarrollo": "En construcción; todavía no forma parte de una versión utilizable.",
  Planificado: "Definido en la hoja de ruta; aún no se empieza a construir.",
};

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
    Disponible: lista.filter((c) => c.estado === "Disponible").length,
    "En desarrollo": lista.filter((c) => c.estado === "En desarrollo").length,
    Planificado: lista.filter((c) => c.estado === "Planificado").length,
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
