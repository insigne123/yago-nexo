/**
 * Paquete de exportación de la Consola con la configuración de la plataforma (NEXO_PLATFORM_SPEC), de punta a
 * punta: API real sobre un PostgreSQL desechable, con WSO2 y el integrador simulados. Corre solo si se define
 * NEXO_TEST_DATABASE_URL (crea y borra la base «nexo_consola_export_prueba» en ese servidor).
 */
import "reflect-metadata";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { createPool, type Db } from "@nexo/console-db";

const ADMIN_URL = process.env.NEXO_TEST_DATABASE_URL;
const ISSUER = "http://idp.prueba.invalid/realms/nexo";
const DB_NAME = "nexo_consola_export_prueba";
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

describe.skipIf(!ADMIN_URL)("paquete de exportación con la configuración de la plataforma", () => {
  let jwks: Server;
  let app: INestApplication;
  let db: Db;
  let base = "";
  let token = "";
  const dir = mkdtempSync(join(tmpdir(), "nexo-export-api-"));

  beforeAll(async () => {
    const admin = createPool(ADMIN_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "RS256", use: "sig" };
    jwks = createServer((_q, r) => r.end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));

    process.env.NEXO_DATABASE_URL = url.toString();
    for (const k of ["NEXO_WSO2_PASSWORD", "NEXO_MI_PASSWORD", "NEXO_RABBITMQ_PASSWORD"])
      process.env[k] ??= "prueba";
    process.env.NEXO_AUTH_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
    process.env.NEXO_AUTH_ISSUER = ISSUER;
    process.env.NEXO_EXPORT_DIR = dir;
    process.env.NEXO_PLATFORM_SPEC = join(raiz, "wso2/apim/platform.yaml");

    const { Module } = await import("@nestjs/common");
    const { APP_GUARD, APP_INTERCEPTOR, NestFactory } = await import("@nestjs/core");
    const { migrate } = await import("@nexo/console-db");
    const { AuthGuard } = await import("../auth/auth.js");
    const { AuditFailuresInterceptor } = await import("../common/audit-failures.js");
    const { AuditService } = await import("../common/audit.service.js");
    const { UnauthorizedAudit } = await import("../common/unauthorized-audit.js");
    const { DB, MI, WSO2 } = await import("../common/tokens.js");
    const { ExportsController } = await import("./platform.js");

    db = createPool(url.toString());
    await migrate(db, () => undefined);

    const wso2 = {
      publisher: {
        listApis: async () => ({ list: [{ id: "a1", name: "Concesiones", version: "1.0.0" }] }),
        exportApi: async () => new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0]),
      },
    };
    const mi = {
      apis: async () => ({ list: [{ name: "SolicitudesConcesionAPI" }] }),
      api: async () => ({ configuration: '<api name="SolicitudesConcesionAPI"/>' }),
    };

    @Module({
      controllers: [ExportsController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditFailuresInterceptor },
        { provide: DB, useValue: db },
        { provide: WSO2, useValue: wso2 },
        { provide: MI, useValue: mi },
        AuditService,
        UnauthorizedAudit,
      ],
    })
    class PruebaModule {}

    app = await NestFactory.create(PruebaModule, { logger: false });
    app.setGlobalPrefix("api/v1");
    await app.listen(0, "127.0.0.1");
    base = `${(await app.getUrl()).replace("[::1]", "127.0.0.1")}/api/v1`;
    token = await new SignJWT({
      preferred_username: "pedro.auditoria",
      resource_access: { "nexo-console": { roles: ["auditor"] } },
    })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(ISSUER)
      .setSubject("sub-pedro")
      .setExpirationTime("10m")
      .sign(privateKey);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await new Promise((r) => jwks?.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("incluye platform.yaml y los archivos que referencia en plataforma/, con su SHA-256 en el manifiesto", async () => {
    const h = { authorization: `Bearer ${token}` };
    const created = await fetch(`${base}/exports`, { method: "POST", headers: h });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };

    let job: {
      status: string;
      manifest?: { items: Array<{ tipo: string; archivo: string; sha256: string }> };
    } = {
      status: "en_curso",
    };
    for (let i = 0; i < 50 && job.status === "en_curso"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await (await fetch(`${base}/exports/${id}`, { headers: h })).json()) as typeof job;
    }
    expect(job.status).toBe("listo");
    const plataforma = job.manifest!.items.filter((i) => i.tipo === "plataforma").map((i) => i.archivo);
    expect(plataforma).toEqual([
      "plataforma/platform.yaml",
      "plataforma/workflows/workflow-extensions.xml",
      "plataforma/governance/guia-estilo-institucional.yaml",
    ]);

    const zip = unzipSync(
      new Uint8Array(await (await fetch(`${base}/exports/${id}/download`, { headers: h })).arrayBuffer()),
    );
    const manifest = JSON.parse(strFromU8(zip["manifiesto.json"]!)) as {
      items: Array<{ archivo: string; sha256: string }>;
    };
    for (const it of manifest.items) expect(sha(zip[it.archivo]!), it.archivo).toBe(it.sha256);
    expect(
      Buffer.from(zip["plataforma/platform.yaml"]!).equals(
        readFileSync(join(raiz, "wso2/apim/platform.yaml")),
      ),
    ).toBe(true);
  });
});
