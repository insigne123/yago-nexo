/**
 * Los motores registran algunos datos con su propio vocabulario; la API los entrega con los nombres del
 * contrato (openapi.yaml), que es lo que muestra la Consola.
 */
import "reflect-metadata";
import { beforeAll, describe, expect, it } from "vitest";

let scanTotals: (t: unknown) => Record<string, unknown> | undefined;
let failoverStep: (s: unknown) => { name?: string; status?: string; detail?: string; ts?: string };

beforeAll(async () => {
  process.env.NEXO_DATABASE_URL ??= "postgres://contrato@localhost:1/contrato";
  for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"]) process.env[k] ??= "prueba-de-contrato";
  ({ scanTotals } = await import("./discovery.js"));
  ({ failoverStep } = await import("./continuity.js"));
});

describe("totales de un escaneo de descubrimiento", () => {
  it("agrega endpoints y gobernados a partir de lo que registra el motor", () => {
    const t = scanTotals({ hallazgos: 9, nuevos: 9, noGobernados: 5, riesgoAlto: 6, porFuente: { red: 6 }, errores: [] });
    expect(t).toMatchObject({ endpoints: 9, gobernados: 4, noGobernados: 5, riesgoAlto: 6, nuevos: 9 });
  });
  it("respeta los campos del contrato si ya vienen", () => {
    expect(scanTotals({ endpoints: 3, gobernados: 1, noGobernados: 2, riesgoAlto: 0 })).toMatchObject({ endpoints: 3, gobernados: 1 });
  });
  it("un escaneo en curso no tiene totales", () => {
    expect(scanTotals(null)).toBeUndefined();
  });
});

describe("pasos de una conmutación", () => {
  it("traduce {paso, ok, detalle} del agente a {name, status, detail}", () => {
    expect(failoverStep({ paso: "promover la réplica", ok: true, detalle: "lista en 160 ms" })).toEqual({ name: "promover la réplica", status: "completado", detail: "lista en 160 ms", ts: undefined });
    expect(failoverStep({ paso: "conmutación", ok: false, detalle: "sin quórum" }).status).toBe("fallido");
  });
  it("deja pasar los pasos que ya vienen en el formato del contrato", () => {
    expect(failoverStep({ name: "a", status: "en_curso", detail: "b", ts: "2026-10-04T00:00:00Z" })).toEqual({ name: "a", status: "en_curso", detail: "b", ts: "2026-10-04T00:00:00Z" });
  });
});
