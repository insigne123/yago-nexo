/**
 * Sonda TLS 1.0 con control negativo: un servidor local que acepta TLS 1.0 debe dar «aceptado» y uno que exige
 * TLS 1.2 debe dar «rechazado». Genera un certificado desechable con openssl (si no está, la prueba se omite).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type TlsOptions } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejectsTls10, tlsAttempt } from "./tls-probe.js";

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("decisión «rechaza TLS 1.0»", () => {
  it("sin conexión moderna no se informa nada", () => {
    expect(rejectsTls10({ ok: false, error: "ECONNREFUSED" }, { ok: false, error: "ECONNREFUSED" })).toBe(
      undefined,
    );
  });
  it("un fallo del propio cliente o de red no cuenta como rechazo", () => {
    const modern = { ok: true, protocol: "TLSv1.3" };
    for (const error of ["ERR_SSL_NO_PROTOCOLS_AVAILABLE", "ECONNREFUSED", "ETIMEDOUT", undefined])
      expect(rejectsTls10(modern, { ok: false, error })).toBe(undefined);
  });
  it("una alerta del servidor es un rechazo; un saludo aceptado no", () => {
    const modern = { ok: true, protocol: "TLSv1.3" };
    expect(rejectsTls10(modern, { ok: false, error: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" })).toBe(true);
    expect(rejectsTls10(modern, { ok: true, protocol: "TLSv1" })).toBe(false);
  });
});

describe.skipIf(!opensslAvailable())("sonda TLS contra servidores locales", () => {
  let dir = "";
  const servers: Server[] = [];
  let tls10Port = 0;
  let tls12Port = 0;
  let closedPort = 0;

  async function listen(opts: TlsOptions): Promise<number> {
    const server = createServer(opts, (s) => s.end());
    server.on("tlsClientError", () => undefined);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nexo-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
      ],
      { stdio: "ignore" },
    );
    const key = readFileSync(join(dir, "k.pem"));
    const cert = readFileSync(join(dir, "c.pem"));
    tls10Port = await listen({ key, cert, minVersion: "TLSv1", ciphers: "DEFAULT@SECLEVEL=0" });
    tls12Port = await listen({ key, cert, minVersion: "TLSv1.2" });
    const tmp = createNetServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    closedPort = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
  });

  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("un servidor que acepta TLS 1.0 da «aceptado» (control negativo)", async () => {
    const modern = await tlsAttempt("127.0.0.1", tls10Port, "moderno");
    const legacy = await tlsAttempt("127.0.0.1", tls10Port, "tls10");
    expect(modern.ok).toBe(true);
    expect(legacy).toMatchObject({ ok: true, protocol: "TLSv1" });
    expect(rejectsTls10(modern, legacy)).toBe(false);
  });

  it("un servidor que exige TLS 1.2 da «rechazado»", async () => {
    const modern = await tlsAttempt("127.0.0.1", tls12Port, "moderno");
    const legacy = await tlsAttempt("127.0.0.1", tls12Port, "tls10");
    expect(modern.ok).toBe(true);
    expect(legacy.ok).toBe(false);
    expect(legacy.error).not.toBe("ERR_SSL_NO_PROTOCOLS_AVAILABLE");
    expect(rejectsTls10(modern, legacy)).toBe(true);
  });

  it("un canal caído no se informa como «rechazado»", async () => {
    const modern = await tlsAttempt("127.0.0.1", closedPort, "moderno");
    const legacy = await tlsAttempt("127.0.0.1", closedPort, "tls10");
    expect(rejectsTls10(modern, legacy)).toBe(undefined);
  });
});
