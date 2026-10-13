/**
 * Rechazos auditados de punta a punta (BT-026, BT-031, BT-034): servidor Nest real con el guardia, el interceptor
 * de fallos y el webhook de alertas; tokens firmados con una llave local servida como JWKS. La cadena de
 * auditoría se reemplaza por un registro en memoria para ver exactamente qué eventos se escriben.
 */
import "reflect-metadata";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { AuditEventInput } from "@nexo/shared";

const ALERTS_TOKEN = "token-de-alertas-de-prueba-0123456789";
const ISSUER = "http://idp.prueba.invalid/realms/nexo";

let jwksServer: Server;
let app: INestApplication;
let base = "";
let privateKey: CryptoKey;
let closeWindows: () => Promise<void> = async () => undefined;
const events: AuditEventInput[] = [];
const alertRows: unknown[][] = [];

async function tokenFor(username: string, roles: string[], sub = `sub-${username}`) {
  return new SignJWT({ preferred_username: username, resource_access: { "nexo-console": { roles } } })
    .setProtectedHeader({ alg: "RS256", kid: "prueba" })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; auth?: string; ip?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.10" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

const byAction = (action: string) => events.filter((e) => e.action === action);

beforeAll(async () => {
  const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
  privateKey = pk;
  const jwk = { ...(await exportJWK(publicKey)), kid: "prueba", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  const port = (jwksServer.address() as AddressInfo).port;

  process.env.NEXO_DATABASE_URL ??= "postgres://prueba@localhost:1/prueba";
  for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"])
    process.env[k] ??= "prueba";
  process.env.NEXO_AUTH_JWKS_URL = `http://127.0.0.1:${port}/certs`;
  process.env.NEXO_AUTH_ISSUER = ISSUER;
  process.env.NEXO_ALERTS_TOKEN = ALERTS_TOKEN;
  process.env.NEXO_AUDIT_UNAUTHORIZED_WINDOW_SEC = "60";
  process.env.NEXO_AUDIT_UNAUTHORIZED_MAX_IPS = "3";

  const { Body, Controller, Get, HttpCode, Module, Post } = await import("@nestjs/common");
  const { APP_GUARD, APP_INTERCEPTOR, NestFactory } = await import("@nestjs/core");
  const { z } = await import("zod");
  const auth = await import("./auth/auth.js");
  const { AuditAction, AuditFailuresInterceptor } = await import("./common/audit-failures.js");
  const { AuditService } = await import("./common/audit.service.js");
  const { UnauthorizedAudit } = await import("./common/unauthorized-audit.js");
  const { DB } = await import("./common/tokens.js");
  const { parse } = await import("./common/validation.js");
  const { AlertsController } = await import("./modules/platform.js");

  @Controller("prueba")
  class PruebaController {
    @auth.Public()
    @Get("abierta")
    abierta() {
      return { ok: true };
    }

    @Get("auditoria")
    @auth.RequirePermission("audit:read")
    leer() {
      return [];
    }

    @Post("aprobar")
    @HttpCode(200)
    @auth.RequirePermission("rollout:approve")
    @AuditAction("despliegue.aprobar")
    aprobar(
      @auth.CurrentUser() user: { username: string; sub: string; roles: string[]; permissions: never[] },
    ) {
      // El recurso lo creó la misma persona que intenta aprobarlo.
      auth.assertFourEyes(user, [user.username], "el despliegue");
      return { ok: true };
    }

    @Post("motivo")
    @auth.RequirePermission("dlq:reprocess:approve")
    @AuditAction("mensajes.reprocesar")
    motivo(@Body() body: unknown) {
      return parse(z.object({ reason: z.string().min(5) }), body);
    }

    @Post("falla")
    @auth.RequirePermission("catalog:write")
    @AuditAction("catalogo.actualizar")
    falla() {
      throw new Error("la base de datos no responde");
    }
  }

  const fakeAudit = {
    append: async (e: Omit<AuditEventInput, "source">) => {
      events.push({ source: "consola", ...e });
      return true;
    },
    record: async () => undefined,
    store: {
      append: async (e: AuditEventInput) => {
        events.push(e);
        return e;
      },
    },
  };
  const fakeDb = {
    query: async (_sql: string, params: unknown[] = []) => {
      alertRows.push(params);
      return { rows: [{ id: alertRows.length }], rowCount: 1 };
    },
  };

  @Module({
    controllers: [PruebaController, AlertsController],
    providers: [
      { provide: APP_GUARD, useClass: auth.AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditFailuresInterceptor },
      { provide: AuditService, useValue: fakeAudit },
      { provide: DB, useValue: fakeDb },
      UnauthorizedAudit,
    ],
  })
  class PruebaModule {}

  app = await NestFactory.create(PruebaModule, { logger: false });
  app.setGlobalPrefix("api/v1");
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set("trust proxy", true);
  await app.listen(0, "127.0.0.1");
  const unauthorized = app.get(UnauthorizedAudit);
  closeWindows = () => unauthorized.aggregator.flushExpired(Date.now(), true);
  base = `${(await app.getUrl()).replace("[::1]", "127.0.0.1")}/api/v1`;
}, 30_000);

afterAll(async () => {
  await app?.close();
  await new Promise((r) => jwksServer?.close(r));
});

beforeEach(async () => {
  await closeWindows();
  events.length = 0;
  alertRows.length = 0;
});

describe("401 agrupados por IP", () => {
  it("una ráfaga desde una IP deja un solo evento inmediato, con la IP y el motivo", async () => {
    const ip = "198.51.100.1";
    for (let i = 0; i < 25; i++) expect((await call("GET", "/prueba/auditoria", { ip })).status).toBe(401);
    expect((await call("GET", "/prueba/auditoria", { ip, auth: "Bearer no-es-un-jwt" })).status).toBe(401);
    const ev = byAction("acceso.rechazado.autenticacion");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      actor: "anonimo",
      result: "rechazado",
      sourceIp: ip,
      resource: `ip/${ip}`,
    });
    expect(ev[0]!.details).toMatchObject({
      fase: "primero",
      intentos: 1,
      motivos: { "sin token": 1 },
      rutas: ["GET /api/v1/prueba/auditoria"],
    });
    // Al cerrar la ventana queda un resumen con el total de intentos y sus motivos.
    await closeWindows();
    const resumen = byAction("acceso.rechazado.autenticacion")[1];
    expect(resumen).toMatchObject({
      sourceIp: ip,
      details: expect.objectContaining({ fase: "resumen", intentos: 26 }),
    });
    const motivos = (resumen!.details as { motivos: Record<string, number> }).motivos;
    expect(motivos["sin token"]).toBe(25);
    expect(Object.keys(motivos).find((m) => m.startsWith("token inválido"))).toBeDefined();
  });

  it("más IP que el tope no generan más eventos: se suman en «varias» al cerrar la ventana", async () => {
    for (let i = 0; i < 10; i++) await call("GET", "/prueba/auditoria", { ip: `192.0.2.${i + 1}` });
    // Tope de 3 IP por ventana: 3 eventos inmediatos; las otras 7 IP no generan eventos propios.
    expect(byAction("acceso.rechazado.autenticacion")).toHaveLength(3);
    await closeWindows();
    const ev = byAction("acceso.rechazado.autenticacion");
    // Las IP con un solo intento no repiten resumen; las demás se suman en un único resumen «varias».
    expect(ev).toHaveLength(4);
    expect(ev[3]).toMatchObject({
      resource: "ip/varias",
      details: expect.objectContaining({ fase: "resumen", intentos: 7 }),
    });
    expect(ev[3]!.sourceIp).toBeUndefined();
  });

  it("las rutas públicas no exigen token", async () => {
    expect((await call("GET", "/prueba/abierta")).status).toBe(200);
    expect(events).toHaveLength(0);
  });
});

describe("403 auditados", () => {
  it("por permiso: usuario, permiso que faltó y ruta", async () => {
    const tok = await tokenFor("ana.desarrollo", ["desarrollador"]);
    const res = await call("GET", "/prueba/auditoria", { token: tok, ip: "198.51.100.20" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ permission: "audit:read" });
    expect(byAction("acceso.rechazado.permiso")).toEqual([
      expect.objectContaining({
        actor: "ana.desarrollo",
        actorType: "usuario",
        result: "rechazado",
        resource: "GET /api/v1/prueba/auditoria",
        sourceIp: "198.51.100.20",
        details: { permiso: "audit:read", roles: ["desarrollador"], estado: 403 },
      }),
    ]);
  });

  it("por cuatro ojos: un solo evento con la acción que se intentó", async () => {
    const tok = await tokenFor("luis.aprobador", ["aprobador"]);
    const res = await call("POST", "/prueba/aprobar", { token: tok });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ permission: "cuatro-ojos" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "acceso.rechazado.cuatro_ojos",
      actor: "luis.aprobador",
      result: "rechazado",
      details: { accion: "despliegue.aprobar", estado: 403 },
    });
  });

  it("con permiso pasa sin eventos de rechazo", async () => {
    const tok = await tokenFor("pedro.auditoria", ["auditor"]);
    expect((await call("GET", "/prueba/auditoria", { token: tok })).status).toBe(200);
    expect(events).toHaveLength(0);
  });
});

describe("escrituras que no se completan", () => {
  it("sin motivo: «rechazado» con el campo que faltó", async () => {
    const tok = await tokenFor("luis.aprobador", ["aprobador"]);
    expect((await call("POST", "/prueba/motivo", { token: tok, body: {} })).status).toBe(400);
    expect(events).toEqual([
      expect.objectContaining({
        action: "mensajes.reprocesar",
        actor: "luis.aprobador",
        result: "rechazado",
        details: expect.objectContaining({ estado: 400, campos: ["reason"] }),
      }),
    ]);
  });

  it("una falla interna queda como «error»", async () => {
    const tok = await tokenFor("admin.nexo", ["administrador"]);
    expect((await call("POST", "/prueba/falla", { token: tok })).status).toBe(500);
    expect(events).toEqual([
      expect.objectContaining({
        action: "catalogo.actualizar",
        result: "error",
        details: expect.objectContaining({ estado: 500, motivo: "la base de datos no responde" }),
      }),
    ]);
  });
});

describe("webhook de alertas", () => {
  const payload = {
    version: "4",
    status: "firing",
    alerts: [
      {
        status: "firing",
        labels: { alertname: "ColaConMensajesFallidos", severidad: "S3", queue: "solicitudes.dlq" },
        annotations: { resumen: "La cola de fallidos tiene mensajes" },
        fingerprint: "abc123",
        startsAt: "2026-10-08T10:00:00Z",
      },
      {
        status: "resolved",
        labels: { alertname: "ComponenteCaido", severidad: "S2" },
        fingerprint: "def456",
        endsAt: "2026-10-08T10:05:00Z",
      },
    ],
  };

  it("sin token responde 401, no guarda nada y el intento se audita agrupado por IP", async () => {
    const res = await call("POST", "/alerts/alertmanager", { body: payload, ip: "198.51.100.30" });
    expect(res.status).toBe(401);
    expect(alertRows).toHaveLength(0);
    expect(byAction("acceso.rechazado.autenticacion")[0]).toMatchObject({
      sourceIp: "198.51.100.30",
      details: expect.objectContaining({ motivos: { "webhook de alertas sin token": 1 } }),
    });
  });

  it("con un token inválido o de otro esquema responde 401", async () => {
    expect(
      (await call("POST", "/alerts/alertmanager", { body: payload, auth: `Bearer ${ALERTS_TOKEN}x` })).status,
    ).toBe(401);
    expect(
      (await call("POST", "/alerts/alertmanager", { body: payload, auth: `Basic ${ALERTS_TOKEN}` })).status,
    ).toBe(401);
    expect(
      (
        await call("POST", "/alerts/alertmanager", {
          body: payload,
          token: await tokenFor("admin.nexo", ["administrador"]),
        })
      ).status,
    ).toBe(401);
    expect(alertRows).toHaveLength(0);
  });

  it("con el token guarda cada alerta y la deja en la auditoría (que el reenvío lleva al SIEM)", async () => {
    const res = await call("POST", "/alerts/alertmanager", {
      body: payload,
      auth: `Bearer ${ALERTS_TOKEN}`,
      ip: "10.0.0.7",
    });
    expect(res.status).toBe(204);
    expect(alertRows).toHaveLength(2);
    const ev = byAction("alerta.recibida");
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      source: "consola",
      actor: "alertmanager",
      actorType: "tecnico",
      resource: "alerta/ColaConMensajesFallidos",
      result: "exito",
      sourceIp: "10.0.0.7",
      details: expect.objectContaining({
        estado: "firing",
        severidad: "S3",
        huella: "abc123",
        resumen: "La cola de fallidos tiene mensajes",
      }),
    });
    expect(ev[1]).toMatchObject({
      resource: "alerta/ComponenteCaido",
      details: expect.objectContaining({ estado: "resolved", fin: "2026-10-08T10:05:00Z" }),
    });
  });

  it("una carga inválida con token válido responde 400 y queda auditada como rechazada", async () => {
    const res = await call("POST", "/alerts/alertmanager", {
      body: { alerts: [{ status: "otro", labels: {} }] },
      auth: `Bearer ${ALERTS_TOKEN}`,
    });
    expect(res.status).toBe(400);
    expect(events).toEqual([
      expect.objectContaining({
        action: "alerta.recibida",
        actor: "alertmanager",
        actorType: "tecnico",
        result: "rechazado",
      }),
    ]);
  });
});
