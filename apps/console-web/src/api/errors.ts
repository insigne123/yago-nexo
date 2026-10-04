import { requiredPermissionText } from "../auth/permissions";

/** Error de la API con el código HTTP y, en un 403, el permiso que faltó. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly permission?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function defaultErrorMessage(status: number): string {
  if (status === 0) return "No se pudo conectar con la API de la Consola.";
  if (status === 400) return "La solicitud no es válida.";
  if (status === 401) return "La sesión no es válida o expiró.";
  if (status === 403) return "No tiene permiso para realizar esta acción.";
  if (status === 404) return "El recurso solicitado no existe.";
  if (status === 409) return "La operación no es compatible con el estado actual.";
  if (status >= 500) return "La API de la Consola respondió con un error. Intente nuevamente.";
  return `La API respondió con el código ${status}.`;
}

export function toApiError(status: number, body: unknown): ApiError {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message =
      typeof record.message === "string" && record.message ? record.message : defaultErrorMessage(status);
    const permission = typeof record.permission === "string" ? record.permission : undefined;
    return new ApiError(status, message, permission);
  }
  if (typeof body === "string" && body.trim()) return new ApiError(status, body.trim().slice(0, 300));
  return new ApiError(status, defaultErrorMessage(status));
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Convierte la respuesta de openapi-fetch en datos o en un ApiError. */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await request;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, defaultErrorMessage(0));
  }
  if (!result.response.ok || result.error !== undefined) {
    throw toApiError(result.response.status, result.error);
  }
  return result.data as T;
}

export function describeError(error: unknown): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      const extra = error.permission ? requiredPermissionText([error.permission]) : "";
      return { title: "Acción no permitida", description: [error.message, extra].filter(Boolean).join(" ") };
    }
    if (error.status === 0) return { title: "Sin conexión con la API", description: error.message };
    if (error.status === 401) return { title: "Sesión no válida", description: error.message };
    return { title: "No se pudo completar la operación", description: error.message };
  }
  return {
    title: "Error inesperado",
    description: error instanceof Error ? error.message : String(error),
  };
}

export function isForbidden(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403;
}
