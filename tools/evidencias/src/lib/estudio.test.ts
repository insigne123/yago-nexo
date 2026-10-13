import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Estudio } from "./estudio.js";

describe("MJPEG de la pantalla operada", () => {
  it("cada cuadro va seguido del separador y de la cabecera de la parte siguiente (Chromium lo dibuja de inmediato)", async () => {
    const estudio = new Estudio({ configConsola: {}, archivos: tmpdir(), ensayo: true, puerto: 0 });
    await estudio.iniciar();
    try {
      const { port } = (estudio as unknown as { server: { address(): AddressInfo } }).server.address();
      const recibido = await new Promise<string>((ok, mal) => {
        const partes: Buffer[] = [];
        const req = request({ host: "127.0.0.1", port, path: "/__estudio/monitor.mjpg" }, (res) => {
          expect(res.headers["content-type"]).toBe("multipart/x-mixed-replace; boundary=cuadro");
          res.on("data", (d: Buffer) => partes.push(d));
          setTimeout(() => {
            estudio.cuadro(Buffer.from("CUADRO-1"));
            estudio.cuadro(Buffer.from("CUADRO-2"));
          }, 50);
          setTimeout(() => {
            req.destroy();
            ok(Buffer.concat(partes).toString("latin1"));
          }, 250);
        });
        req.on("error", mal);
        req.end();
      });
      const cabecera = "--cuadro\r\nContent-Type: image/jpeg\r\n\r\n";
      expect(recibido).toBe(`${cabecera}CUADRO-1\r\n${cabecera}CUADRO-2\r\n${cabecera}`);
    } finally {
      await estudio.detener();
    }
  });
});
