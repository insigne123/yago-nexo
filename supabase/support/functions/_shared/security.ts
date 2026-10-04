// Comparación en tiempo constante, secreto compartido de cron y firma de webhooks de Meta.

const encoder = new TextEncoder();

/** Compara dos cadenas sin cortar en la primera diferencia (evita ataques de tiempo). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const length = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export type SecretCheck = "ok" | "sin_configurar" | "no_autorizado";

/**
 * Verifica la cabecera de secreto compartido (x-nexo-cron-secret o la que se indique)
 * contra el valor de la variable de entorno. Si la variable no existe, se rechaza todo:
 * una función invocada por cron nunca queda abierta por olvido.
 */
export function checkSharedSecret(
  req: Request,
  expected: string | undefined,
  header = "x-nexo-cron-secret",
): SecretCheck {
  if (!expected) return "sin_configurar";
  const received = req.headers.get(header);
  if (!received) return "no_autorizado";
  return timingSafeEqual(received, expected) ? "ok" : "no_autorizado";
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(secret: string, payload: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof payload === "string" ? encoder.encode(payload) : new Uint8Array(payload);
  return toHex(await crypto.subtle.sign("HMAC", key, data));
}

export async function sha256Hex(payload: Uint8Array | string): Promise<string> {
  const data = typeof payload === "string" ? encoder.encode(payload) : new Uint8Array(payload);
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

/**
 * Valida X-Hub-Signature-256 ("sha256=<hex>") de la API de WhatsApp Cloud: HMAC-SHA256 del
 * cuerpo crudo con el App Secret de la aplicación de Meta.
 */
export async function verifyMetaSignature(
  rawBody: Uint8Array,
  header: string | null,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(header.slice("sha256=".length).toLowerCase(), expected);
}
