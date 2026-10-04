/**
 * Motor de grabación de las demostraciones.
 *
 * Se abren dos contextos de Chromium: el «operado», donde el guion usa la Consola y los portales de WSO2
 * contra el laboratorio, y el «narrador», que es el único que se graba (1280×720). El narrador muestra el
 * banner persistente (versión, commit, ambiente, fecha y hora de Santiago), los rótulos de cada paso, la
 * salida del escenario y, en vivo, la pantalla del contexto operado. El video no se edita: solo se recorta
 * el instante previo a la portada y se recodifica.
 *
 * Si alguna verificación del escenario falla, el video se descarta y el proceso termina con error.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { desdeRaiz, fechaSantiago, isoSantiago, PAQUETE, SALIDA, type Meta } from "./entorno.js";
import { Estudio } from "./estudio.js";
import { CLAVE_LAB, dormir } from "./lab.js";
import { analizarVideo, portada, transcodificar, type InfoVideo } from "./video.js";

export type Vista = "dividido" | "app" | "terminal" | "panel" | "terminal-panel" | "panel-completo";
export type TipoLinea = "cmd" | "ok" | "mal" | "aviso" | "tenue" | "titulo" | undefined;

export interface Verificacion {
  texto: string;
  ok: boolean;
  detalle?: string;
}

export interface ResultadoDemo {
  /** Resultado medido en una frase (p. ej. «conmutación en 7 s, sin pérdida de datos»). */
  medido: string;
  /** Datos medidos que quedan en evidencias.json. */
  datos?: Record<string, unknown>;
}

export interface Demo {
  id: string;
  /** Nombre del archivo sin extensión, p. ej. «D-01_descubrimiento». */
  archivo: string;
  nombre: string;
  afirmacion: string;
  /** Cantidad de pasos que anuncia el rótulo («Paso 2 de 6»). */
  pasos: number;
  /** Persona con la que la Consola queda abierta antes de empezar a grabar (opcional). */
  usuarioInicial?: string;
  /** Preparación del laboratorio antes de grabar (se informa en la terminal al inicio). */
  preparar?(c: Contexto): Promise<string[] | void>;
  ejecutar(c: Contexto): Promise<ResultadoDemo>;
  /** Siempre se ejecuta al final (deja el laboratorio como estaba). */
  limpiar?(c: Contexto): Promise<void>;
}

/** Nombres del laboratorio (en /etc/hosts) que nunca deben pasar por un proxy de salida. */
const HOSTS_LAB = "apim,keycloak,mi,rabbitmq,opensearch,prometheus,grafana,jaeger,otel-collector,dev.nexo.lab,qa.nexo.lab,operadores.nexo.lab,publico.nexo.lab";
export const ENV_HIJOS = (): Record<string, string> => {
  const np = [process.env.NO_PROXY ?? process.env.no_proxy ?? "", HOSTS_LAB].filter(Boolean).join(",");
  return { ...(process.env as Record<string, string>), NO_PROXY: np, no_proxy: np, FORCE_COLOR: "0", NO_COLOR: "1" };
};
/** Chromium sin proxy: el laboratorio es local (los nombres resuelven a 127.0.0.1). */
export const lanzarNavegador = () =>
  chromium.launch({
    args: ["--disable-dev-shm-usage"],
    env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !/proxy/i.test(k) && v !== undefined)) as Record<string, string>,
  });

const VIEWPORT: Record<Vista, { width: number; height: number }> = {
  dividido: { width: 860, height: 570 },
  panel: { width: 860, height: 570 },
  app: { width: 1258, height: 570 },
  terminal: { width: 860, height: 570 },
  "terminal-panel": { width: 860, height: 570 },
  "panel-completo": { width: 860, height: 570 },
};

export class Contexto {
  app!: Page;
  appContext!: BrowserContext;
  navegador!: Browser;
  private contextosExtra: BrowserContext[] = [];
  private cdp?: CDPSession;
  private enPantalla?: Page;
  private grabando = false;
  private nPaso = 0;
  private inicio = 0;
  readonly verificaciones: Verificacion[] = [];
  readonly archivos: string;
  private vistaActual: Vista = "dividido";

  constructor(
    readonly demo: Demo,
    readonly estudio: Estudio,
    readonly meta: Meta,
    archivos: string,
  ) {
    this.archivos = archivos;
  }

  /** Abre otra sesión de navegador (p. ej. la persona aprobadora en paralelo a la solicitante). */
  async nuevaSesion(): Promise<Page> {
    const ctx = await this.navegador.newContext({ viewport: VIEWPORT[this.vistaActual], locale: "es-CL", timezoneId: "America/Santiago", ignoreHTTPSErrors: true, acceptDownloads: true });
    await ctx.addInitScript({ path: resolve(PAQUETE, "estudio/cursor.js") });
    this.contextosExtra.push(ctx);
    const p = await ctx.newPage();
    p.setDefaultTimeout(30_000);
    return p;
  }

  async cerrarSesionesExtra() {
    for (const c of this.contextosExtra) await c.close().catch(() => undefined);
    this.contextosExtra = [];
  }

  /** Muestra en el monitor del video la pantalla de esta página (y la usa como «app» para clic/escribir). */
  async mostrar(p: Page) {
    if (this.enPantalla === p && this.cdp) return;
    if (this.cdp) {
      await this.cdp.send("Page.stopScreencast").catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
    }
    this.app = p;
    this.enPantalla = p;
    const vp = VIEWPORT[this.vistaActual];
    const actual = p.viewportSize();
    if (!actual || actual.width !== vp.width || actual.height !== vp.height) await p.setViewportSize(vp);
    if (!this.grabando) return;
    const cdp = await p.context().newCDPSession(p);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
      if (this.cdp !== cdp) return;
      this.estudio.cuadro(Buffer.from(f.data, "base64"));
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1258, maxHeight: 570, everyNthFrame: 1 });
    if (!(p as Page & { __nexoUrl?: boolean }).__nexoUrl) {
      (p as Page & { __nexoUrl?: boolean }).__nexoUrl = true;
      p.on("framenavigated", (f) => {
        if (f === p.mainFrame() && this.enPantalla === p) this.estudio.publicar({ monitor: { url: f.url(), activo: true } });
      });
    }
    this.estudio.publicar({ monitor: { url: p.url(), activo: true } });
  }

  /** Revisa cada 1,5 s el texto visible de la pantalla mostrada en el monitor. */
  private revisor?: NodeJS.Timeout;
  private revisarPantalla() {
    this.revisor = setInterval(() => {
      const p = this.enPantalla;
      if (!p || p.isClosed()) return;
      p.evaluate(() => document.body?.innerText ?? "")
        .then((t) => {
          const m = Contexto.PROHIBIDO.exec(t);
          if (m) this.infracciones.push(`pantalla ${p.url()}: «${t.slice(Math.max(0, m.index - 40), m.index + 40)}»`);
        })
        .catch(() => undefined);
    }, 1500);
  }

  async iniciarPantalla() {
    this.revisarPantalla();
    this.grabando = true;
    const p = this.app;
    this.enPantalla = undefined;
    await this.mostrar(p);
  }

  async detenerPantalla() {
    if (this.revisor) clearInterval(this.revisor);
    this.grabando = false;
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
  }

  /** Ingresa a un portal de WSO2 (Publisher, Dev Portal o Admin) con el usuario admin del laboratorio. */
  async ingresarWso2(portal: "publisher" | "devportal" | "admin", usuario = "admin", clave = process.env.APIM_ADMIN_PASSWORD ?? "admin", p: Page = this.app) {
    await p.goto(`https://apim:9443/${portal}/${portal === "admin" ? "" : "apis"}`);
    if (portal === "devportal") {
      await p.waitForLoadState("networkidle").catch(() => undefined);
      // El Dev Portal en español rotula «REGISTRARSE» el botón que lleva al inicio de sesión.
      const entrar = p.getByText(/registrarse|sign-in|iniciar sesión/i).first();
      if (!(await p.locator("#username").isVisible().catch(() => false))) {
        await entrar.waitFor({ timeout: 30_000 });
        await (p === this.app ? this.clic(entrar) : entrar.click());
      }
    }
    await p.locator("#username").waitFor({ timeout: 60_000 });
    if (p === this.app) {
      await this.escribir("#username", usuario, 15);
      await this.escribir("#password", clave, 8);
      await this.clic("button[type=submit], input[type=submit]", 150);
    } else {
      await p.locator("#username").fill(usuario);
      await p.locator("#password").fill(clave);
      await p.locator("button[type=submit], input[type=submit]").first().click();
    }
    await p.waitForURL((u) => u.pathname.startsWith(`/${portal}`) && !u.pathname.includes("/services/auth"), { timeout: 60_000 });
  }

  marcarInicio() {
    this.inicio = Date.now();
    this.estudio.publicar({ inicio: this.inicio });
  }

  /** Segundos desde que empezó la grabación. */
  segundos(): number {
    return (Date.now() - this.inicio) / 1000;
  }

  hora(): string {
    return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date());
  }

  /** Textos que nunca deben aparecer en un video publicado (nombre o identificador de un proceso de compra). */
  static readonly PROHIBIDO = /subtel|606-26/i;
  readonly infracciones: string[] = [];

  private vigilar(origen: string, texto: string) {
    if (Contexto.PROHIBIDO.test(texto)) this.infracciones.push(`${origen}: «${texto.slice(0, 120)}»`);
  }

  log(texto: string, tipo?: TipoLinea, conHora = true) {
    this.vigilar("terminal", texto);
    this.estudio.evento("linea", { texto, tipo, hora: conHora ? this.hora() : undefined });
    process.stdout.write(`  ${tipo === "mal" ? "!" : " "} ${texto}\n`);
  }

  limpiarTerminal(titulo?: string) {
    this.estudio.evento("limpiar", {});
    if (titulo) this.estudio.publicar({ terminal: { titulo } });
  }

  /** Avanza al paso siguiente: rótulo inferior y título en la terminal. */
  paso(texto: string) {
    this.nPaso++;
    const etiqueta = `Paso ${this.nPaso} de ${this.demo.pasos}`;
    this.estudio.publicar({ rotulo: { paso: etiqueta, texto } });
    this.log(`── ${etiqueta}: ${texto}`, "titulo");
  }

  /** Cambia el texto del rótulo sin avanzar de paso. */
  rotulo(texto: string) {
    this.vigilar("rótulo", texto);
    this.estudio.publicar({ rotulo: { paso: this.nPaso ? `Paso ${this.nPaso} de ${this.demo.pasos}` : "", texto } });
  }

  async vista(v: Vista) {
    this.vistaActual = v;
    this.estudio.publicar({ vista: v });
    const vp = VIEWPORT[v];
    const actual = this.app.viewportSize();
    if (!actual || actual.width !== vp.width || actual.height !== vp.height) await this.app.setViewportSize(vp);
    await dormir(250);
  }

  get vistaVigente(): Vista {
    return this.vistaActual;
  }

  panel(html: string) {
    this.vigilar("panel", html);
    this.estudio.publicar({ panel: html });
  }

  verificar(texto: string, ok: boolean, detalle?: string): boolean {
    this.verificaciones.push({ texto, ok, detalle });
    this.log(`${ok ? "✓" : "✗"} ${texto}${detalle ? ` — ${detalle}` : ""}`, ok ? "ok" : "mal");
    return ok;
  }

  /** Como verificar, pero si no se cumple detiene el escenario (no tiene sentido seguir grabando). */
  exigir(texto: string, ok: boolean, detalle?: string): void {
    if (!this.verificar(texto, ok, detalle)) throw new Error(`no se cumplió: ${texto}${detalle ? ` (${detalle})` : ""}`);
  }

  esperar(ms: number) {
    return dormir(ms);
  }

  /** Lleva el puntero hasta el elemento (con movimiento visible) y hace clic. */
  async clic(objetivo: Locator | string, pausa = 350) {
    const loc = typeof objetivo === "string" ? this.app.locator(objetivo) : objetivo;
    await loc.first().scrollIntoViewIfNeeded();
    const caja = await loc.first().boundingBox();
    if (caja) await this.app.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2, { steps: 12 });
    await dormir(pausa);
    await loc.first().click();
  }

  /** Escribe como una persona (se ve en el video). */
  async escribir(objetivo: Locator | string, texto: string, retardo = 25) {
    const loc = typeof objetivo === "string" ? this.app.locator(objetivo) : objetivo;
    await this.clic(loc, 150);
    await loc.first().fill("");
    await loc.first().pressSequentially(texto, { delay: retardo });
  }

  async ir(url: string) {
    await this.app.goto(url.startsWith("http") ? url : `${this.estudio.url}${url}`);
  }

  /** Ingresa a la Consola con una persona del realm (flujo OIDC real con Keycloak). */
  async ingresarConsola(usuario: string) {
    const p = this.app;
    await p.goto(`${this.estudio.url}/`);
    const salir = p.getByTestId("btn-logout");
    const entrar = p.getByTestId("btn-oidc-login");
    await Promise.race([salir.waitFor({ timeout: 20_000 }), entrar.waitFor({ timeout: 20_000 })]);
    if (await salir.isVisible()) {
      const actual = (await p.getByTestId("current-user").textContent().catch(() => "")) ?? "";
      await this.clic(salir);
      await Promise.race([entrar.waitFor({ timeout: 20_000 }), p.waitForURL(/keycloak/, { timeout: 20_000 })]).catch(() => undefined);
      if (/keycloak/.test(p.url())) {
        // Cierre de sesión en Keycloak con confirmación.
        const btn = p.locator("#kc-logout");
        if (await btn.isVisible().catch(() => false)) await btn.click();
        await p.goto(`${this.estudio.url}/`);
      }
      void actual;
      await entrar.waitFor({ timeout: 20_000 });
    }
    await this.clic(entrar);
    await p.waitForURL(/keycloak:8080/, { timeout: 20_000 });
    await p.locator("#username").waitFor();
    await this.escribir("#username", usuario, 18);
    await this.escribir("#password", CLAVE_LAB(), 10);
    await this.clic("#kc-login", 200);
    await p.waitForURL((u) => u.host === `localhost:${this.estudio.puerto}` && !u.pathname.startsWith("/auth/"), { timeout: 30_000 });
    await p.getByTestId("current-user").waitFor({ timeout: 30_000 });
  }

  /** Sigue la salida de un comando en segundo plano (p. ej. docker logs -f) hasta llamar a detener(). */
  seguir(cmd: string, args: string[], o: { mostrar?: string; filtro?: (l: string) => string | undefined; tipo?: (l: string) => TipoLinea } = {}) {
    if (o.mostrar !== "") this.log(`$ ${o.mostrar ?? [cmd, ...args].join(" ")} &`, "cmd");
    const hijo = spawn(cmd, args, { cwd: desdeRaiz(), env: ENV_HIJOS(), stdio: ["ignore", "pipe", "pipe"] });
    const procesar = (l0: string) => {
      const l = o.filtro ? o.filtro(l0) : l0;
      if (l !== undefined) this.log(l, o.tipo?.(l) ?? tipoPorDefecto(l));
    };
    createInterface({ input: hijo.stdout }).on("line", procesar);
    createInterface({ input: hijo.stderr }).on("line", procesar);
    return { detener: () => hijo.kill("SIGTERM") };
  }

  /** Hace clic en un control que descarga un archivo y devuelve la ruta donde quedó. */
  async descargar(objetivo: Locator | string, nombre?: string): Promise<string> {
    const espera = this.app.waitForEvent("download", { timeout: 60_000 });
    await this.clic(objetivo);
    const d = await espera;
    const ruta = join(this.archivos, nombre ?? d.suggestedFilename());
    await d.saveAs(ruta);
    return ruta;
  }

  /** Muestra una imagen de this.archivos en el panel lateral. */
  imagen(archivo: string, titulo?: string) {
    const rel = archivo.startsWith(this.archivos) ? archivo.slice(this.archivos.length + 1) : archivo;
    this.panel(`${titulo ? `<h3>${escaparHtml(titulo)}</h3>` : ""}<img src="/__estudio/archivos/${encodeURIComponent(rel)}" style="max-height:${titulo ? 540 : 572}px" />`);
  }

  /** Ejecuta un comando y muestra su salida en la terminal, línea a línea, mientras corre. */
  async ejecutarComando(
    cmd: string,
    args: string[],
    o: { cwd?: string; env?: Record<string, string>; mostrar?: string; filtro?: (l: string) => string | undefined; tipo?: (l: string) => TipoLinea; tablas?: boolean } = {},
  ): Promise<{ codigo: number; salida: string[] }> {
    this.log(`$ ${o.mostrar ?? [cmd, ...args].join(" ")}`, "cmd");
    const hijo = spawn(cmd, args, { cwd: o.cwd ?? desdeRaiz(), env: { ...ENV_HIJOS(), ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
    const salida: string[] = [];
    const tabla = new TablaConsola();
    const procesar = (bruta: string) => {
      salida.push(bruta);
      const filas = o.tablas === false ? undefined : tabla.alimentar(bruta);
      if (filas === null) return; // línea de una tabla en curso
      const lineas = filas ?? [bruta];
      for (const l0 of lineas) {
        const l = o.filtro ? o.filtro(l0) : l0;
        if (l === undefined) continue;
        this.log(l, o.tipo?.(l) ?? tipoPorDefecto(l));
      }
    };
    createInterface({ input: hijo.stdout }).on("line", procesar);
    createInterface({ input: hijo.stderr }).on("line", procesar);
    const codigo = await new Promise<number>((ok) => hijo.on("close", (c) => ok(c ?? 1)));
    this.log(`(código de salida ${codigo})`, codigo === 0 ? "tenue" : "mal");
    return { codigo, salida };
  }
}

export function escaparHtml(t: string): string {
  return t.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function tipoPorDefecto(l: string): TipoLinea {
  if (/^\s*✓|verificado|\bOK\b/.test(l)) return "ok";
  if (/^\s*✗|ERROR|NO cumple|BLOQUEAD/.test(l)) return "mal";
  if (/advertencia|\bwarn/i.test(l)) return "aviso";
  return undefined;
}

/**
 * Convierte la salida de console.table (que no cabe en la terminal del video) en líneas legibles:
 * una por fila, «✓/✗ prueba — obtenido», tomando las columnas «cumple», «prueba»/«escenario» y «obtenido».
 */
class TablaConsola {
  private cabecera?: string[];
  private enTabla = false;

  /** null: la línea pertenece a una tabla (se omite); array: filas convertidas; undefined: línea normal. */
  alimentar(l: string): string[] | null | undefined {
    const t = l.trim();
    if (t.startsWith("┌")) {
      this.enTabla = true;
      this.cabecera = undefined;
      return null;
    }
    if (!this.enTabla) return undefined;
    if (t.startsWith("└")) {
      this.enTabla = false;
      return null;
    }
    if (t.startsWith("├")) return null;
    if (!t.startsWith("│")) return undefined;
    const celdas = t
      .split("│")
      .slice(1, -1)
      .map((c) => c.trim().replace(/^'(.*)'$/, "$1"));
    if (!this.cabecera) {
      this.cabecera = celdas;
      return null;
    }
    const fila = Object.fromEntries(this.cabecera.map((h, i) => [h, celdas[i] ?? ""]));
    const nombre = fila.prueba ?? fila.escenario ?? fila.requisito ?? celdas[1] ?? "";
    const obtenido = fila.obtenido ?? "";
    const cumple = fila.cumple;
    const marca = cumple === undefined ? "·" : cumple === "true" ? "✓" : "✗";
    return [`${marca} ${nombre}${obtenido ? ` — ${obtenido}` : ""}`];
  }
}

export interface Evidencia {
  id: string;
  title: string;
  claim: string;
  file: string;
  poster?: string;
  duration_seconds: number;
  frames: number;
  sha256: string;
  size_bytes: number;
  version: string;
  commit: string;
  recorded_at: string;
  environment: string;
  result: string;
  checks: Array<{ texto: string; ok: boolean; detalle?: string }>;
  data?: Record<string, unknown>;
}

export interface OpcionesGrabacion {
  meta: Meta;
  navegador?: Browser;
}

const CONFIG_CONSOLA = (meta: Meta) => ({
  apiBaseUrl: "/api/v1",
  environmentLabel: meta.ambiente,
  version: `${meta.version} (commit ${meta.commit})`,
  auth: {
    provider: "oidc",
    oidc: { authority: "http://keycloak:8080/realms/nexo", clientId: "nexo-console", rolesClaimPath: "resource_access.nexo-console.roles" },
  },
  demoBanner: true,
});

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Graba una demostración. Devuelve la evidencia o lanza un error (y no deja video) si algo no se cumple. */
export async function grabar(demo: Demo, o: OpcionesGrabacion): Promise<Evidencia> {
  const trabajo = mkdtempSync(join(tmpdir(), `evid-${demo.id}-`));
  const archivos = join(trabajo, "archivos");
  mkdirSync(archivos, { recursive: true });
  const estudio = new Estudio({ configConsola: CONFIG_CONSOLA(o.meta), archivos });
  await estudio.iniciar();
  const navegador = o.navegador ?? (await lanzarNavegador());
  const c = new Contexto(demo, estudio, o.meta, archivos);
  c.navegador = navegador;
  let narrador: BrowserContext | undefined;
  const fechaGrabacion = new Date();
  let crudo: string | undefined;
  let error: unknown;
  let resultado: ResultadoDemo | undefined;
  let recorte = 0;
  try {
    // Contexto operado (no se graba directamente: se ve dentro del narrador).
    c.appContext = await navegador.newContext({
      viewport: VIEWPORT.dividido,
      locale: "es-CL",
      timezoneId: "America/Santiago",
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });
    await c.appContext.addInitScript({ path: resolve(PAQUETE, "estudio/cursor.js") });
    c.app = await c.appContext.newPage();
    c.app.setDefaultTimeout(30_000);
    const notas = (await demo.preparar?.(c)) ?? [];
    if (demo.usuarioInicial) await c.ingresarConsola(demo.usuarioInicial);

    // Narrador (se graba).
    estudio.publicar({
      vista: "portada",
      banner: { producto: `Yago Nexo ${o.meta.version} · commit ${o.meta.commit}`, ambiente: o.meta.ambiente },
      portada: {
        id: demo.id,
        nombre: demo.nombre,
        version: `Yago Nexo ${o.meta.version} (commit ${o.meta.commit})`,
        fecha: fechaSantiago(fechaGrabacion),
        ambiente: o.meta.ambiente,
        afirmacion: demo.afirmacion,
      },
      rotulo: { paso: "", texto: `${demo.id} · ${demo.nombre}` },
      monitor: { url: c.app.url(), activo: false },
      terminal: { titulo: "Salida del escenario" },
      panel: "",
    });
    narrador = await navegador.newContext({
      viewport: { width: 1280, height: 720 },
      locale: "es-CL",
      timezoneId: "America/Santiago",
      recordVideo: { dir: trabajo, size: { width: 1280, height: 720 } },
    });
    const pn = await narrador.newPage();
    const tPagina = Date.now();
    await pn.goto(`${estudio.url}/__estudio/`);
    await pn.waitForFunction(() => (window as unknown as { __estudioListo?: boolean }).__estudioListo === true && document.getElementById("p-nombre")!.textContent !== "");
    recorte = Math.max(0, (Date.now() - tPagina) / 1000 - 0.1);
    c.marcarInicio();

    // Pantalla del navegador operado, en vivo.
    await c.iniciarPantalla();

    await dormir(6500); // portada
    await c.vista("dividido");
    if (notas.length) {
      c.log("Preparación del laboratorio antes de grabar:", "tenue");
      for (const n of notas) c.log(`  · ${n}`, "tenue");
    }
    resultado = await demo.ejecutar(c);
    if (c.infracciones.length) throw new Error(`apareció texto no publicable en el video: ${[...new Set(c.infracciones)].slice(0, 3).join(" · ")}`);
    const fallidas = c.verificaciones.filter((v) => !v.ok);
    if (!c.verificaciones.length) throw new Error("el escenario no registró verificaciones");
    if (fallidas.length) throw new Error(`verificaciones fallidas: ${fallidas.map((v) => `${v.texto}${v.detalle ? ` (${v.detalle})` : ""}`).join("; ")}`);
    estudio.publicar({
      vista: "resultado",
      rotulo: { paso: "", texto: `${demo.id} · resultado: ${resultado.medido}` },
      resultado: {
        ok: true,
        titulo: `${demo.id} · ${demo.nombre}`,
        medido: resultado.medido,
        verificaciones: c.verificaciones.slice(-12).map((v) => ({ ok: v.ok, texto: v.detalle ? `${v.texto}: ${v.detalle}` : v.texto })),
        nota: `${c.verificaciones.length} verificaciones automáticas cumplidas · grabación continua de ${Math.round(c.segundos())} s, sin cortes ni aceleración.`,
      },
    });
    await dormir(7000);
  } catch (e) {
    error = e;
    // Depuración: captura de la pantalla operada al fallar (EVIDENCIAS_DEPURACION=<carpeta>).
    const dep = process.env.EVIDENCIAS_DEPURACION;
    if (dep && c.app && !c.app.isClosed()) {
      mkdirSync(dep, { recursive: true });
      await c.app.screenshot({ path: join(dep, `${demo.id}-fallo.png`), fullPage: true }).catch(() => undefined);
    }
  } finally {
    await c.detenerPantalla();
    try {
      await demo.limpiar?.(c);
    } catch (e) {
      console.error(`[${demo.id}] limpieza: ${e instanceof Error ? e.message : e}`);
    }
    if (narrador) {
      const pagina = narrador.pages()[0];
      await narrador.close();
      crudo = await pagina?.video()?.path();
    }
    await c.cerrarSesionesExtra();
    await c.appContext?.close().catch(() => undefined);
    if (!o.navegador) await navegador.close();
    await estudio.detener();
  }

  if (error || !resultado || !crudo) {
    rmSync(trabajo, { recursive: true, force: true });
    throw error instanceof Error ? error : new Error(String(error ?? "sin video"));
  }
  mkdirSync(SALIDA, { recursive: true });
  const destino = join(SALIDA, `${demo.archivo}.webm`);
  await transcodificar(crudo, destino, recorte);
  const info: InfoVideo = await analizarVideo(destino);
  await portada(destino, join(SALIDA, `${demo.archivo}.jpg`)).catch(() => undefined);
  rmSync(trabajo, { recursive: true, force: true });
  if (info.duracion > 180 || info.cuadros === 0) {
    rmSync(destino, { force: true });
    throw new Error(`video fuera de norma: ${info.duracion.toFixed(1)} s, ${info.cuadros} cuadros`);
  }
  return {
    id: demo.id,
    title: demo.nombre,
    claim: demo.afirmacion,
    file: `${demo.archivo}.webm`,
    poster: `${demo.archivo}.jpg`,
    duration_seconds: Math.round(info.duracion * 10) / 10,
    frames: info.cuadros,
    sha256: sha256(destino),
    size_bytes: statSync(destino).size,
    version: o.meta.version,
    commit: o.meta.commit,
    recorded_at: isoSantiago(fechaGrabacion),
    environment: o.meta.ambiente,
    result: resultado.medido,
    checks: c.verificaciones,
    ...(resultado.datos ? { data: resultado.datos } : {}),
  };
}
