import { z } from "zod";

/**
 * Configuración en tiempo de ejecución (`/config.json`).
 *
 * El mismo build corre en la demo (Firebase Hosting) y en los servidores de SUBTEL; lo que
 * cambia entre ambientes (URL de la API, proveedor de identidad, rótulos) se lee al iniciar.
 */

const OidcSchema = z.object({
  authority: z.url({ error: "debe ser una URL válida" }),
  clientId: z.string().min(1, "es obligatorio"),
  rolesClaimPath: z.string().min(1).default("resource_access.nexo-console.roles"),
  scope: z.string().min(1).default("openid profile email"),
});

const SupabaseSchema = z.object({
  url: z.url({ error: "debe ser una URL válida" }),
  anonKey: z.string().min(1, "es obligatorio"),
  /** Si el proyecto exige MFA, un usuario sin factor TOTP debe enrolarse antes de entrar. */
  requireMfa: z.boolean().default(true),
  rolesClaimPath: z.string().min(1).default("app_metadata.roles"),
});

export type OidcConfig = z.infer<typeof OidcSchema>;
export type SupabaseConfig = z.infer<typeof SupabaseSchema>;

export type AuthConfig =
  | { provider: "mock" }
  | { provider: "oidc"; oidc: OidcConfig }
  | { provider: "supabase"; supabase: SupabaseConfig };

export type AuthProviderKind = AuthConfig["provider"];

const AuthSchema = z
  .object({
    provider: z.enum(["mock", "oidc", "supabase"], {
      error: 'debe ser "mock", "oidc" o "supabase"',
    }),
    oidc: z.unknown().optional(),
    supabase: z.unknown().optional(),
  })
  .transform((auth, ctx): AuthConfig => {
    // Solo se valida el bloque del proveedor elegido: los otros pueden quedar como ejemplo.
    if (auth.provider === "mock") return { provider: "mock" };
    const key = auth.provider;
    const schema = key === "oidc" ? OidcSchema : SupabaseSchema;
    const parsed = schema.safeParse(auth[key] ?? undefined);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: [key, ...issue.path.map(String)] });
      }
      return z.NEVER;
    }
    return key === "oidc"
      ? { provider: "oidc", oidc: parsed.data as OidcConfig }
      : { provider: "supabase", supabase: parsed.data as SupabaseConfig };
  });

const RuntimeConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .min(1)
    .default("/api/v1")
    .transform((v) => v.replace(/\/+$/, "")),
  environmentLabel: z.string().min(1).default("Laboratorio Yago"),
  version: z.string().min(1).default("1.0.0"),
  auth: AuthSchema,
  demoBanner: z.boolean().default(false),
});

export type RuntimeConfig = Readonly<z.infer<typeof RuntimeConfigSchema>>;

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Valida un objeto ya leído (útil en pruebas y para mensajes de error claros). */
export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const parsed = RuntimeConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      "La configuración de la Consola (config.json) no es válida.",
      formatIssues(parsed.error),
    );
  }
  return Object.freeze(parsed.data);
}

export interface LoadOptions {
  url?: string;
  fetchImpl?: typeof fetch;
}

export function defaultConfigUrl(): string {
  return `${import.meta.env.BASE_URL}config.json`;
}

/** Descarga y valida `/config.json`. Lanza ConfigError con un mensaje legible si falla. */
export async function loadRuntimeConfig(options: LoadOptions = {}): Promise<RuntimeConfig> {
  const url = options.url ?? defaultConfigUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new ConfigError(`No se pudo descargar ${url}. Revise la conexión con el servidor.`);
  }
  if (!response.ok) {
    throw new ConfigError(`No se pudo descargar ${url} (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConfigError(`${url} no contiene JSON válido.`);
  }
  return parseRuntimeConfig(body);
}

const MOCK_FLAG_KEY = "nexo-mock";

/**
 * Modo de datos simulados (MSW): siempre con el proveedor "mock", o al abrir la Consola con
 * `?mock=1` (se recuerda en la pestaña para sobrevivir a la redirección de OIDC; `?mock=0` lo apaga).
 */
export function resolveMockMode(
  config: RuntimeConfig,
  location: Pick<Location, "search">,
  storage?: Storage,
): boolean {
  if (config.auth.provider === "mock") return true;
  const flag = new URLSearchParams(location.search).get("mock");
  try {
    if (flag === "1" || flag === "true") storage?.setItem(MOCK_FLAG_KEY, "1");
    if (flag === "0" || flag === "false") storage?.removeItem(MOCK_FLAG_KEY);
    return storage?.getItem(MOCK_FLAG_KEY) === "1" || flag === "1" || flag === "true";
  } catch {
    return flag === "1" || flag === "true";
  }
}
