/**
 * Motor de grabación de las demostraciones.
 *
 * Se abren dos contextos de Chromium: el «operado», donde el guion usa la Consola y los portales de WSO2
 * contra el laboratorio, y el «narrador» (1920×1080), que es lo único que se graba. El narrador muestra el
 * banner persistente (versión, commits, ambiente, fecha y hora de Santiago), el panel lateral del paso, la
 * barra de capítulos, la salida del escenario y, en vivo, la pantalla del contexto operado con el cursor
 * resaltado y las ampliaciones. Todas las capas ocurren durante la captura: el video no se edita.
 *
 * Captura propia (src/lib/captura.ts): screencast de Chromium (cada cuadro con la hora real en que se dibujó)
 * llevado a 30 cps constantes según esas horas y codificado UNA sola vez a H.264 al terminar la toma.
 * Después video.ts mezcla la música con -c:v copy (la imagen no se vuelve a codificar; se comprueba con el
 * MD5 del flujo de video) y escribe subtítulos y capítulos desde el pasos.json que deja este motor.
 *
 * Si alguna verificación del escenario falla, si aparece un texto prohibido, si un paso dura menos de 7 s o
 * si el video pasa de 240 s, el video se descarta y el proceso termina con error (en ensayo solo se avisa;
 * en un guion que todavía usa c.paso(texto), el mínimo de 7 s y el panel vacío son avisos).
 *
 * API para los guiones: ver `ApiEstudio` (c.estudio.paso, comprueba, clic, escribir, elegir, desplazar,
 * zoom, esperar…) y el contrato de pasos.json en src/lib/pasos.ts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ANCHO, ALTO, Captura, CPS, type EstadisticasCaptura } from "./captura.js";
import { desdeRaiz, fechaSantiago, isoSantiago, PAQUETE, PRODUCTO, SALIDA, SALIDA_ENSAYO, type Meta } from "./entorno.js";
import { Estudio, type Medidas } from "./estudio.js";
import { CLAVE_LAB, dormir, enEnsayo, ENSAYO, reescribirUrlEnsayo, URL_LAB } from "./lab.js";
import { RegistroPasos, validarPasos, type DefinicionPaso, type PasosJson } from "./pasos.js";
import { arrastreAlCerrar, listaComprobaciones, ordenCierre, type Arrastre, resumenVerificaciones, textoFirma, textoOcultas } from "./panel.js";
import { CIERRE_S, duracionMinimaMs, esperaAlCerrar, pausaLectura, PASO_MINIMO_S, PORTADA_S, presupuesto, RegistroZoom, TOPE_VIDEO_S } from "./ritmo.js";
import {
  dentroDeVista,
  distancia,
  duracionMovimiento,
  PAUSA_ANTES_DE_CLIC_MS,
  puntoObjetivo,
  ritmoEscritura,
  trayectoria,
  type Caja,
  type Punto,
} from "./trayectoria.js";
import { terminarVideo, type Publicacion } from "./video.js";
import { Vigilante } from "./vigilancia.js";
import { fueraDeVentana, textoInsignia, ventanaZoom, ZOOM_FACTOR_MIN, ZOOM_FACTOR_POR_DEFECTO, ZOOM_TRANSICION_MS, type Ventana } from "./zoom.js";

export type { DefinicionPaso } from "./pasos.js";
export type Vista = "dividido" | "app" | "terminal" | "panel" | "terminal-panel" | "panel-completo";
export type TipoLinea = "cmd" | "ok" | "mal" | "aviso" | "tenue" | "titulo" | undefined;

/** Capas que el motor agrega sobre la grabación (se declaran en la portada, el cierre y evidencias.json). */
export const CAPAS = ["cursor resaltado", "ampliaciones en vivo", "narración", "música original"] as const;

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
  /** Cantidad de pasos que anuncia el rótulo («Paso 2 de 6»). Si hay agenda, manda su largo. */
  pasos: number;
  /**
   * Títulos de los pasos, en orden, para la agenda de la portada y la barra de capítulos (deben coincidir con
   * los títulos de estudio.paso(); si no coinciden, se avisa).
   */
  agenda?: string[];
  /** Persona con la que la Consola queda abierta antes de empezar a grabar (opcional). */
  usuarioInicial?: string;
  /** Preparación del laboratorio antes de grabar (se informa en la terminal al inicio). */
  preparar?(c: Contexto): Promise<string[] | void>;
  ejecutar(c: Contexto): Promise<ResultadoDemo>;
  /** Siempre se ejecuta al final (deja el laboratorio como estaba). */
  limpiar?(c: Contexto): Promise<void>;
}

/** Objetivo de una acción: un Locator, un selector CSS/Playwright o una caja en píxeles CSS de la página. */
export type Objetivo = Locator | string | Caja;

export interface OpcionesClic {
  /** Página en la que actuar (por defecto la que está en pantalla). */
  pagina?: Page;
  /** Pausa con el objetivo enmarcado antes del clic (por defecto 600 ms). */
  pausaMs?: number;
  doble?: boolean;
}

export interface OpcionesEscribir {
  pagina?: Page;
  /** Milisegundos por letra (por defecto 80). */
  ms?: number;
  /** Oculta lo escrito en el teclado visible (por defecto: si el campo es de contraseña). */
  enmascarar?: boolean;
  /** Vacía el campo antes de escribir (por defecto sí). */
  limpiar?: boolean;
  /** Nombre del campo en el teclado visible (por defecto su etiqueta, aria-label o placeholder). */
  campo?: string;
  /** Pega el texto de una vez (se muestra «Ctrl+V»). Por defecto, para textos de más de 120 caracteres. */
  pegar?: boolean;
  /** Presiona Enter al final. */
  enter?: boolean;
}

export interface OpcionesZoom {
  /** Factor de ampliación (por defecto 1,8; se reduce si el objetivo no cabe). */
  factor?: number;
  /** Si se indica, mantiene la ampliación estos ms y vuelve sola a la vista completa. */
  ms?: number;
  /** Sigue al cursor cuando el guion actúa fuera de lo ampliado (por defecto sí). */
  seguir?: boolean;
}

/**
 * API de los guiones (c.estudio). Reglas: cada paso dura al menos 7 s (paso() espera lo que falte, con la
 * imagen en vivo, y deja 2,5 s a la vista la última verificación), el mouse siempre se ve viajar (nunca
 * clics instantáneos de Playwright sobre la pantalla grabada), la ampliación vuelve a la vista completa
 * antes de cada pausa y de cada paso, y como máximo el 35 % del video se ve ampliado. El video completo no
 * pasa de 240 s (portada 4 s + pasos + cierre 3 s; ver ritmo.ts).
 *
 *   const e = c.estudio;
 *   await e.paso({ titulo: "Aprobación con cuatro ojos", quePasa: "…", porQueImporta: "…", comprueba: ["quien solicita no aprueba"] });
 *   await e.clic(c.app.getByTestId("btn-approve-rollout"));          // viaja, enmarca 0,6 s, onda
 *   await e.escribir("#motivo", "Reversa por error 5xx");            // 80 ms por letra, teclado visible
 *   await e.elegir("#estrategia", "Canary");                         // lista desplegable visible
 *   await e.zoom(c.app.getByTestId("rollout-weight"), { ms: 2500 }); // ×1,8 en vivo, minimapa e insignia
 *   e.comprueba("quien solicita no aprueba", r.status === 403, `HTTP ${r.status}`);
 *   await e.esperar(1500);                                           // pausa de lectura (se escala con --ritmo)
 *   await c.esperar(30_000);                                         // espera de medición (nunca se escala)
 *
 * Otra página operada (p. ej. la persona aprobadora): `const p = await c.nuevaSesion(); await c.mostrar(p);`
 * y luego `e.clic(objetivo, { pagina: p })`. Las acciones sobre una página que no está en pantalla no se
 * animan (no se ven en el video).
 */
export interface ApiEstudio {
  /** URL del estudio (la Consola en http://localhost:5173). */
  readonly url: string;
  readonly puerto: number;
  /** true si se graba en modo ensayo (sin laboratorio). */
  readonly ensayo: boolean;
  /** Abre el paso siguiente (cierra el anterior cuando cumplió su mínimo). Devuelve su número. Siempre con await. */
  paso(def: DefinicionPaso): Promise<number>;
  /** Registra una verificación en vivo del paso actual (panel «Comprobado», terminal y pasos.json). */
  comprueba(texto: string, ok: boolean, valor?: string | number): boolean;
  /** Como comprueba(), pero si no se cumple detiene la grabación (en ensayo solo avisa). */
  exige(texto: string, ok: boolean, valor?: string | number): void;
  /** Indicadores en vivo del panel (p. ej. { "llamadas 1.0.0": 120, errores: 0 }). */
  indicadores(valores: Record<string, string | number>): void;
  /** Lleva el mouse al objetivo (trayectoria visible de 0,7 a 1,6 s). */
  mover(objetivo: Objetivo, o?: { pagina?: Page }): Promise<void>;
  /** Mueve, enmarca el objetivo 0,6 s y hace clic (onda visible). */
  clic(objetivo: Objetivo, o?: OpcionesClic): Promise<void>;
  /** Clic en el campo y escritura a ritmo humano (80 ms por letra) con el teclado visible. */
  escribir(objetivo: Objetivo, texto: string, o?: OpcionesEscribir): Promise<void>;
  /** Presiona una tecla o combinación (Enter, Tab, Escape, Control+A…) mostrándola en el teclado visible. */
  tecla(tecla: string, o?: { pagina?: Page }): Promise<void>;
  /** Elige una opción de un <select> mostrando la lista desplegable (por valor, texto o índice). */
  elegir(objetivo: Objetivo, opcion: string | RegExp | number, o?: { pagina?: Page }): Promise<void>;
  /** Marca o desmarca una casilla con un clic visible (si ya está como se pide, no hace nada). */
  marcar(objetivo: Objetivo, valor?: boolean, o?: { pagina?: Page }): Promise<void>;
  /** Desplazamiento suave: n píxeles (positivo hacia abajo) o hasta que el objetivo quede a la vista. */
  desplazar(a: Objetivo | number, o?: { pagina?: Page }): Promise<void>;
  /** Amplía en vivo el objetivo (×1,8, transición de 0,7 s, minimapa e insignia). */
  zoom(objetivo: Objetivo, o?: OpcionesZoom): Promise<void>;
  /** Vuelve a la vista completa (transición de 0,7 s). */
  zoomFuera(): Promise<void>;
  /** Pausa de lectura (vuelve a la vista completa; se escala con --ritmo). Para esperas de medición: c.esperar(). */
  esperar(ms: number): Promise<void>;
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
    args: ["--disable-dev-shm-usage", "--hide-scrollbars", "--force-color-profile=srgb"],
    env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !/proxy/i.test(k) && v !== undefined)) as Record<string, string>,
  });

/** Ventana operada por vista cuando la narradora no informó medidas (diseño anterior, 1280×720). */
const VIEWPORT: Record<Vista, { width: number; height: number }> = {
  dividido: { width: 860, height: 570 },
  panel: { width: 860, height: 570 },
  app: { width: 1258, height: 570 },
  terminal: { width: 860, height: 570 },
  "terminal-panel": { width: 860, height: 570 },
  "panel-completo": { width: 860, height: 570 },
};

const esCaja = (o: unknown): o is Caja =>
  typeof o === "object" && o !== null && typeof (o as Caja).x === "number" && typeof (o as Caja).width === "number" && !("first" in (o as object));

const TECLAS: Record<string, string> = { Enter: "Enter ⏎", Tab: "Tab ⇥", Escape: "Esc", Backspace: "⌫", ArrowDown: "↓", ArrowUp: "↑", " ": "Espacio" };

interface ZoomActivo {
  ventana: Ventana;
  factorPedido: number;
  seguir: boolean;
  vista: { width: number; height: number };
}

export class Contexto {
  app!: Page;
  appContext!: BrowserContext;
  navegador!: Browser;
  private contextosExtra: BrowserContext[] = [];
  private cdp?: CDPSession;
  private enPantalla?: Page;
  private grabando = false;
  private inicio = 0;
  readonly verificaciones: Verificacion[] = [];
  readonly archivos: string;
  private vistaActual: Vista = "dividido";
  private medidas?: Medidas;
  private readonly posiciones = new WeakMap<Page, Punto>();
  readonly pasos: RegistroPasos;
  readonly zooms = new RegistroZoom();
  private zoomActivo?: ZoomActivo;
  private vigiaZoom?: NodeJS.Timeout;
  private pasoAbriendo = false;
  /** Hora de la última verificación registrada (para que se lea antes de cambiar de paso). */
  private ultimaComprobacionMs?: number;
  private avisadoLegado = false;
  /** Hora de llegada de cada verificación del paso en curso (paralelo a pasos.actual.comprueba). */
  private llegadas: number[] = [];
  /** Verificaciones del paso anterior que siguen a la vista en el panel («Comprobado en el paso N»). */
  private arrastre?: Arrastre;
  readonly avisos: string[] = [];
  readonly vigilante = new Vigilante();
  /** Factor de las pausas de lectura (estudio.esperar). Nunca toca las esperas de medición. */
  ritmo = 1;
  private api?: ApiEstudio;
  narrador?: Page;

  constructor(
    readonly demo: Demo,
    readonly servidor: Estudio,
    readonly meta: Meta,
    archivos: string,
  ) {
    this.archivos = archivos;
    this.pasos = new RegistroPasos(() => this.inicio);
  }

  /** true en modo ensayo (sin laboratorio). */
  get ensayo(): boolean {
    return this.meta.ensayo;
  }

  get totalPasos(): number {
    return this.demo.agenda?.length ?? this.demo.pasos;
  }

  /** API de los guiones: paso, comprueba, cursor, zoom, escribir, esperar (ver ApiEstudio). */
  get estudio(): ApiEstudio {
    this.api ??= {
      url: this.servidor.url,
      puerto: this.servidor.puerto,
      ensayo: this.ensayo,
      paso: (def) => this.abrirPaso(def),
      comprueba: (texto, ok, valor) => this.comprobar(texto, ok, valor),
      exige: (texto, ok, valor) => this.exigirValor(texto, ok, valor),
      indicadores: (v) => this.publicarIndicadores(v),
      mover: (objetivo, o) => this.moverA(objetivo, o?.pagina),
      clic: (objetivo, o) => this.clicVisible(objetivo, o),
      escribir: (objetivo, texto, o) => this.escribirVisible(objetivo, texto, o),
      tecla: (t, o) => this.teclaVisible(t, o?.pagina),
      elegir: (objetivo, opcion, o) => this.elegirVisible(objetivo, opcion, o?.pagina),
      marcar: (objetivo, valor = true, o) => this.marcarVisible(objetivo, valor, o?.pagina),
      desplazar: (a, o) => this.desplazarVisible(a, o?.pagina),
      zoom: (objetivo, o) => this.ampliar(objetivo, o),
      zoomFuera: () => this.reducir(),
      esperar: (ms) => this.pausa(ms),
    };
    return this.api;
  }

  // ── Sesiones y pantalla ─────────────────────────────────────────────────────────────────────────────

  /** Opciones comunes de los contextos operados. */
  opcionesContexto() {
    return { viewport: this.viewport(this.vistaActual), locale: "es-CL", timezoneId: "America/Santiago", ignoreHTTPSErrors: true, acceptDownloads: true };
  }

  /** Prepara un contexto operado: capa del cursor y, en ensayo, desvío del laboratorio al servidor de ensayo. */
  async prepararContexto(ctx: BrowserContext): Promise<void> {
    await ctx.addInitScript({ path: resolve(PAQUETE, "estudio/cursor.js") });
    if (enEnsayo()) {
      await ctx.route(URL_LAB, async (ruta) => {
        const original = ruta.request().url();
        const r = await ruta.fetch({ url: reescribirUrlEnsayo(original), maxRedirects: 0 }).catch(() => undefined);
        if (!r) return ruta.abort();
        // Chromium no vuelve a interceptar el destino de un 3xx entregado con route.fulfill() (buscaría el host
        // del laboratorio en el DNS): en una navegación, el 3xx se convierte en una redirección en el navegador,
        // que sí vuelve a pasar por esta ruta. Las cookies de la respuesta se conservan.
        const destino = r.headers().location;
        if (ruta.request().isNavigationRequest() && r.status() >= 300 && r.status() < 400 && destino) {
          const cookies = r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
          return ruta.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: cookies.length ? { "set-cookie": cookies.join("\n") } : {},
            body: paginaRedireccionEnsayo(new URL(destino, original).toString()),
          });
        }
        return ruta.fulfill({ response: r });
      });
    }
  }

  /** Abre otra sesión de navegador (p. ej. la persona aprobadora en paralelo a la solicitante). */
  async nuevaSesion(): Promise<Page> {
    const ctx = await this.navegador.newContext(this.opcionesContexto());
    await this.prepararContexto(ctx);
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
    await this.reducir();
    if (this.cdp) {
      await this.cdp.send("Page.stopScreencast").catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
    }
    this.app = p;
    this.enPantalla = p;
    await this.ajustarVentana(p);
    if (!this.grabando) return;
    const cdp = await p.context().newCDPSession(p);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
      if (this.cdp !== cdp) return;
      this.servidor.cuadro(Buffer.from(f.data, "base64"));
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    });
    // Sin reducción: el cuadro llega al tamaño de la ventana operada, que ya es el del área de pantalla.
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: Number(process.env.EVIDENCIAS_Q_OPERADO ?? 85), maxWidth: ANCHO, maxHeight: ALTO, everyNthFrame: Number(process.env.EVIDENCIAS_NTH ?? 2) });
    // Una página ya cargada y quieta no entrega cuadros hasta que algo se repinta: sin esto el monitor seguiría
    // mostrando la página anterior (o nada, al empezar el video) hasta el primer movimiento.
    this.repintarLuego(p, [0, 400]);
    const marcada = p as Page & { __nexoUrl?: boolean };
    if (!marcada.__nexoUrl) {
      marcada.__nexoUrl = true;
      p.on("framenavigated", (f) => {
        if (f !== p.mainFrame() || this.enPantalla !== p) return;
        this.servidor.publicar({ monitor: { url: f.url(), activo: true } });
        this.repintarLuego(p, [700]);
      });
      p.on("load", () => {
        const pos = this.posiciones.get(p);
        if (pos) p.evaluate((q) => (window as unknown as { __nexoCursor?: { colocar(x: number, y: number): void } }).__nexoCursor?.colocar(q.x, q.y), pos).catch(() => undefined);
        // Tras una navegación completa el screencast no siempre entrega el documento nuevo si nada cambia.
        if (this.enPantalla === p) this.repintarLuego(p, [250, 1200]);
      });
    }
    this.servidor.publicar({ monitor: { url: p.url(), activo: true } });
  }

  /** Programa repintados de la página en pantalla (ms desde ahora). */
  private repintarLuego(p: Page, demoras: number[]) {
    for (const ms of demoras)
      setTimeout(() => {
        if (this.grabando && this.enPantalla === p && !p.isClosed()) void this.repintar(p);
      }, ms);
  }

  /**
   * Fuerza un cuadro nuevo del screencast: CDP solo entrega cuadros cuando la página se repinta. Agrega por dos
   * cuadros de animación un punto de 2 px casi transparente en la esquina (no se distingue en el video).
   */
  async repintar(p: Page): Promise<void> {
    await p
      .evaluate(
        () =>
          new Promise<void>((listo) => {
            const d = document.createElement("div");
            d.setAttribute("aria-hidden", "true");
            d.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;background:rgba(128,128,128,0.03);pointer-events:none;z-index:2147483646";
            (document.body ?? document.documentElement).appendChild(d);
            const fin = () => {
              d.remove();
              listo();
            };
            requestAnimationFrame(() => requestAnimationFrame(fin));
            setTimeout(fin, 500);
          }),
      )
      .catch(() => undefined);
  }

  /** Tamaño de la ventana operada en una vista: el área de pantalla medida por la narradora (1:1). */
  viewport(v: Vista): { width: number; height: number } {
    const m = this.medidas?.vistas[v] ?? this.medidas?.vistas.dividido;
    return m ? { width: m.ancho, height: m.alto } : VIEWPORT[v];
  }

  usarMedidas(m: Medidas | undefined) {
    this.medidas = m;
  }

  private async ajustarVentana(p: Page) {
    const vp = this.viewport(this.vistaActual);
    const actual = p.viewportSize();
    if (!actual || actual.width !== vp.width || actual.height !== vp.height) await p.setViewportSize(vp);
  }

  /** Revisa cada 1,5 s el texto visible de la pantalla operada y de la narradora (textos prohibidos). */
  private revisor?: NodeJS.Timeout;
  private revisarPantalla() {
    this.revisor = setInterval(() => {
      for (const [origen, p] of [
        ["pantalla", this.enPantalla],
        ["narrador", this.narrador],
      ] as const) {
        if (!p || p.isClosed()) continue;
        p.evaluate(() => `${location.href}\n${document.body?.innerText ?? ""}`)
          .then((t) => this.vigilante.revisar(origen, t, true))
          .catch(() => undefined);
      }
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
    if (this.vigiaZoom) clearInterval(this.vigiaZoom);
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
        await this.clicVisible(entrar, { pagina: p });
      }
    }
    await p.locator("#username").waitFor({ timeout: 60_000 });
    await this.escribirVisible("#username", usuario, { pagina: p });
    await this.escribirVisible("#password", clave, { pagina: p });
    await this.clicVisible("button[type=submit], input[type=submit]", { pagina: p });
    await p.waitForURL((u) => u.pathname.startsWith(`/${portal}`) && !u.pathname.includes("/services/auth"), { timeout: 60_000 });
  }

  marcarInicio(t0 = Date.now()) {
    this.inicio = t0;
    this.servidor.publicar({ inicio: this.inicio });
  }

  get inicioVideo(): number {
    return this.inicio;
  }

  /** Segundos desde que empezó la grabación. */
  segundos(): number {
    return (Date.now() - this.inicio) / 1000;
  }

  hora(): string {
    return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date());
  }

  /** Compatibilidad: infracciones de la vigilancia de textos prohibidos. */
  get infracciones(): string[] {
    return this.vigilante.infracciones;
  }

  private vigilar(origen: string, texto: string | undefined) {
    this.vigilante.revisar(origen, texto);
  }

  avisar(texto: string) {
    this.avisos.push(texto);
    console.log(`  ⚠ ${texto}`);
  }

  log(texto: string, tipo?: TipoLinea, conHora = true) {
    this.vigilar("terminal", texto);
    this.servidor.evento("linea", { texto, tipo, hora: conHora ? this.hora() : undefined });
    process.stdout.write(`  ${tipo === "mal" ? "!" : " "} ${texto}\n`);
  }

  limpiarTerminal(titulo?: string) {
    this.servidor.evento("limpiar", {});
    if (titulo) this.servidor.publicar({ terminal: { titulo } });
  }

  // ── Pasos y verificaciones ──────────────────────────────────────────────────────────────────────────

  /** Abre el paso siguiente; antes espera (con la imagen en vivo) a que el actual cumpla su mínimo. */
  async abrirPaso(def: DefinicionPaso): Promise<number> {
    if (this.pasoAbriendo) throw new Error("estudio.paso() se llamó sin await: cada paso debe esperarse (await c.estudio.paso({...}))");
    this.pasoAbriendo = true;
    try {
      await this.cerrarPaso();
      return this.publicarPaso(def);
    } finally {
      this.pasoAbriendo = false;
    }
  }

  /**
   * Cierra el paso en curso cuando cumplió su mínimo (vuelve antes a la vista completa) y cuando su última
   * verificación lleva a la vista al menos 2,5 s (si el video no está cerca del tope).
   */
  async cerrarPaso(): Promise<void> {
    const actual = this.pasos.actual;
    if (!actual || actual.finMs !== undefined) return;
    await this.reducir();
    const minimo = Math.max(PASO_MINIMO_S, actual.def.minimoS ?? PASO_MINIMO_S);
    const ahora = Date.now();
    const falta = this.grabando
      ? esperaAlCerrar({
          inicioMs: actual.inicioMs,
          ahoraMs: ahora,
          minimoS: minimo,
          ...(this.ultimaComprobacionMs !== undefined ? { ultimaComprobacionMs: this.ultimaComprobacionMs } : {}),
          restantesS: presupuesto(this.inicio, ahora).restantes,
        })
      : 0;
    if (falta > 0) await dormir(falta);
    this.pasos.cerrar(Date.now());
  }

  private publicarPaso(def: DefinicionPaso): number {
    for (const t of [def.titulo, def.quePasa, def.porQueImporta, ...(def.comprueba ?? [])]) this.vigilar("panel", t);
    const previo = this.pasos.actual;
    const abre = Date.now();
    this.arrastre = previo ? arrastreAlCerrar(previo.n, previo.def.comprueba ?? [], previo.comprueba, this.llegadas, abre) : undefined;
    const n = this.pasos.abrir(def, abre);
    this.llegadas = (this.pasos.actual?.comprueba ?? []).map(() => abre);
    const total = Math.max(this.totalPasos, n);
    const agenda = this.demo.agenda;
    if (agenda && agenda[n - 1] !== undefined && agenda[n - 1] !== def.titulo) this.avisar(`el paso ${n} se titula «${def.titulo}» y la agenda dice «${agenda[n - 1]}»`);
    if (n > this.totalPasos) this.avisar(`el guion abrió el paso ${n} y anunció ${this.totalPasos}`);
    const ahora = Date.now();
    this.servidor.publicar({
      paso: { n, total, titulo: def.titulo, quePasa: def.quePasa, porQueImporta: def.porQueImporta, comprueba: def.comprueba ?? [], inicioMs: ahora, comprobado: [] },
      comprobaciones: this.comprobacionesPanel(),
      capitulos: { total, actual: n, agenda: agenda ?? this.pasos.titulos(), inicioPaso: ahora, minimoS: Math.max(PASO_MINIMO_S, def.minimoS ?? PASO_MINIMO_S) },
      rotulo: { paso: `Paso ${n} de ${total}`, texto: def.titulo },
    });
    this.log(`── Paso ${n} de ${total}: ${def.titulo}`, "titulo");
    if (this.grabando) {
      const p = presupuesto(this.inicio, ahora);
      if (p.restantes < PASO_MINIMO_S) this.avisar(`al abrir el paso ${n} quedan ${Math.round(p.restantes)} s antes del cierre (tope ${TOPE_VIDEO_S} s)`);
    }
    return n;
  }

  /** «Se comprueba» del paso en curso para el panel lateral: lo declarado más lo verificado en vivo (V04). */
  private comprobacionesPanel() {
    const a = this.pasos.actual;
    const l = listaComprobaciones(a?.def.comprueba ?? [], a?.comprueba ?? []);
    const ahora = Date.now();
    const ar = this.arrastre;
    const vigente = ar && (ar.hastaMs === undefined || ar.hastaMs > ahora);
    return {
      items: l.items,
      resumen: textoOcultas(l),
      ocultasOk: l.ocultasOk,
      ocultasPendientes: l.ocultasPendientes,
      ...(vigente ? { anterior: { n: ar.n, items: ar.items, ...(ar.hastaMs !== undefined ? { quedaMs: ar.hastaMs - ahora } : {}) } } : {}),
    };
  }

  /** true si el guion usó c.paso(texto) (API anterior, sin panel ni mínimo de 7 s garantizado). */
  get usaApiAnterior(): boolean {
    return this.avisadoLegado;
  }

  /** Compatibilidad: avanza al paso siguiente sin esperar el mínimo (use await c.estudio.paso({...})). */
  paso(texto: string) {
    if (!this.avisadoLegado) {
      this.avisadoLegado = true;
      this.avisar(`${this.demo.id}: guion con c.paso(texto); use await c.estudio.paso({ titulo, quePasa, porQueImporta }) para el panel y el mínimo de 7 s`);
    }
    this.pasos.cerrar(Date.now());
    // Sin narración propia: «qué pasa» es el mismo texto del paso y «por qué importa», la afirmación que
    // demuestra el video (ambos ya aprobados y visibles antes). Así el pasos.json cumple el contrato.
    this.publicarPaso({ titulo: texto, quePasa: texto, porQueImporta: this.demo.afirmacion });
  }

  /** Cambia el texto del rótulo sin avanzar de paso. */
  rotulo(texto: string) {
    this.vigilar("rótulo", texto);
    const n = this.pasos.cantidad;
    this.servidor.publicar({ rotulo: { paso: n ? `Paso ${n} de ${Math.max(this.totalPasos, n)}` : "", texto } });
  }

  comprobar(texto: string, ok: boolean, valor?: string | number): boolean {
    this.ultimaComprobacionMs = Date.now();
    const detalle = valor === undefined || valor === "" ? undefined : String(valor);
    this.vigilar("comprobación", `${texto} ${detalle ?? ""}`);
    this.verificaciones.push({ texto, ok, ...(detalle !== undefined ? { detalle } : {}) });
    const n = this.pasos.comprobar({ texto, ok, ...(valor !== undefined ? { valor } : {}) });
    if (this.pasos.actual) this.llegadas[this.pasos.actual.comprueba.length - 1] = Date.now();
    this.servidor.evento("comprobado", { paso: n, texto, ok, valor, t: this.grabando ? Math.round(this.segundos() * 1000) / 1000 : 0 });
    this.servidor.publicar({ comprobaciones: this.comprobacionesPanel() });
    this.log(`${ok ? "✓" : "✗"} ${texto}${detalle ? ` — ${detalle}` : ""}`, ok ? "ok" : "mal");
    return ok;
  }

  private exigirValor(texto: string, ok: boolean, valor?: string | number): void {
    if (this.comprobar(texto, ok, valor)) return;
    const msg = `no se cumplió: ${texto}${valor !== undefined ? ` (${valor})` : ""}`;
    if (this.ensayo) this.avisar(`(ensayo, se continúa) ${msg}`);
    else throw new Error(msg);
  }

  /** Compatibilidad: verificación del escenario (= estudio.comprueba). */
  verificar(texto: string, ok: boolean, detalle?: string): boolean {
    return this.comprobar(texto, ok, detalle);
  }

  /** Compatibilidad: como verificar, pero si no se cumple detiene el escenario (= estudio.exige). */
  exigir(texto: string, ok: boolean, detalle?: string): void {
    this.exigirValor(texto, ok, detalle);
  }

  private publicarIndicadores(v: Record<string, string | number>) {
    this.vigilar("indicadores", JSON.stringify(v));
    this.servidor.publicar({ indicadores: v });
  }

  async vista(v: Vista) {
    await this.reducir();
    this.vistaActual = v;
    this.servidor.publicar({ vista: v });
    await this.ajustarVentana(this.app);
    await dormir(250);
  }

  get vistaVigente(): Vista {
    return this.vistaActual;
  }

  panel(html: string) {
    this.vigilar("panel", html);
    this.servidor.publicar({ panel: html });
  }

  /** Espera de medición (no se escala ni vuelve a la vista completa). Para pausas de lectura: estudio.esperar(). */
  esperar(ms: number) {
    return dormir(ms);
  }

  /** Pausa de lectura: vuelve a la vista completa y espera (escalada por el ritmo global). */
  async pausa(ms: number): Promise<void> {
    await this.reducir();
    await dormir(pausaLectura(ms, this.ritmo));
  }

  // ── Cursor (V02) ────────────────────────────────────────────────────────────────────────────────────

  private pagina(p?: Page): Page {
    return p ?? this.app;
  }

  /** ¿Se ve esta página en el video? (si no, las acciones no se animan). */
  private visible(p: Page): boolean {
    return this.grabando && this.enPantalla === p;
  }

  private locator(objetivo: Locator | string, p: Page): Locator {
    return typeof objetivo === "string" ? p.locator(objetivo).first() : objetivo.first();
  }

  /** Asegura la capa del cursor en la página (la inyecta si la página se abrió antes del script de inicio). */
  private async capa(p: Page): Promise<void> {
    const hay = await p.evaluate(() => !!(window as unknown as { __nexoCursor?: unknown }).__nexoCursor).catch(() => false);
    if (hay) return;
    await p.addScriptTag({ path: resolve(PAQUETE, "estudio/cursor.js") }).catch(() => undefined);
    const pos = this.posiciones.get(p);
    if (pos) await this.enCapa(p, "colocar", pos.x, pos.y);
  }

  private enCapa(p: Page, metodo: string, ...args: unknown[]): Promise<unknown> {
    return p
      .evaluate(
        ([m, a]) => {
          const capa = (window as unknown as { __nexoCursor?: Record<string, (...x: unknown[]) => unknown> }).__nexoCursor;
          return capa?.[m as string]?.(...(a as unknown[]));
        },
        [metodo, args] as const,
      )
      .catch(() => undefined);
  }

  /** Caja del objetivo, llevándolo antes a la vista con un desplazamiento suave si hace falta. */
  private async cajaVisible(objetivo: Objetivo, p: Page): Promise<{ caja: Caja; loc?: Locator }> {
    if (esCaja(objetivo)) return { caja: objetivo };
    const loc = this.locator(objetivo, p);
    await loc.waitFor({ state: "visible", timeout: 30_000 });
    let caja = await loc.boundingBox();
    const vp = p.viewportSize() ?? { width: 1280, height: 720 };
    if (!caja || !dentroDeVista(caja, vp)) {
      if (this.visible(p)) {
        await this.capa(p);
        await loc.evaluate((el) => (window as unknown as { __nexoCursor?: { desplazarHasta(e: Element): Promise<number> } }).__nexoCursor?.desplazarHasta(el)).catch(() => undefined);
        await dormir(120);
      } else await loc.scrollIntoViewIfNeeded().catch(() => undefined);
      caja = await loc.boundingBox();
    }
    if (!caja) throw new Error(`el objetivo no tiene caja visible: ${String(objetivo)}`);
    return { caja, loc };
  }

  /** La ampliación activa sigue al objetivo si este quedó fuera de lo ampliado. */
  private seguirZoom(caja: Caja) {
    const z = this.zoomActivo;
    if (!z || !z.seguir || !fueraDeVentana(caja, z.ventana)) return;
    z.ventana = ventanaZoom(caja, z.vista, z.factorPedido);
    this.servidor.publicar({ zoom: { activo: true, ventana: z.ventana, vista: z.vista, insignia: textoInsignia(z.ventana.factor) } });
  }

  /** Lleva el cursor (visible) hasta un punto. */
  private async viajar(p: Page, destino: Punto, anchoObjetivo = 40): Promise<void> {
    const vp = p.viewportSize() ?? { width: 1280, height: 720 };
    const desde = this.posiciones.get(p) ?? { x: Math.round(vp.width * 0.55), y: Math.round(vp.height * 0.62) };
    if (this.visible(p)) {
      await this.capa(p);
      if (!this.posiciones.has(p)) await this.enCapa(p, "colocar", desde.x, desde.y);
      const ms = duracionMovimiento(distancia(desde, destino), anchoObjetivo);
      if (ms > 0) {
        const puntos = trayectoria(desde, destino, ms).map((q) => [q.x, q.y, q.t]);
        await this.enCapa(p, "recorrer", puntos);
      }
    }
    await p.mouse.move(destino.x, destino.y);
    this.posiciones.set(p, destino);
  }

  async moverA(objetivo: Objetivo, pagina?: Page): Promise<void> {
    const p = this.pagina(pagina);
    const { caja } = await this.cajaVisible(objetivo, p);
    if (p === this.enPantalla) this.seguirZoom(caja);
    await this.viajar(p, puntoObjetivo(caja, p.viewportSize() ?? undefined), caja.width);
  }

  async clicVisible(objetivo: Objetivo, o: OpcionesClic = {}): Promise<void> {
    const p = this.pagina(o.pagina);
    const { caja, loc } = await this.cajaVisible(objetivo, p);
    const vp = p.viewportSize() ?? undefined;
    if (!this.visible(p)) {
      if (loc) await (o.doble ? loc.dblclick() : loc.click());
      else await (o.doble ? p.mouse.dblclick(caja.x + caja.width / 2, caja.y + caja.height / 2) : p.mouse.click(caja.x + caja.width / 2, caja.y + caja.height / 2));
      return;
    }
    this.seguirZoom(caja);
    let destino = puntoObjetivo(caja, vp);
    await this.viajar(p, destino, caja.width);
    // Si el objetivo se movió mientras el cursor viajaba (animaciones), se corrige con un tramo corto.
    if (loc) {
      const ahora = await loc.boundingBox();
      if (ahora && (Math.abs(ahora.x - caja.x) > 4 || Math.abs(ahora.y - caja.y) > 4)) {
        destino = puntoObjetivo(ahora, vp);
        await this.viajar(p, destino, ahora.width);
      }
    }
    const marco = loc ? ((await loc.boundingBox()) ?? caja) : caja;
    await this.enCapa(p, "recuadro", marco);
    await dormir(o.pausaMs ?? PAUSA_ANTES_DE_CLIC_MS);
    try {
      if (loc) {
        const b = (await loc.boundingBox()) ?? marco;
        const posicion = { x: Math.max(1, Math.min(b.width - 1, destino.x - b.x)), y: Math.max(1, Math.min(b.height - 1, destino.y - b.y)) };
        await (o.doble ? loc.dblclick({ position: posicion }) : loc.click({ position: posicion }));
      } else await (o.doble ? p.mouse.dblclick(destino.x, destino.y) : p.mouse.click(destino.x, destino.y));
    } finally {
      setTimeout(() => void this.enCapa(p, "recuadro", null), 250);
    }
    await dormir(300);
  }

  private async etiquetaCampo(loc: Locator): Promise<string> {
    return loc
      .evaluate((el) => {
        const e = el as HTMLInputElement;
        const l = e.labels?.[0]?.textContent ?? e.getAttribute("aria-label") ?? e.getAttribute("placeholder") ?? e.getAttribute("name") ?? e.id ?? "";
        return l.replace(/\s+/g, " ").trim().slice(0, 40);
      })
      .catch(() => "");
  }

  async escribirVisible(objetivo: Objetivo, texto: string, o: OpcionesEscribir = {}): Promise<void> {
    const p = this.pagina(o.pagina);
    if (esCaja(objetivo)) throw new Error("escribir() necesita un campo (selector o Locator), no una caja");
    const loc = this.locator(objetivo, p);
    const tipo = await loc.getAttribute("type").catch(() => null);
    const enmascarar = o.enmascarar ?? tipo === "password";
    if (!enmascarar) this.vigilar("teclado", texto);
    if (!this.visible(p)) {
      await loc.fill(texto);
      if (o.enter) await loc.press("Enter");
      return;
    }
    await this.clicVisible(loc, { pagina: p, pausaMs: 350 });
    if (o.limpiar !== false) await loc.fill("");
    const campo = o.campo ?? (await this.etiquetaCampo(loc));
    const mostrar = (t: string) => (enmascarar ? "•".repeat([...t].length) : t);
    if (o.pegar ?? [...texto].length > 120) {
      this.servidor.publicar({ teclado: { activo: true, campo, tecla: `Ctrl+V · ${[...texto].length} caracteres` } });
      await dormir(450);
      await loc.fill(texto);
      await dormir(500);
    } else {
      const ritmo = ritmoEscritura(texto, o.ms);
      let escrito = "";
      let i = 0;
      for (const ch of texto) {
        await p.keyboard.type(ch);
        escrito += ch;
        this.servidor.publicar({ teclado: { activo: true, campo, texto: mostrar(escrito) } });
        await dormir(ritmo[i++] ?? 80);
      }
      await dormir(250);
    }
    if (o.enter) await this.teclaVisible("Enter", p);
    this.servidor.publicar({ teclado: { activo: false } });
  }

  async teclaVisible(tecla: string, pagina?: Page): Promise<void> {
    const p = this.pagina(pagina);
    if (!this.visible(p)) return p.keyboard.press(tecla);
    this.servidor.publicar({ teclado: { activo: true, tecla: TECLAS[tecla] ?? tecla.replace(/Control/g, "Ctrl") } });
    await dormir(260);
    await p.keyboard.press(tecla);
    await dormir(420);
    this.servidor.publicar({ teclado: { activo: false } });
  }

  async elegirVisible(objetivo: Objetivo, opcion: string | RegExp | number, pagina?: Page): Promise<void> {
    const p = this.pagina(pagina);
    if (esCaja(objetivo)) throw new Error("elegir() necesita un <select> (selector o Locator)");
    const loc = this.locator(objetivo, p);
    const opciones = await loc.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => ({ valor: o.value, texto: (o.textContent ?? "").trim() })));
    const indice =
      typeof opcion === "number"
        ? opcion
        : opciones.findIndex((o) => (typeof opcion === "string" ? o.valor === opcion || o.texto === opcion : opcion.test(o.texto) || opcion.test(o.valor)));
    const elegida = opciones[indice];
    if (!elegida) throw new Error(`el <select> no tiene la opción ${String(opcion)}`);
    this.vigilar("lista", elegida.texto);
    if (!this.visible(p)) {
      await loc.selectOption(elegida.valor);
      return;
    }
    const { caja } = await this.cajaVisible(loc, p);
    this.seguirZoom(caja);
    const enSelect = puntoObjetivo(caja, p.viewportSize() ?? undefined);
    await this.viajar(p, enSelect, caja.width);
    await this.enCapa(p, "recuadro", caja);
    await dormir(400);
    await this.enCapa(p, "onda", enSelect.x, enSelect.y);
    await this.enCapa(p, "recuadro", null);
    const cajas = (await loc.evaluate((el, i) => (window as unknown as { __nexoCursor?: { desplegar(e: Element, i: number): unknown } }).__nexoCursor?.desplegar(el, i), indice)) as
      | Array<Caja & { indice: number }>
      | undefined;
    await dormir(350);
    const destino = cajas?.find((c) => c.indice === indice);
    if (destino) {
      const punto = { x: Math.round(destino.x + Math.min(destino.width / 2, 90)), y: Math.round(destino.y + destino.height / 2) };
      await this.viajar(p, punto, destino.width);
      await this.enCapa(p, "resaltar", cajas!.indexOf(destino));
      await dormir(450);
      await this.enCapa(p, "onda", punto.x, punto.y);
    }
    await loc.selectOption(elegida.valor);
    await dormir(200);
    await this.enCapa(p, "plegar");
    await dormir(250);
  }

  async marcarVisible(objetivo: Objetivo, valor: boolean, pagina?: Page): Promise<void> {
    const p = this.pagina(pagina);
    if (esCaja(objetivo)) return this.clicVisible(objetivo, { pagina: p });
    const loc = this.locator(objetivo, p);
    if ((await loc.isChecked().catch(() => !valor)) === valor) return;
    await this.clicVisible(loc, { pagina: p });
  }

  async desplazarVisible(a: Objetivo | number, pagina?: Page): Promise<void> {
    const p = this.pagina(pagina);
    if (typeof a !== "number") {
      if (esCaja(a)) return;
      const loc = this.locator(a, p);
      if (!this.visible(p)) return loc.scrollIntoViewIfNeeded();
      await this.capa(p);
      await loc.evaluate((el) => (window as unknown as { __nexoCursor?: { desplazarHasta(e: Element): Promise<number> } }).__nexoCursor?.desplazarHasta(el)).catch(() => undefined);
      await dormir(150);
      return;
    }
    if (!this.visible(p)) {
      await p.mouse.wheel(0, a);
      return;
    }
    const vp = p.viewportSize() ?? { width: 1280, height: 720 };
    let pos = this.posiciones.get(p);
    if (!pos || pos.x < 0 || pos.y < 0 || pos.x > vp.width || pos.y > vp.height) {
      pos = { x: Math.round(vp.width * 0.55), y: Math.round(vp.height * 0.55) };
      await this.viajar(p, pos);
    }
    await this.enCapa(p, "desplazar", pos.x, pos.y, a);
    await dormir(150);
  }

  // ── Ampliación en vivo (V05) ────────────────────────────────────────────────────────────────────────

  async ampliar(objetivo: Objetivo, o: OpcionesZoom = {}): Promise<void> {
    const p = this.app;
    if (!this.visible(p)) return;
    const vista = p.viewportSize() ?? this.viewport(this.vistaActual);
    const { caja } = await this.cajaVisible(objetivo, p);
    const factorPedido = o.factor ?? ZOOM_FACTOR_POR_DEFECTO;
    const ventana = ventanaZoom(caja, vista, factorPedido);
    if (ventana.factor < ZOOM_FACTOR_MIN) {
      this.avisar(`ampliación omitida: el objetivo no cabe ampliado (×${ventana.factor})`);
      return;
    }
    const ahora = Date.now();
    if (!this.zoomActivo && !this.zooms.cabe(this.inicio, ahora, (o.ms ?? 4000) + ZOOM_TRANSICION_MS)) {
      this.avisar(`ampliación omitida: superaría el 35 % del video ampliado (${Math.round(this.zooms.fraccion(this.inicio, ahora) * 100)} % hasta ahora)`);
      return;
    }
    this.zooms.abrir(ahora, ventana.factor);
    this.zoomActivo = { ventana, factorPedido, seguir: o.seguir !== false, vista };
    this.servidor.publicar({ zoom: { activo: true, ventana, vista, insignia: textoInsignia(ventana.factor) } });
    if (!this.vigiaZoom) {
      this.vigiaZoom = setInterval(() => {
        if (this.zooms.excedido(this.inicio, Date.now())) {
          this.avisar("ampliación cerrada: se alcanzó el 35 % del video ampliado");
          void this.reducir();
        }
      }, 250);
    }
    await dormir(ZOOM_TRANSICION_MS);
    if (o.ms !== undefined) {
      await dormir(o.ms);
      await this.reducir();
    }
  }

  async reducir(): Promise<void> {
    if (!this.zoomActivo) return;
    this.zoomActivo = undefined;
    this.servidor.publicar({ zoom: { activo: false } });
    await dormir(ZOOM_TRANSICION_MS);
    this.zooms.cerrar(Date.now());
  }

  // ── Compatibilidad con los guiones anteriores (mismas firmas; ahora con cursor visible) ─────────────

  /** Lleva el puntero hasta el elemento (con movimiento visible) y hace clic. */
  async clic(objetivo: Locator | string, pausa?: number) {
    await this.clicVisible(objetivo, pausa !== undefined && pausa >= PAUSA_ANTES_DE_CLIC_MS ? { pausaMs: pausa } : {});
  }

  /** Escribe como una persona (80 ms por letra; el retardo anterior ya no se usa). */
  async escribir(objetivo: Locator | string, texto: string, _retardo?: number) {
    await this.escribirVisible(objetivo, texto);
  }

  async ir(url: string) {
    await this.reducir();
    await this.app.goto(url.startsWith("http") ? url : `${this.servidor.url}${url}`);
  }

  /** Ingresa a la Consola con una persona del realm (flujo OIDC real con Keycloak). */
  async ingresarConsola(usuario: string) {
    const p = this.app;
    await p.goto(`${this.servidor.url}/`);
    const salir = p.getByTestId("btn-logout");
    const entrar = p.getByTestId("btn-oidc-login");
    await Promise.race([salir.waitFor({ timeout: 20_000 }), entrar.waitFor({ timeout: 20_000 })]);
    if (await salir.isVisible()) {
      await this.clicVisible(salir);
      await Promise.race([entrar.waitFor({ timeout: 20_000 }), p.waitForURL(/keycloak/, { timeout: 20_000 })]).catch(() => undefined);
      if (/keycloak/.test(p.url())) {
        // Cierre de sesión en Keycloak con confirmación.
        const btn = p.locator("#kc-logout");
        if (await btn.isVisible().catch(() => false)) await this.clicVisible(btn);
        await p.goto(`${this.servidor.url}/`);
      }
      await entrar.waitFor({ timeout: 20_000 });
    }
    await this.clicVisible(entrar);
    await p.waitForURL(/keycloak:8080/, { timeout: 20_000 });
    await p.locator("#username").waitFor();
    await this.escribirVisible("#username", usuario);
    await this.escribirVisible("#password", CLAVE_LAB());
    await this.clicVisible("#kc-login");
    await p.waitForURL((u) => u.host === `localhost:${this.servidor.puerto}` && !u.pathname.startsWith("/auth/"), { timeout: 30_000 });
    await p.getByTestId("current-user").waitFor({ timeout: 30_000 });
  }

  /** Sigue la salida de un comando en segundo plano (p. ej. docker logs -f) hasta llamar a detener(). */
  seguir(cmd: string, args: string[], o: { mostrar?: string; filtro?: (l: string) => string | undefined; tipo?: (l: string) => TipoLinea } = {}) {
    if (o.mostrar !== "") this.log(`$ ${o.mostrar ?? [cmd, ...args].join(" ")} &`, "cmd");
    if (this.ensayo) {
      this.log("(ensayo: no hay laboratorio; el comando no se ejecuta)", "tenue");
      return { detener: () => undefined };
    }
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
    await this.clicVisible(objetivo);
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
    if (this.ensayo) {
      this.log("(ensayo: no hay laboratorio; el comando no se ejecuta)", "tenue");
      return { codigo: 0, salida: [] };
    }
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

/** Página que redirige en el navegador (ensayo): la navegación siguiente vuelve a pasar por context.route(). */
export function paginaRedireccionEnsayo(destino: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escaparHtml(destino)}"><script>location.replace(${JSON.stringify(destino).replace(/</g, "\\u003c")})</script>`;
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

export interface Evidencia extends Partial<Publicacion> {
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
  /** Commit del producto (la etiqueta de la versión). */
  commit: string;
  recorded_at: string;
  environment: string;
  result: string;
  checks: Array<{ texto: string; ok: boolean; detalle?: string }>;
  data?: Record<string, unknown>;
  /** Etiqueta de la versión grabada (p. ej. v1.2.0). */
  tag?: string;
  /** Capas agregadas en vivo sobre la grabación. */
  layers?: string[];
  /** Ampliaciones en vivo (segundos del video) y fracción del video ampliada. */
  zooms?: Array<{ inicio_s: number; fin_s: number; factor: number }>;
  zoom_fraction?: number;
  /** Cifras de la captura (cuadros recibidos, únicos, huecos, atraso de ffmpeg…). */
  capture?: EstadisticasCaptura;
  /** Máquina de grabación (CPU y carga al empezar y al terminar). */
  machine?: { cpu: string; cores: number; load_start: number; load_end: number };
}

export interface OpcionesGrabacion {
  meta: Meta;
  navegador?: Browser;
  /** Carpeta de salida (por defecto release/evidencias, o release/evidencias/ensayo en ensayo). */
  salida?: string;
  /** Resolución y cps de la captura (por defecto 1920×1080 a 30). */
  perfil?: { ancho: number; alto: number; cps: number };
  /** Factor de las pausas de lectura (estudio.esperar). */
  ritmo?: number;
  /** Solo captura (prueba de rendimiento): no valida pasos ni mezcla música; devuelve las cifras. */
  soloCaptura?: boolean;
  /** Carpeta de trabajo temporal (por defecto la del sistema). */
  temporal?: string;
  /** Solo para la prueba de rendimiento: duración de la portada y del cierre (por defecto PORTADA_S y CIERRE_S de ritmo.ts). */
  portadaS?: number;
  cierreS?: number;
}

export interface Grabacion {
  evidencia?: Evidencia;
  captura: EstadisticasCaptura;
  pasos?: PasosJson;
  /** Video sin música (solo con soloCaptura; quien llama lo borra). */
  sinMusica?: string;
  avisos: string[];
}

const CONFIG_CONSOLA = (meta: Meta) => ({
  apiBaseUrl: "/api/v1",
  environmentLabel: meta.ambiente,
  version: `${meta.version} (commit ${meta.commitProducto})`,
  auth: {
    provider: "oidc",
    oidc: { authority: "http://keycloak:8080/realms/nexo", clientId: "nexo-console", rolesClaimPath: "resource_access.nexo-console.roles" },
  },
  demoBanner: true,
});

/** Graba una demostración. Devuelve la evidencia o lanza un error (y no deja video) si algo no se cumple. */
export async function grabar(demo: Demo, o: OpcionesGrabacion): Promise<Evidencia> {
  const g = await grabarVideo(demo, o);
  if (!g.evidencia) throw new Error("la grabación no produjo evidencia");
  return g.evidencia;
}

/** Graba una demostración y devuelve también las cifras de la captura y el pasos.json. */
export async function grabarVideo(demo: Demo, o: OpcionesGrabacion): Promise<Grabacion> {
  const ensayo = o.meta.ensayo;
  if (ensayo !== enEnsayo()) throw new Error(ensayo ? "modo ensayo sin servidor de ensayo (NEXO_EVIDENCIAS_ENSAYO_URL)" : "el servidor de ensayo está activo en una grabación oficial");
  const perfil = o.perfil ?? { ancho: ANCHO, alto: ALTO, cps: CPS };
  const carpeta = o.salida ?? (ensayo ? SALIDA_ENSAYO : SALIDA);
  const trabajo = mkdtempSync(join(o.temporal ?? tmpdir(), `evid-${demo.id}-`));
  const archivos = join(trabajo, "archivos");
  mkdirSync(archivos, { recursive: true });
  const servidor = new Estudio({ configConsola: CONFIG_CONSOLA(o.meta), archivos, ensayo, ...(ENSAYO ? { api: ENSAYO } : {}) });
  await servidor.iniciar();
  const navegador = o.navegador ?? (await lanzarNavegador());
  const c = new Contexto(demo, servidor, o.meta, archivos);
  c.navegador = navegador;
  c.zooms.minimoTotalMs = duracionMinimaMs(demo.agenda?.length ?? demo.pasos, o.portadaS ?? PORTADA_S, o.cierreS ?? CIERRE_S);
  c.ritmo = o.ritmo ?? 1;
  let narrador: BrowserContext | undefined;
  let captura: Captura | undefined;
  let stats: EstadisticasCaptura | undefined;
  const fechaGrabacion = new Date();
  const sinMusica = join(trabajo, `${demo.archivo}.sin-musica.mp4`);
  const cargaInicio = loadavg()[0] ?? 0;
  let error: unknown;
  let resultado: ResultadoDemo | undefined;
  let finPasosMs = 0;
  try {
    // Narrador (se graba): primero, para medir el área de pantalla de cada vista.
    narrador = await navegador.newContext({ viewport: { width: ANCHO, height: ALTO }, deviceScaleFactor: 1, locale: "es-CL", timezoneId: "America/Santiago" });
    const pn = await narrador.newPage();
    c.narrador = pn;
    const total = demo.agenda?.length ?? demo.pasos;
    const commits = `commit ${o.meta.commitProducto} · grabación ${o.meta.commitHerramientas}`;
    const firma = textoFirma({ producto: PRODUCTO, version: o.meta.version, commitProducto: o.meta.commitProducto, commitHerramientas: o.meta.commitHerramientas });
    servidor.publicar({
      vista: "portada",
      ensayo,
      chip: demo.id,
      banner: { producto: `${PRODUCTO} ${o.meta.version}`, ambiente: o.meta.ambiente, commits, version: o.meta.version, ensayo },
      firma: { texto: firma, producto: PRODUCTO, version: o.meta.version, commitProducto: o.meta.commitProducto, commitHerramientas: o.meta.commitHerramientas },
      portada: {
        id: demo.id,
        nombre: demo.nombre,
        version: `${PRODUCTO} ${o.meta.version} (commit ${o.meta.commitProducto}; herramientas de grabación ${o.meta.commitHerramientas})`,
        producto: PRODUCTO,
        versionCorta: o.meta.version,
        commitProducto: o.meta.etiquetaExiste ? `${o.meta.commitProducto} (etiqueta ${o.meta.etiqueta})` : o.meta.commitProducto,
        commitHerramientas: `${o.meta.commitHerramientas} (herramientas de grabación)`,
        commits,
        fecha: fechaSantiago(fechaGrabacion),
        ambiente: o.meta.ambiente,
        afirmacion: demo.afirmacion,
        agenda: demo.agenda ?? [],
        capas: [...CAPAS],
        ensayo,
      },
      capitulos: { total, actual: 0, agenda: demo.agenda ?? [], minimoS: PASO_MINIMO_S },
      rotulo: { paso: "", texto: `${demo.id} · ${demo.nombre}` },
      monitor: { url: "", activo: false },
      terminal: { titulo: "Salida del escenario" },
      panel: "",
      zoom: { activo: false },
      teclado: { activo: false },
    });
    await pn.goto(`${servidor.url}/__estudio/`);
    await pn.waitForFunction(() => (window as unknown as { __estudioListo?: boolean }).__estudioListo === true && document.getElementById("p-nombre")?.textContent !== "", undefined, { timeout: 20_000 });
    const medidas = await servidor.esperarMedidas(5000);
    c.usarMedidas(medidas);
    if (!medidas) c.avisar("la narradora no informó el tamaño de la pantalla: se usa la ventana del diseño anterior");
    else if (medidas.compat) c.avisar("index.html no declara data-lienzo=\"1920x1080\": se usa el diseño anterior escalado (modo de compatibilidad)");

    // Contexto operado (no se graba directamente: se ve dentro del narrador).
    c.appContext = await navegador.newContext(c.opcionesContexto());
    await c.prepararContexto(c.appContext);
    c.app = await c.appContext.newPage();
    c.app.setDefaultTimeout(30_000);
    const notas = (await demo.preparar?.(c)) ?? [];
    if (demo.usuarioInicial) await c.ingresarConsola(demo.usuarioInicial);

    // Captura: el primer cuadro es el segundo 0 del video (la portada).
    captura = new Captura(pn, { destino: sinMusica, carpeta: trabajo, ancho: perfil.ancho, alto: perfil.alto, cps: perfil.cps });
    const t0 = await captura.iniciar();
    c.marcarInicio(t0);
    await c.iniciarPantalla();
    await dormir(Math.max(0, (o.portadaS ?? PORTADA_S) * 1000 - (Date.now() - t0)));
    await c.vista("dividido");
    if (notas.length) {
      c.log("Preparación del laboratorio antes de grabar:", "tenue");
      for (const n of notas) c.log(`  · ${n}`, "tenue");
    }
    resultado = await demo.ejecutar(c);
    await c.cerrarPaso();
    finPasosMs = Date.now();
    await c.reducir();
    if (c.infracciones.length) throw new Error(`apareció texto no publicable en el video: ${[...new Set(c.infracciones)].slice(0, 3).join(" · ")}`);
    const fallidas = c.verificaciones.filter((v) => !v.ok);
    if (!c.verificaciones.length && !o.soloCaptura) throw new Error("el escenario no registró verificaciones");
    if (fallidas.length) {
      const msg = `verificaciones fallidas: ${fallidas.map((v) => `${v.texto}${v.detalle ? ` (${v.detalle})` : ""}`).join("; ")}`;
      if (ensayo) c.avisar(`(ensayo) ${msg}`);
      else throw new Error(msg);
    }
    if (c.pasos.cantidad && c.pasos.cantidad < total) c.avisar(`${demo.id}: el guion anunció ${total} pasos y abrió ${c.pasos.cantidad} (la barra de capítulos mostró «de ${total}» durante el video)`);
    const ok = fallidas.length === 0;
    const cumplidas = `${c.verificaciones.filter((v) => v.ok).length} de ${c.verificaciones.length} verificaciones automáticas cumplidas`;
    const nota = ensayo
      ? `ENSAYO sin laboratorio: páginas y respuestas simuladas por el servidor de ensayo · ${cumplidas} sobre esas páginas · no es evidencia y no se publica`
      : `${cumplidas} · grabación continua de ${Math.round(c.segundos())} s, sin cortes ni aceleración · capas agregadas: ${CAPAS.join(", ")} (la música se mezcla al final sin recodificar la imagen) · SHA-256 en yago-nexo.web.app/evidencias`;
    servidor.publicar({
      vista: "resultado",
      rotulo: { paso: "", texto: `${demo.id} · resultado: ${resultado.medido}` },
      // Al cierre, la barra muestra los pasos que de verdad ocurrieron (nunca un capítulo ✓ que no se grabó).
      capitulos: { total: c.pasos.cantidad || total, actual: (c.pasos.cantidad || total) + 1, agenda: c.pasos.cantidad ? c.pasos.titulos() : (demo.agenda ?? []), minimoS: PASO_MINIMO_S },
      resultado: {
        ok,
        titulo: `${demo.id} · ${demo.nombre}`,
        resumen: resumenVerificaciones(c.verificaciones).texto,
        medido: resultado.medido,
        verificaciones: ordenCierre(c.verificaciones).map((v) => ({ ok: v.ok, texto: v.detalle ? `${v.texto}: ${v.detalle}` : v.texto })),
        porPagina: 14,
        segundos: o.cierreS ?? CIERRE_S,
        capas: [...CAPAS],
        nota,
        ...(ensayo ? { sobretitulo: "Resultado del ensayo · datos simulados" } : {}),
      },
    });
    await dormir((o.cierreS ?? CIERRE_S) * 1000);
    await c.detenerPantalla();
    stats = await captura.detener();
    captura = undefined;
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
    await captura?.abortar();
    try {
      await demo.limpiar?.(c);
    } catch (e) {
      console.error(`[${demo.id}] limpieza: ${e instanceof Error ? e.message : e}`);
    }
    await narrador?.close().catch(() => undefined);
    await c.cerrarSesionesExtra();
    await c.appContext?.close().catch(() => undefined);
    if (!o.navegador) await navegador.close();
    await servidor.detener();
  }

  if (error || !resultado || !stats) {
    rmSync(trabajo, { recursive: true, force: true });
    throw error instanceof Error ? error : new Error(String(error ?? "sin video"));
  }
  const t0 = c.inicioVideo;
  const finVideoMs = t0 + stats.duracion_s * 1000;
  const pasos: PasosJson = {
    producto: PRODUCTO,
    version: o.meta.version,
    commit_producto: o.meta.commitProducto,
    commit_herramientas: o.meta.commitHerramientas,
    ensayo,
    ancho: perfil.ancho,
    alto: perfil.alto,
    cps: perfil.cps,
    duracion_s: stats.duracion_s,
    pasos: c.pasos.pasos(finPasosMs || finVideoMs),
  };
  console.log(
    `  captura: ${stats.ancho}×${stats.alto} a ${stats.cps} cps · ${stats.duracion_s.toFixed(1)} s · ${stats.cuadros_unicos} cuadros distintos de ${stats.cuadros_video} (con movimiento: p90 ${stats.cps_movimiento_p90 ?? "?"}/s, p50 ${stats.cps_movimiento_p50}/s, p10 ${stats.cps_movimiento_p10}/s) · hueco máx. ${stats.hueco_max_s} s · ${stats.disco_mb} MB de cuadros · H.264 en ${stats.codificacion_s} s`,
  );
  if (o.soloCaptura) return { captura: stats, pasos, sinMusica, avisos: c.avisos };

  const todos = validarPasos(pasos);
  // Un guion con la API anterior (c.paso(texto), síncrona) no puede esperar el mínimo de 7 s: aquí queda como
  // aviso (verificar.ts lo exige al publicar) hasta que el guion pase a await c.estudio.paso({...}).
  // Todo lo demás (tope de 240 s, verificaciones fallidas, commits) sigue siendo error.
  const blando = (p: string) => c.usaApiAnterior && /^paso \d+ dura .*\(mínimo/.test(p);
  for (const p of todos.filter(blando)) c.avisar(`pasos.json (guion con c.paso(); migrar a await c.estudio.paso({...})): ${p}`);
  const problemas = todos.filter((p) => !blando(p));
  if (problemas.length) {
    if (ensayo) for (const p of problemas) c.avisar(`(ensayo) pasos.json: ${p}`);
    else {
      rmSync(trabajo, { recursive: true, force: true });
      throw new Error(`video fuera de norma: ${problemas.join("; ")}`);
    }
  }
  mkdirSync(carpeta, { recursive: true });
  const archivoPasos = join(carpeta, `${demo.archivo}.pasos.json`);
  writeFileSync(archivoPasos, `${JSON.stringify(pasos, null, 2)}\n`);
  let publicacion: Publicacion;
  try {
    publicacion = await terminarVideo({
      sinMusica,
      carpeta,
      nombre: demo.archivo,
      id: demo.id,
      titulo: `${demo.id} · ${demo.nombre}`,
      pasos,
      temporal: trabajo,
    });
  } catch (e) {
    // Sin video no queda un pasos.json suelto (lo leerían el sitio y verificar.ts).
    rmSync(archivoPasos, { force: true });
    throw e;
  } finally {
    rmSync(trabajo, { recursive: true, force: true });
  }
  const zooms = c.zooms.enSegundos(t0, finVideoMs);
  const evidencia: Evidencia = {
    id: demo.id,
    title: demo.nombre,
    claim: demo.afirmacion,
    ...publicacion,
    version: o.meta.version,
    commit: o.meta.commitProducto,
    tag: o.meta.etiqueta,
    recorded_at: isoSantiago(fechaGrabacion),
    environment: o.meta.ambiente,
    result: resultado.medido,
    checks: c.verificaciones,
    ...(resultado.datos ? { data: resultado.datos } : {}),
    layers: [...CAPAS],
    zooms,
    zoom_fraction: Math.round(c.zooms.fraccion(t0, finVideoMs) * 1000) / 1000,
    capture: stats,
    machine: { cpu: (cpus()[0]?.model ?? "?").replace(/\s+/g, " ").trim(), cores: cpus().length, load_start: Math.round(cargaInicio * 100) / 100, load_end: Math.round((loadavg()[0] ?? 0) * 100) / 100 },
  };
  return { evidencia, captura: stats, pasos, avisos: c.avisos };
}
