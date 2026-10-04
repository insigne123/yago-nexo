import { fetch } from "undici";

/** Cliente mínimo de OpenSearch para las consultas de agregación de los motores. */
export class OpenSearch {
  private readonly auth?: string;

  constructor(
    private readonly baseUrl: string,
    user?: string,
    password?: string,
  ) {
    if (user && password) this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  }

  async search<T>(index: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${index}/_search?ignore_unavailable=true&allow_no_indices=true`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.auth ? { authorization: this.auth } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenSearch respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}

/** Percentil desde una agregación "percentiles" (OpenSearch usa la clave "99.0"). */
export function percentile(values: Record<string, number | null> | undefined, p: number): number | undefined {
  if (!values) return undefined;
  const v = values[p.toFixed(1)] ?? values[String(p)];
  return v == null || Number.isNaN(v) ? undefined : v;
}
