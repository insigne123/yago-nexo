import createClient, { type Middleware } from "openapi-fetch";
import { ApiError, toApiError } from "./errors";
import type { paths } from "./schema";

export type ApiClient = ReturnType<typeof createClient<paths>>;

export interface ApiOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => void;
}

interface ApiContext {
  client: ApiClient;
  options: ApiOptions;
}

let context: ApiContext | null = null;

/** Crea el cliente tipado (openapi-fetch) que agrega `Authorization: Bearer <token>`. */
export function configureApi(options: ApiOptions): ApiClient {
  // fetch se resuelve en cada llamada para que los interceptores (MSW) lo encuentren.
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    fetch: (request) => globalThis.fetch(request),
  });
  const auth: Middleware = {
    async onRequest({ request }) {
      const token = await options.getToken();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) options.onUnauthorized?.();
      return undefined;
    },
  };
  client.use(auth);
  context = { client, options };
  return client;
}

export function api(): ApiClient {
  if (!context) throw new Error("El cliente de la API no está configurado.");
  return context.client;
}

export function apiBaseUrl(): string {
  if (!context) throw new Error("El cliente de la API no está configurado.");
  return context.options.baseUrl;
}

/**
 * fetch autenticado para lo que no pasa por el contrato tipado: descargas de paquetes y
 * herramientas exclusivas del modo simulado. Acepta rutas relativas a la API o URLs completas.
 */
export async function authorizedFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  if (!context) throw new Error("El cliente de la API no está configurado.");
  const { options } = context;
  const url =
    /^https?:\/\//.test(pathOrUrl) || pathOrUrl.startsWith("/")
      ? pathOrUrl
      : `${options.baseUrl}/${pathOrUrl}`;
  const headers = new Headers(init.headers);
  const token = await options.getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await globalThis.fetch(url, { ...init, headers });
  } catch {
    throw new ApiError(0, "No se pudo conectar con la API de la Consola.");
  }
  if (response.status === 401) options.onUnauthorized?.();
  if (!response.ok) {
    const type = response.headers.get("content-type") ?? "";
    const body: unknown = type.includes("json")
      ? await response.json().catch(() => null)
      : await response.text();
    throw toApiError(response.status, body);
  }
  return response;
}
