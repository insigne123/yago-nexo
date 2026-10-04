/**
 * Generador de carga del laboratorio: llamadas continuas a una API a través del gateway, como lo haría un
 * consumidor real, contando por segundo los códigos y la versión del backend que respondió. Cualquier
 * respuesta que no sea 2xx cuenta como error del consumidor (también un 404 o un 503 transitorio).
 */
import { Agent, fetch } from "undici";
import { Wso2Client } from "@nexo/wso2-client";

const insecure = new Agent({ connect: { rejectUnauthorized: false }, connections: 64 });

export async function appToken(appName: string): Promise<string> {
  const wso2 = new Wso2Client({
    baseUrl: process.env.NEXO_WSO2_URL ?? "https://apim:9443",
    auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
    tls: { rejectUnauthorized: false },
  });
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === appName);
  if (!app) throw new Error(`no existe la aplicación ${appName}`);
  const key = (await wso2.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak");
  const res = await fetch(`${process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo"}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key?.consumerKey}:${key?.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

export interface LoadSecond {
  t: number;
  ok: number;
  errores: number;
  versiones: Record<string, number>;
}

export interface LoadResult {
  llamadas: number;
  ok: number;
  errores: number;
  sinRespuesta: number;
  porVersion: Record<string, number>;
  porCodigo: Record<string, number>;
  duracionSeg: number;
  tasaError: number;
  timeline: LoadSecond[];
}

export interface LoadOptions {
  url: string;
  rps: number;
  seconds: number;
  app?: string;
  onSecond?: (s: LoadSecond) => void;
  /** Permite detener la carga antes de tiempo. */
  signal?: AbortSignal;
}

export async function runLoad(o: LoadOptions): Promise<LoadResult> {
  const app = o.app ?? "OperadorDemo";
  let token = await appToken(app);
  let tokenAt = Date.now();
  const total: Omit<LoadResult, "duracionSeg" | "tasaError" | "timeline"> = { llamadas: 0, ok: 0, errores: 0, sinRespuesta: 0, porVersion: {}, porCodigo: {} };
  const timeline: LoadSecond[] = [];
  const t0 = Date.now();
  for (let s = 0; s < o.seconds && !o.signal?.aborted; s++) {
    if (Date.now() - tokenAt > 240_000) {
      token = await appToken(app);
      tokenAt = Date.now();
    }
    const second: LoadSecond = { t: s, ok: 0, errores: 0, versiones: {} };
    const started = Date.now();
    await Promise.all(
      Array.from({ length: o.rps }, async (_, i) => {
        await new Promise((r) => setTimeout(r, (1000 / o.rps) * i));
        try {
          const res = await fetch(o.url, { dispatcher: insecure, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
          await res.arrayBuffer();
          const v = res.headers.get("x-backend-version") ?? "—";
          total.llamadas++;
          total.porCodigo[res.status] = (total.porCodigo[res.status] ?? 0) + 1;
          if (res.status >= 200 && res.status < 300) {
            total.ok++;
            second.ok++;
            total.porVersion[v] = (total.porVersion[v] ?? 0) + 1;
            second.versiones[v] = (second.versiones[v] ?? 0) + 1;
          } else {
            total.errores++;
            second.errores++;
          }
        } catch {
          total.llamadas++;
          total.sinRespuesta++;
          total.errores++;
          second.errores++;
        }
      }),
    );
    timeline.push(second);
    o.onSecond?.(second);
    const wait = 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return { ...total, duracionSeg: Math.round((Date.now() - t0) / 1000), tasaError: total.llamadas ? total.errores / total.llamadas : 0, timeline };
}
