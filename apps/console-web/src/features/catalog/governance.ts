import type { ApiAsset } from "../../api/types";

/**
 * Los 8 campos de gobierno de la ficha de una API (BT-018). La completitud es el porcentaje de
 * campos con valor; la API la informa en `completeness` y en `missingFields`.
 */
export const GOVERNANCE_FIELDS = [
  { key: "purpose", label: "Propósito" },
  { key: "ownerTeam", label: "Equipo dueño" },
  { key: "ownerContact", label: "Contacto del dueño" },
  { key: "audience", label: "Audiencia" },
  { key: "classification", label: "Clasificación de los datos" },
  { key: "contractRef", label: "Contrato versionado (repositorio@commit)" },
  { key: "authType", label: "Tipo de autenticación" },
  { key: "version", label: "Versión" },
] as const satisfies ReadonlyArray<{ key: keyof ApiAsset; label: string }>;

export type GovernanceKey = (typeof GOVERNANCE_FIELDS)[number]["key"];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");

/** Estado de cada campo: falta si la API lo declara faltante o si viene vacío. */
export function governanceChecklist(
  asset: ApiAsset,
  missingFields: readonly string[] = [],
): Array<{ key: GovernanceKey; label: string; complete: boolean }> {
  const missing = new Set(missingFields.map(normalize));
  return GOVERNANCE_FIELDS.map((field) => {
    const value = asset[field.key];
    const declaredMissing = missing.has(normalize(field.key)) || missing.has(normalize(field.label));
    const empty = value === undefined || value === null || String(value).trim() === "";
    return { key: field.key, label: field.label, complete: !declaredMissing && !empty };
  });
}

/** Etiqueta legible de un campo faltante informado por la API (clave o texto libre). */
export function missingFieldLabel(field: string): string {
  const match = GOVERNANCE_FIELDS.find((f) => normalize(f.key) === normalize(field));
  return match?.label ?? field;
}
