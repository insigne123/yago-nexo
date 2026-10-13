/**
 * Retorno al sitio principal con dos personas, de punta a punta: API real (guardia, interceptor, auditoría
 * encadenada) sobre un PostgreSQL desechable. Corre solo si se define NEXO_TEST_DATABASE_URL (crea y borra la
 * base «nexo_consola_api_prueba» en ese servidor):
 *
 *   docker run -d --rm --name nexo-pg-prueba -e POSTGRES_PASSWORD=prueba -p 55432:5432 postgres:16-alpine
 *   NEXO_TEST_DATABASE_URL=postgres://postgres:prueba@localhost:55432/postgres pnpm --filter @nexo/console-api test
 */
import "reflect-metadata";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { createPool, type Db } from "@nexo/console-db";

const ADMIN_URL = process.env.NEXO_TEST_DATABASE_URL;
const ISSUER = "http://idp.prueba.invalid/realms/nexo";
const DB_NAME = "nexo_consola_api_prueba";

describe.skipIf(!ADMIN_URL)("retorno con dos personas por la API", () => {
  let jwks: Server;
  let app: INestApplication;
  let db: Db;
  let base = "";
  let key: CryptoKey;
  const tok: Record<string, string> = {};

  const sign = (username: string, roles: string[]) =>
    new SignJWT({ preferred_username: username, resource_access: { "nexo-console": { roles } } })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(ISSUER)
      .setSubject(`sub-${username}`)
      .setExpirationTime("10m")
      .sign(key);

  async function call(who: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tok[who]}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async function audit(action: string) {
    return (
      await db.query(
        "SELECT actor, action, resource, result, details FROM nexo.audit_event WHERE action = $1 ORDER BY seq",
        [action],
      )
    ).rows;
  }

  beforeAll(async () => {
    const admin = createPool(ADMIN_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    key = privateKey;
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "RS256", use: "sig" };
    jwks = createServer((_q, r) => r.end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));

    process.env.NEXO_DATABASE_URL = url.toString();
    for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"])
      process.env[k] ??= "prueba";
    process.env.NEXO_AUTH_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
    process.env.NEXO_AUTH_ISSUER = ISSUER;

    const { Module } = await import("@nestjs/common");
    const { APP_GUARD, APP_INTERCEPTOR, NestFactory } = await import("@nestjs/core");
    const { migrate } = await import("@nexo/console-db");
    const { AuthGuard } = await import("../auth/auth.js");
    const { AuditFailuresInterceptor } = await import("../common/audit-failures.js");
    const { AuditService } = await import("../common/audit.service.js");
    const { UnauthorizedAudit } = await import("../common/unauthorized-audit.js");
    const { DB } = await import("../common/tokens.js");
    const { ContinuityController } = await import("./continuity.js");

    db = createPool(url.toString());
    await migrate(db, () => undefined);

    @Module({
      controllers: [ContinuityController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditFailuresInterceptor },
        { provide: DB, useValue: db },
        AuditService,
        UnauthorizedAudit,
      ],
    })
    class PruebaModule {}

    app = await NestFactory.create(PruebaModule, { logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    base = `${(await app.getUrl()).replace("[::1]", "127.0.0.1")}/api/v1`;

    tok.carla = await sign("carla.operacion", ["operador"]);
    tok.luis = await sign("luis.aprobador", ["aprobador"]);
    tok.pedro = await sign("pedro.auditoria", ["auditor"]);
    tok.ana = await sign("ana.desarrollo", ["desarrollador"]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await new Promise((r) => jwks?.close(r));
  });

  it("con el CPD activo no hay retorno que pedir (409)", async () => {
    const r = await call("carla", "POST", "/continuity/failback/requests", {
      reason: "Prueba sin conmutación previa",
    });
    expect(r.status).toBe(409);
    expect(r.data.code).toBe("sitio_activo");
  });

  it("lo pide una persona y lo aprueba otra; los rechazos quedan auditados", async () => {
    await db.query("UPDATE nexo.continuity_settings SET active_site = 'gcp' WHERE id = 1");

    expect((await call("carla", "POST", "/continuity/failback/requests", {})).status).toBe(400);
    expect(
      (await call("ana", "POST", "/continuity/failback/requests", { reason: "Sin el permiso" })).status,
    ).toBe(403);

    // Un aprobador pide y no puede aprobar su propia solicitud (cuatro ojos); la retira.
    const own = await call("luis", "POST", "/continuity/failback/requests", {
      reason: "CPD restablecido (aprobador)",
    });
    expect(own.status).toBe(201);
    const self = await call("luis", "POST", `/continuity/failback/requests/${own.data.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.data.permission).toBe("cuatro-ojos");
    expect(
      (
        await call("luis", "POST", `/continuity/failback/requests/${own.data.id}/reject`, {
          reason: "Lo aprueba otra persona",
        })
      ).data.status,
    ).toBe("rechazada");

    // La operadora pide; ella no puede aprobar (permiso) y el aprobador sí.
    const req = await call("carla", "POST", "/continuity/failback/requests", {
      reason: "CPD restablecido, réplica al día",
    });
    expect(req.status).toBe(201);
    expect(req.data).toMatchObject({
      status: "pendiente",
      requestedBy: "carla.operacion",
      fromSite: "gcp",
      toSite: "cpd",
    });
    expect(new Date(req.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(
      (await call("luis", "POST", "/continuity/failback/requests", { reason: "Segunda solicitud" })).data
        .code,
    ).toBe("pendiente_existente");
    expect((await call("pedro", "GET", "/continuity")).data.pendingFailback).toMatchObject({
      id: req.data.id,
      status: "pendiente",
    });
    expect(
      (await call("carla", "POST", `/continuity/failback/requests/${req.data.id}/approve`, {})).status,
    ).toBe(403);

    const ok = await call("luis", "POST", `/continuity/failback/requests/${req.data.id}/approve`, {
      reason: "Conforme",
    });
    expect(ok.status).toBe(202);
    expect(ok.data.request).toMatchObject({
      status: "aprobada",
      requestedBy: "carla.operacion",
      decidedBy: "luis.aprobador",
    });
    expect(ok.data.event).toMatchObject({
      kind: "retorno",
      trigger: "manual",
      from: "gcp",
      to: "cpd",
      status: "en_curso",
      requestedBy: "carla.operacion",
      approvedBy: "luis.aprobador",
    });
    expect((await call("pedro", "GET", "/continuity/events")).data[0]).toMatchObject({
      id: ok.data.event.id,
      requestedBy: "carla.operacion",
      approvedBy: "luis.aprobador",
    });
    expect((await call("pedro", "GET", "/continuity")).data.pendingFailback).toBeUndefined();
    expect(
      (await call("luis", "POST", `/continuity/failback/requests/${req.data.id}/approve`, {})).data.code,
    ).toBe("no_pendiente");

    // Auditoría: las dos personas, y cada rechazo.
    const solicitar = await audit("continuidad.retorno.solicitar");
    expect(solicitar.filter((e) => e.result === "exito").map((e) => e.actor)).toEqual([
      "luis.aprobador",
      "carla.operacion",
    ]);
    expect(solicitar.filter((e) => e.result === "rechazado").map((e) => [e.actor, e.details.estado])).toEqual(
      [
        ["carla.operacion", 409], // con el CPD activo (prueba anterior)
        ["carla.operacion", 400],
        ["luis.aprobador", 409],
      ],
    );
    const aprobar = await audit("continuidad.retorno.aprobar");
    expect(aprobar.find((e) => e.result === "exito")).toMatchObject({
      actor: "luis.aprobador",
      resource: `retorno/${req.data.id}`,
      details: { solicitadoPor: "carla.operacion", conmutacion: ok.data.event.id },
    });
    expect((await audit("acceso.rechazado.cuatro_ojos")).map((e) => [e.actor, e.details.accion])).toEqual([
      ["luis.aprobador", "continuidad.retorno.aprobar"],
    ]);
    expect((await audit("acceso.rechazado.permiso")).map((e) => [e.actor, e.details.permiso])).toEqual([
      ["ana.desarrollo", "continuity:failback:request"],
      ["carla.operacion", "continuity:failback:approve"],
    ]);
  });

  it("una solicitud vencida no se aprueba y queda auditada", async () => {
    await db.query("UPDATE nexo.failover_event SET status = 'completado', finished_at = now()");
    const req = await call("carla", "POST", "/continuity/failback/requests", {
      reason: "CPD restablecido otra vez",
    });
    expect(req.status).toBe(201);
    await db.query(
      "UPDATE nexo.failback_request SET requested_at = now() - interval '40 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [req.data.id],
    );
    const list = (await call("pedro", "GET", "/continuity/failback/requests")).data as unknown as Array<{
      id: string;
      status: string;
    }>;
    expect(list.find((r) => r.id === req.data.id)?.status).toBe("vencida");
    const late = await call("luis", "POST", `/continuity/failback/requests/${req.data.id}/approve`, {});
    expect(late.status).toBe(409);
    expect(late.data.code).toBe("vencida");
    expect((await audit("continuidad.retorno.vencida")).map((e) => e.resource)).toEqual([
      `retorno/${req.data.id}`,
    ]);
    const chain = await db.query("SELECT count(*)::int AS n FROM nexo.audit_event");
    expect(chain.rows[0].n).toBeGreaterThan(10);
    const { AuditStore } = await import("@nexo/console-db");
    expect(await new AuditStore(db).verify()).toMatchObject({ ok: true });
  });
});
