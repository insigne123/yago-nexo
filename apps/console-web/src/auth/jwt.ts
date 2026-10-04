/** Utilidades mínimas para leer (no verificar) un JWT en el navegador. La verificación la hace la API. */

function base64UrlToBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Claims = Record<string, unknown>;

export function decodeJwtPayload(token: string | null | undefined): Claims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Claims) : null;
  } catch {
    return null;
  }
}

/** Lee un claim anidado con notación de puntos, por ejemplo `resource_access.nexo-console.roles`. */
export function getClaim(claims: Claims, path: string): unknown {
  let current: unknown = claims;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function rolesFromClaims(claims: Claims | null, paths: readonly string[]): string[] {
  if (!claims) return [];
  for (const path of paths) {
    const value = getClaim(claims, path);
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function stringClaim(claims: Claims | null, ...keys: string[]): string | undefined {
  if (!claims) return undefined;
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
