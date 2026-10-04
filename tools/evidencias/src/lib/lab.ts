/**
 * Acceso al laboratorio desde los guiones: tokens de Keycloak (personas y aplicaciones), API de la Consola,
 * cliente de WSO2 y utilidades de Docker. Es el mismo laboratorio que usan las verificaciones de
 * tools/lab-bootstrap; nada aquí simula respuestas.
 */
import { execFileSync } from "node:child_process";
import { Agent, fetch } from "undici";
import { Wso2Client } from "@nexo/wso2-client";

export const CONSOLA_API = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
export const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
export const CLAVE_LAB = () => process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
export const GATEWAY = "https://apim:8243";
export const inseguro = new Agent({ connect: { rejectUnauthorized: false } });
export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function wso2(): Wso2Client {
  return new Wso2Client({
    baseUrl: "https://apim:9443",
    auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
    tls: { rejectUnauthorized: false },
  });
}

/** Token de una persona del realm (cliente nexo-console, el mismo de la Consola). */
export async function tokenPersona(usuario: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", username: usuario, password: CLAVE_LAB() }).toString(),
  });
  const b = (await res.json()) as { access_token?: string; error_description?: string };
  if (!b.access_token) throw new Error(`Keycloak no entregó token para ${usuario}: ${b.error_description ?? res.status}`);
  return b.access_token;
}

/** Token client_credentials de una aplicación del Dev Portal con llaves en Keycloak. */
export async function tokenAplicacion(credenciales: { consumerKey: string; consumerSecret: string }): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${credenciales.consumerKey}:${credenciales.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  const b = (await res.json()) as { access_token?: string; error_description?: string };
  if (!b.access_token) throw new Error(`Keycloak no entregó token de aplicación: ${b.error_description ?? res.status}`);
  return b.access_token;
}

export async function credencialesDe(appName: string): Promise<{ consumerKey: string; consumerSecret: string; applicationId: string }> {
  const w = wso2();
  const app = (await w.devportal.listApplications()).list.find((a) => a.name === appName);
  if (!app) throw new Error(`no existe la aplicación ${appName}`);
  const key = (await w.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION");
  if (!key?.consumerKey || !key.consumerSecret) throw new Error(`la aplicación ${appName} no tiene llaves de producción en Keycloak`);
  return { consumerKey: key.consumerKey, consumerSecret: key.consumerSecret, applicationId: app.applicationId };
}

export interface Respuesta<T> {
  status: number;
  data: T;
  texto: string;
  headers: Headers;
}

/** Llamada a la API de la Consola con el token de una persona. */
export async function consola<T = unknown>(token: string, metodo: string, ruta: string, cuerpo?: unknown): Promise<Respuesta<T>> {
  const res = await fetch(`${CONSOLA_API}${ruta}`, {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, ...(cuerpo !== undefined ? { "content-type": "application/json" } : {}) },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let data: unknown = texto;
  try {
    data = JSON.parse(texto);
  } catch {
    /* texto plano o CSV */
  }
  return { status: res.status, data: data as T, texto, headers: res.headers as unknown as Headers };
}

/** Llamada a una API a través del gateway de WSO2. */
export async function gateway(url: string, init: { metodo?: string; token?: string; cuerpo?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(url.startsWith("http") ? url : `${GATEWAY}${url}`, {
    method: init.metodo ?? "GET",
    dispatcher: inseguro,
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cuerpo !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.cuerpo !== undefined ? (typeof init.cuerpo === "string" ? init.cuerpo : JSON.stringify(init.cuerpo)) : undefined,
  });
  const texto = await res.text();
  let data: unknown = texto;
  try {
    data = JSON.parse(texto);
  } catch {
    /* no es JSON */
  }
  return { status: res.status, data, texto, headers: res.headers };
}

export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export const contenedor = (servicio: string) => `nexo-lab-${servicio}-1`;

/** Consulta SQL puntual a la base de la Consola (psql dentro del contenedor de PostgreSQL). */
export function sqlConsola(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${process.env.NEXO_DB_PASSWORD ?? ""}`, contenedor("postgres"), "psql", "-U", "nexo", "-d", "nexo", "-h", "localhost", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}
