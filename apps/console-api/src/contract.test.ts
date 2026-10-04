/**
 * Contrato ↔ implementación: cada operación de openapi.yaml está implementada con el mismo método y código
 * de éxito, y no hay rutas fuera del contrato. Lee los metadatos de ruta de los controladores de Nest.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { parse } from "yaml";

const HTTP = ["get", "post", "put", "delete", "patch"] as const;
// Valores de RequestMethod en @nestjs/common.
const METHOD_NAME: Record<number, string> = { 0: "get", 1: "post", 2: "put", 3: "delete", 4: "patch" };

type Route = { method: string; path: string; code: number };

let routes: Route[] = [];
let contract: Route[] = [];

beforeAll(async () => {
  process.env.NEXO_DATABASE_URL ??= "postgres://contrato@localhost:1/contrato";
  for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"]) process.env[k] ??= "prueba-de-contrato";
  const { AppModule } = await import("./app.module.js");
  const controllers = (Reflect.getMetadata("controllers", AppModule) ?? []) as Array<new (...a: never[]) => object>;
  for (const ctrl of controllers) {
    const base = String(Reflect.getMetadata("path", ctrl) ?? "/");
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof handler !== "function" || name === "constructor") continue;
      const method = Reflect.getMetadata("method", handler) as number | undefined;
      const sub = Reflect.getMetadata("path", handler) as string | undefined;
      if (method === undefined || sub === undefined) continue;
      const path = `/${[base, sub].map((p) => p.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`.replace(/:(\w+)/g, "{$1}");
      const verb = METHOD_NAME[method]!;
      const code = (Reflect.getMetadata("__httpCode__", handler) as number | undefined) ?? (verb === "post" ? 201 : 200);
      routes.push({ method: verb, path, code });
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const doc = parse(readFileSync(join(here, "..", "openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const verb of HTTP) {
      const op = ops[verb];
      if (!op) continue;
      const success = Object.keys(op.responses).map(Number).filter((c) => c >= 200 && c < 300);
      contract.push({ method: verb, path, code: success[0]! });
    }
  }
  routes = routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  contract = contract.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
});

describe("contrato OpenAPI de la Consola", () => {
  it("toda operación del contrato está implementada", () => {
    const impl = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(contract.filter((c) => !impl.has(`${c.method} ${c.path}`))).toEqual([]);
  });

  it("no hay rutas fuera del contrato", () => {
    const documented = new Set(contract.map((c) => `${c.method} ${c.path}`));
    expect(routes.filter((r) => !documented.has(`${r.method} ${r.path}`))).toEqual([]);
  });

  it("los códigos de éxito coinciden", () => {
    const byKey = new Map(contract.map((c) => [`${c.method} ${c.path}`, c.code]));
    const diff = routes.filter((r) => byKey.has(`${r.method} ${r.path}`) && byKey.get(`${r.method} ${r.path}`) !== r.code);
    expect(diff).toEqual([]);
  });
});
