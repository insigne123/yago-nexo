import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MiManagementClient } from "./mi.js";

/** Management API simulada: entrega tokens numerados y considera vencido todo token anterior al último. */
let server: Server;
let base = "";
let emitidos = 0;
let vigente = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/management/login") {
      vigente = `token-${++emitidos}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ AccessToken: vigente }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${vigente}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"Error":"token vencido"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 1, list: [{ name: "SolicitudesConcesionAPI", url: "/x" }] }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("MiManagementClient", () => {
  it("renueva el token vencido y reintenta una vez", async () => {
    const mi = new MiManagementClient(base, "admin", "x");
    expect((await mi.apis()).count).toBe(1);
    vigente = "otro"; // el servidor invalida el token entregado (como al cumplirse la hora)
    expect((await mi.apis()).list[0]?.name).toBe("SolicitudesConcesionAPI");
    expect(emitidos).toBe(2);
  });
});
