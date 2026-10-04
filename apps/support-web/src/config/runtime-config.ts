import { z } from "zod";

/**
 * Configuración en tiempo de ejecución: se lee de /config.json al iniciar, así el mismo
 * build sirve para cualquier ambiente (Firebase Hosting reemplaza solo ese archivo).
 */
export const runtimeConfigSchema = z.object({
  supabaseUrl: z.url({ protocol: /^https?$/, error: "supabaseUrl debe ser una URL http(s)" }),
  supabaseAnonKey: z.string().min(20, "supabaseAnonKey debe ser la clave publicable (anon) del proyecto"),
  environmentLabel: z.string().trim().min(1).max(40).default("producción"),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export type RuntimeConfigErrorKind = "no_encontrado" | "invalido" | "pendiente";

export class RuntimeConfigError extends Error {
  readonly kind: RuntimeConfigErrorKind;

  constructor(message: string, kind: RuntimeConfigErrorKind) {
    super(message);
    this.name = "RuntimeConfigError";
    this.kind = kind;
  }
}

const PLACEHOLDER = /TU-PROYECTO|REEMPLAZAR/i;

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  const result = runtimeConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new RuntimeConfigError(`config.json no es válido (${detail})`, "invalido");
  }
  if (PLACEHOLDER.test(result.data.supabaseUrl) || PLACEHOLDER.test(result.data.supabaseAnonKey)) {
    throw new RuntimeConfigError("config.json todavía tiene los valores de ejemplo", "pendiente");
  }
  return result.data;
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  url = "/config.json",
): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new RuntimeConfigError("No se pudo leer /config.json", "no_encontrado");
  }
  if (!response.ok)
    throw new RuntimeConfigError(`No se pudo leer /config.json (HTTP ${response.status})`, "no_encontrado");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new RuntimeConfigError("config.json no es JSON válido", "invalido");
  }
  return parseRuntimeConfig(raw);
}
