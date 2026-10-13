import { createHash, timingSafeEqual } from "node:crypto";

/** Token de un encabezado «Authorization: Bearer …» (el esquema no distingue mayúsculas). */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return m?.[1];
}

/**
 * Compara un token con el esperado en tiempo constante: se comparan los SHA-256 de ambos (mismo largo siempre)
 * con timingSafeEqual, así el tiempo de respuesta no revela cuántos caracteres coinciden ni el largo del token.
 * Sin token esperado configurado, nada coincide.
 */
export function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = createHash("sha256")
    .update(provided ?? "")
    .digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
