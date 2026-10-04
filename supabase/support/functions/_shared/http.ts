// Utilidades HTTP comunes de las funciones nexo-sd-*.

const BASE_CORS: Record<string, string> = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-nexo-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
};

/**
 * Cabeceras CORS. Si NEXO_ALLOWED_ORIGINS está definida (lista separada por comas), solo se
 * devuelve el origen cuando está en la lista; si no, se permite cualquier origen (la
 * autorización real es el JWT o el secreto, no CORS).
 */
export function corsHeaders(
  req: Request,
  allowedOrigins = Deno.env.get("NEXO_ALLOWED_ORIGINS"),
): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!allowedOrigins) return { ...BASE_CORS, "Access-Control-Allow-Origin": "*" };
  const list = allowedOrigins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? { ...BASE_CORS, "Access-Control-Allow-Origin": origin } : { ...BASE_CORS };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

/** Mensaje de error sin filtrar detalles internos al cliente. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err)
    return String((err as { message: unknown }).message);
  return String(err);
}

export function log(
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown> = {},
): void {
  // Registro estructurado (Supabase lo muestra en los logs de la función). Sin datos personales.
  console[level === "info" ? "log" : level](JSON.stringify({ nivel: level, mensaje: message, ...data }));
}
