import { Agent, fetch, FormData, type RequestInit, type Response } from "undici";

export interface TlsOptions {
  /** En laboratorio WSO2 usa certificados autofirmados. En producción se entrega la CA de SUBTEL. */
  rejectUnauthorized?: boolean;
  ca?: string;
}

export class Wso2HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`WSO2 ${method} ${url} → ${status}: ${body.slice(0, 500)}`);
    this.name = "Wso2HttpError";
  }
}

export function createAgent(tls: TlsOptions = {}): Agent {
  return new Agent({
    connect: {
      rejectUnauthorized: tls.rejectUnauthorized ?? true,
      ...(tls.ca ? { ca: tls.ca } : {}),
    },
  });
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  urlencoded?: Record<string, string>;
  /** Devuelve el cuerpo como Buffer (exportaciones .zip, SDK). */
  binary?: boolean;
  /** Códigos aceptados además de 2xx. */
  accept?: number[];
}

export async function httpRequest<T>(agent: Agent, req: HttpRequest): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  const init: RequestInit = { method: req.method, headers, dispatcher: agent };
  if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.json);
  } else if (req.form) {
    init.body = req.form;
  } else if (req.urlencoded) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(req.urlencoded).toString();
  }
  if (req.binary) headers.accept = "*/*";
  const res: Response = await fetch(req.url, init);
  if (!res.ok && !(req.accept ?? []).includes(res.status)) {
    throw new Wso2HttpError(res.status, req.method, req.url, await res.text());
  }
  if (req.binary) return Buffer.from(await res.arrayBuffer()) as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? JSON.parse(text) : text) as T;
}

export { FormData };
