import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { UnauthorizedAggregator as Aggregator, UnauthorizedSummary } from "./unauthorized-audit.js";
import { classifyFailure, routeOf } from "./audit-failures.js";
import { bearerToken, tokenMatches } from "./secret.js";

let secretFromEnv: (k: string, min?: number) => string | undefined;
let UnauthorizedAggregator: typeof Aggregator;
let OVERFLOW_IP: string;

beforeAll(async () => {
  // La configuración se lee al importar: se completan las variables obligatorias antes.
  process.env.NEXO_DATABASE_URL ??= "postgres://prueba@localhost:1/prueba";
  for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"])
    process.env[k] ??= "prueba";
  ({ secretFromEnv } = await import("../config.js"));
  ({ UnauthorizedAggregator, OVERFLOW_IP } = await import("./unauthorized-audit.js"));
});

describe("agrupación de 401 por IP", () => {
  const setup = (maxIps = 2) => {
    let t = 1_000_000;
    const out: UnauthorizedSummary[] = [];
    const agg = new UnauthorizedAggregator({
      windowMs: 60_000,
      maxIps,
      emit: (s) => out.push(s),
      now: () => t,
    });
    return { agg, out, advance: (ms: number) => (t += ms) };
  };

  it("registra el primer intento de inmediato y el total al cerrar la ventana", async () => {
    const { agg, out, advance } = setup();
    await agg.hit("10.0.0.1", "sin token", "GET /api/v1/me");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ip: "10.0.0.1", phase: "primero", count: 1 });
    for (let i = 0; i < 99; i++)
      await agg.hit("10.0.0.1", i % 2 ? "sin token" : "token inválido: firma", "GET /api/v1/me");
    expect(out).toHaveLength(1); // sin inundar: la ráfaga no escribe nada más dentro de la ventana
    advance(59_999);
    await agg.flushExpired();
    expect(out).toHaveLength(1);
    advance(1);
    await agg.flushExpired();
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      ip: "10.0.0.1",
      phase: "resumen",
      count: 100,
      reasons: { "sin token": 50, "token inválido: firma": 50 },
      paths: ["GET /api/v1/me"],
      windowSec: 60,
    });
    expect(out[1]!.last.getTime() - out[1]!.first.getTime()).toBe(0);
    expect(agg.size).toBe(0);
  });

  it("un solo intento en la ventana no repite el evento al cerrarla", async () => {
    const { agg, out, advance } = setup();
    await agg.hit("10.0.0.2", "sin token", "GET /x");
    advance(60_000);
    await agg.flushExpired();
    expect(out).toHaveLength(1);
  });

  it("pasada la ventana, la misma IP abre una ventana nueva", async () => {
    const { agg, out, advance } = setup();
    await agg.hit("10.0.0.3", "sin token", "GET /x");
    advance(61_000);
    await agg.hit("10.0.0.3", "sin token", "GET /x");
    expect(out.map((s) => s.phase)).toEqual(["primero", "primero"]);
  });

  it("sobre el tope de IP, los intentos se suman en un único resumen «varias»", async () => {
    const { agg, out, advance } = setup(2);
    for (let i = 1; i <= 1000; i++) await agg.hit(`192.0.2.${i % 250}`, "sin token", "GET /x");
    expect(out).toHaveLength(2); // solo las 2 primeras IP tienen evento inmediato
    advance(60_000);
    await agg.flushExpired();
    const overflow = out.find((s) => s.ip === OVERFLOW_IP);
    expect(overflow).toMatchObject({ phase: "resumen" });
    const total =
      out.filter((s) => s.phase === "resumen").reduce((a, s) => a + s.count, 0) +
      out.filter((s) => s.phase === "primero").length;
    expect(total).toBeGreaterThanOrEqual(1000); // ningún intento se pierde
    expect(out.length).toBeLessThanOrEqual(2 * 2 + 1);
  });

  it("acota motivos y rutas distintas", async () => {
    const { agg, out, advance } = setup();
    for (let i = 0; i < 30; i++) await agg.hit("10.0.0.4", `motivo ${i}`, `GET /ruta/${i}`);
    advance(60_000);
    await agg.flushExpired();
    const s = out[1]!;
    expect(Object.keys(s.reasons)).toHaveLength(9); // 8 motivos + «otros»
    expect(s.reasons.otros).toBe(22);
    expect(s.paths).toHaveLength(5);
  });

  it("al apagar se cierran todas las ventanas", async () => {
    const { agg, out } = setup();
    await agg.hit("10.0.0.5", "sin token", "GET /x");
    await agg.hit("10.0.0.5", "sin token", "GET /x");
    await agg.flushExpired(undefined, true);
    expect(out.map((s) => `${s.phase}:${s.count}`)).toEqual(["primero:1", "resumen:2"]);
  });

  it("sin IP conocida usa «desconocida»", async () => {
    const { agg, out } = setup();
    await agg.hit(undefined, "sin token", "GET /x");
    expect(out[0]!.ip).toBe("desconocida");
  });
});

describe("qué fallos se auditan", () => {
  const meta = { action: "despliegue.aprobar" };

  it("cuatro ojos: acción propia con la acción intentada", () => {
    const err = new ForbiddenException({
      statusCode: 403,
      message: "Regla de cuatro ojos: quien inició el despliegue no puede aprobarlo",
      permission: "cuatro-ojos",
    });
    expect(classifyFailure(err, "POST", meta)).toEqual({
      action: "acceso.rechazado.cuatro_ojos",
      result: "rechazado",
      details: {
        accion: "despliegue.aprobar",
        motivo: "Regla de cuatro ojos: quien inició el despliegue no puede aprobarlo",
        estado: 403,
      },
    });
  });

  it("4xx en una escritura: «rechazado» con el motivo y el código", () => {
    const err = new ConflictException({ statusCode: 409, message: "La solicitud venció", code: "vencida" });
    expect(classifyFailure(err, "POST", meta)).toEqual({
      action: "despliegue.aprobar",
      result: "rechazado",
      details: { estado: 409, motivo: "La solicitud venció", codigo: "vencida" },
    });
    const bad = new BadRequestException({
      statusCode: 400,
      message: "Datos de entrada inválidos",
      issues: [{ campo: "reason", detalle: "requerido" }],
    });
    expect(classifyFailure(bad, "POST", { action: "mensajes.reprocesar" })?.details).toMatchObject({
      estado: 400,
      campos: ["reason"],
    });
  });

  it("5xx o error inesperado en una escritura: «error»", () => {
    expect(classifyFailure(new Error("conexión rechazada"), "PUT", undefined)).toEqual({
      action: "operacion.fallida",
      result: "error",
      details: { estado: 500, motivo: "conexión rechazada" },
    });
  });

  it("los 401 se agrupan aparte y las consultas fallidas no se auditan", () => {
    expect(classifyFailure(new UnauthorizedException(), "POST", meta)).toBeUndefined();
    expect(classifyFailure(new Error("x"), "GET", undefined)).toBeUndefined();
  });

  it("la ruta auditada no incluye la consulta", () => {
    expect(routeOf({ method: "GET", originalUrl: "/api/v1/audit-events?actor=x" })).toBe(
      "GET /api/v1/audit-events",
    );
  });
});

describe("token del webhook de alertas", () => {
  it("lee el token del encabezado Bearer", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it("solo coincide el token exacto, y sin token configurado nada coincide", () => {
    const t = "token-de-alertas-0123456789";
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(`${t}x`, t)).toBe(false);
    expect(tokenMatches(t.slice(0, -1), t)).toBe(false);
    expect(tokenMatches(undefined, t)).toBe(false);
    expect(tokenMatches("", t)).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
    expect(tokenMatches(undefined, undefined)).toBe(false);
  });

  it("toma el token de la variable o del archivo de secreto, con largo mínimo", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-secreto-"));
    const file = join(dir, "token");
    writeFileSync(file, "desde-archivo-0123456789\n");
    process.env.NEXO_PRUEBA_TOKEN = "desde-variable-0123456789"; // gitleaks:allow (valor de prueba)
    expect(secretFromEnv("NEXO_PRUEBA_TOKEN", 16)).toBe("desde-variable-0123456789");
    process.env.NEXO_PRUEBA_TOKEN_FILE = file;
    expect(secretFromEnv("NEXO_PRUEBA_TOKEN", 16)).toBe("desde-archivo-0123456789");
    writeFileSync(file, "  \n");
    expect(() => secretFromEnv("NEXO_PRUEBA_TOKEN", 16)).toThrow(/vacío/);
    delete process.env.NEXO_PRUEBA_TOKEN_FILE;
    process.env.NEXO_PRUEBA_TOKEN = "corto";
    expect(() => secretFromEnv("NEXO_PRUEBA_TOKEN", 16)).toThrow(/16 caracteres/);
    delete process.env.NEXO_PRUEBA_TOKEN;
    expect(secretFromEnv("NEXO_PRUEBA_TOKEN", 16)).toBeUndefined();
  });

  it("un token mal configurado no impide arrancar la API: el webhook queda sin token y se informa el motivo", async () => {
    const prev = { file: process.env.NEXO_ALERTS_TOKEN_FILE, token: process.env.NEXO_ALERTS_TOKEN };
    try {
      for (const [env, expected] of [
        [{ NEXO_ALERTS_TOKEN_FILE: "/no/existe/token" }, /no\/existe/],
        [{ NEXO_ALERTS_TOKEN: "corto" }, /16 caracteres/],
        [{}, /no está configurado/],
      ] as const) {
        delete process.env.NEXO_ALERTS_TOKEN_FILE;
        delete process.env.NEXO_ALERTS_TOKEN;
        Object.assign(process.env, env);
        vi.resetModules();
        const { config } = await import("../config.js");
        expect(config.alerts.token).toBeUndefined();
        expect(config.alerts.problem).toMatch(expected);
      }
      delete process.env.NEXO_ALERTS_TOKEN_FILE;
      process.env.NEXO_ALERTS_TOKEN = "token-de-alertas-0123456789";
      vi.resetModules();
      expect((await import("../config.js")).config.alerts).toEqual({ token: "token-de-alertas-0123456789" });
    } finally {
      for (const [k, v] of [
        ["NEXO_ALERTS_TOKEN_FILE", prev.file],
        ["NEXO_ALERTS_TOKEN", prev.token],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  });
});

describe("auditoría del éxito de una acción ya confirmada", () => {
  it("si la escritura en la cadena falla, no lanza: la acción ya se ejecutó y queda en el log", async () => {
    const { AuditService } = await import("./audit.service.js");
    const svc = new AuditService({} as never);
    const intentos: unknown[] = [];
    Object.defineProperty(svc, "store", {
      value: {
        append: async (e: unknown) => {
          intentos.push(e);
          throw new Error("base no disponible");
        },
      },
    });
    const user = {
      username: "luis.aprobador",
      sub: "s",
      roles: ["aprobador"],
      permissions: [],
      ip: "192.0.2.7",
    };
    await expect(
      svc.recordCommitted(user as never, "continuidad.retorno.aprobar", "retorno/1", { conmutacion: "e1" }),
    ).resolves.toBe(false);
    expect(intentos).toEqual([
      expect.objectContaining({
        source: "consola",
        actor: "luis.aprobador",
        actorType: "usuario",
        action: "continuidad.retorno.aprobar",
        result: "exito",
        sourceIp: "192.0.2.7",
      }),
    ]);
  });
});
