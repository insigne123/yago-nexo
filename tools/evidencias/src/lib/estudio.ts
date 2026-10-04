/**
 * Servidor local del estudio de grabación (http://localhost:5173, una de las URL de retorno del cliente
 * nexo-console en Keycloak):
 *   - sirve la Consola Nexo compilada (apps/console-web/dist) con un /config.json OIDC contra el Keycloak del
 *     laboratorio, y reenvía /api a la API de la Consola que corre en Docker (sin datos simulados);
 *   - sirve la página «narradora» (/__estudio/), que es lo único que se graba: muestra el banner, los
 *     rótulos, la terminal con la salida del escenario y, en vivo, la pantalla del navegador que opera
 *     la Consola y los portales (MJPEG desde el screencast de Chromium).
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { desdeRaiz, PAQUETE } from "./entorno.js";

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

export interface EstadoEstudio {
  [k: string]: unknown;
}

export interface OpcionesEstudio {
  puerto?: number;
  /** API de la Consola en el laboratorio. */
  api?: string;
  /** Contenido de /config.json para la Consola. */
  configConsola: Record<string, unknown>;
  /** Carpeta con archivos generados durante la demostración (se sirven en /__estudio/archivos/). */
  archivos: string;
}

export class Estudio {
  private server?: Server;
  private sse = new Set<ServerResponse>();
  private mjpeg = new Set<ServerResponse>();
  private ultimoCuadro?: Buffer;
  private estado: EstadoEstudio = {};
  readonly puerto: number;
  private readonly dist = desdeRaiz("apps/console-web/dist");
  private readonly narrador = resolve(PAQUETE, "estudio");

  constructor(private readonly o: OpcionesEstudio) {
    this.puerto = o.puerto ?? 5173;
    if (!existsSync(join(this.dist, "index.html"))) {
      throw new Error("falta apps/console-web/dist: ejecute pnpm --filter @nexo/console-web build");
    }
  }

  get url(): string {
    return `http://localhost:${this.puerto}`;
  }

  async iniciar(): Promise<void> {
    this.server = createServer((req, res) => {
      this.atender(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e instanceof Error ? e.message : e));
      });
    });
    await new Promise<void>((ok, mal) => {
      this.server!.once("error", mal);
      this.server!.listen(this.puerto, "127.0.0.1", () => ok());
    });
  }

  async detener(): Promise<void> {
    for (const r of [...this.sse, ...this.mjpeg]) r.end();
    this.sse.clear();
    this.mjpeg.clear();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
    this.server?.closeAllConnections?.();
  }

  /** Mezcla cambios en el estado y los envía a la página narradora. */
  publicar(cambios: EstadoEstudio): void {
    this.estado = { ...this.estado, ...cambios };
    const msg = `data: ${JSON.stringify(cambios)}\n\n`;
    for (const r of this.sse) r.write(msg);
  }

  /** Un evento puntual (no queda en el estado), p. ej. una línea de terminal. */
  evento(tipo: string, datos: unknown): void {
    const msg = `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
    for (const r of this.sse) r.write(msg);
  }

  /** Cuadro JPEG del navegador operado (screencast). */
  cuadro(jpeg: Buffer): void {
    this.ultimoCuadro = jpeg;
    for (const r of this.mjpeg) this.escribirCuadro(r, jpeg);
  }

  private escribirCuadro(r: ServerResponse, jpeg: Buffer) {
    r.write(`--cuadro\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    r.write(jpeg);
    r.write("\r\n");
  }

  private async atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const p = url.pathname;
    if (p === "/config.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.o.configConsola));
      return;
    }
    if (p.startsWith("/api/")) return this.reenviar(req, res, url);
    if (p === "/__estudio/eventos") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(this.estado)}\n\n`);
      this.sse.add(res);
      req.on("close", () => this.sse.delete(res));
      return;
    }
    if (p === "/__estudio/monitor.mjpg") {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=cuadro", "cache-control": "no-store", connection: "keep-alive" });
      this.mjpeg.add(res);
      if (this.ultimoCuadro) this.escribirCuadro(res, this.ultimoCuadro);
      req.on("close", () => this.mjpeg.delete(res));
      return;
    }
    if (p.startsWith("/__estudio/archivos/")) return this.estatico(res, this.o.archivos, p.slice("/__estudio/archivos/".length), false);
    if (p === "/__estudio/logo.svg") return this.estatico(res, desdeRaiz("apps/site/static/img"), "logo.svg", false);
    if (p === "/__estudio" || p.startsWith("/__estudio/")) {
      const rel = p.replace(/^\/__estudio\/?/, "") || "index.html";
      return this.estatico(res, this.narrador, rel, false);
    }
    return this.estatico(res, this.dist, p.slice(1) || "index.html", true);
  }

  private estatico(res: ServerResponse, base: string, rel: string, spa: boolean): void {
    const ruta = normalize(join(base, decodeURIComponent(rel)));
    if (!ruta.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    let archivo = ruta;
    if (!existsSync(archivo) || statSync(archivo).isDirectory()) {
      if (!spa) {
        res.writeHead(404, { "content-type": "text/plain" }).end("no existe");
        return;
      }
      archivo = join(base, "index.html");
    }
    const tipo = TIPOS[extname(archivo).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-store" });
    if (tipo.startsWith("text/html")) res.end(readFileSync(archivo));
    else createReadStream(archivo).pipe(res);
  }

  /** Reenvía /api/* a la API de la Consola del laboratorio (mismo origen para el navegador). */
  private reenviar(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const destino = new URL(url.pathname + url.search, this.o.api ?? "http://localhost:8090");
    return new Promise((ok) => {
      const headers = { ...req.headers, host: destino.host };
      delete headers.origin;
      delete headers.referer;
      const sale = httpRequest(destino, { method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on("end", () => ok());
      });
      sale.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`API de la Consola no disponible: ${e.message}`);
        ok();
      });
      req.pipe(sale);
    });
  }
}
