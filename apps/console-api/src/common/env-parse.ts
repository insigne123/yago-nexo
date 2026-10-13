/** Lectura estricta de variables de entorno de la API (fallan al arrancar con un mensaje claro). */

/** Entero entre `min` y `max` (ambos incluidos). */
export function integerInRange(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} debe ser un número entero entre ${min} y ${max} (se recibió «${raw}»)`);
  return n;
}

/**
 * Valor de «trust proxy» de Express a partir de NEXO_TRUST_PROXY: decide qué saltos de X-Forwarded-For se creen
 * para calcular la IP de origen que queda en la auditoría.
 *
 * - vacío, «false» o «0»: no se cree a ningún proxy; la IP es la de la conexión (la API expuesta directamente,
 *   como en el laboratorio de Compose). Un cliente no puede elegir su IP con el encabezado.
 * - un entero N: se cree a los N proxies más cercanos (p. ej., 1 con un ingress delante, como en el chart).
 * - una lista de IP o rangos CIDR separados por coma: se cree solo a esos proxies.
 *
 * «true» (creerle a cualquiera) se rechaza: permitiría que cualquier cliente fije su IP con X-Forwarded-For.
 */
export function trustProxySetting(raw: string | undefined): false | number | string[] {
  const v = (raw ?? "").trim();
  if (!v || v === "false" || v === "0") return false;
  if (v === "true")
    throw new Error(
      "NEXO_TRUST_PROXY=true permitiría que cualquier cliente fije su IP con X-Forwarded-For; indique la cantidad de proxies (p. ej., 1) o sus rangos CIDR",
    );
  if (/^\d+$/.test(v)) return integerInRange("NEXO_TRUST_PROXY", v, 1, 10);
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of list)
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(item))
      throw new Error(`NEXO_TRUST_PROXY: «${item}» no es una IP ni un rango CIDR`);
  return list;
}
