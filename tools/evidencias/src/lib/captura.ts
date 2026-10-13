/**
 * Captura propia del narrador (V01): 1920×1080 a 30 cuadros por segundo.
 *
 * Chromium entrega por CDP (Page.startScreencast) un JPEG cada vez que la página cambia, con la hora real
 * en que se dibujó. Durante la toma solo se guardan esos cuadros distintos en disco (la CPU queda para
 * Chromium: codificar en vivo le quitaba un núcleo y bajaba los cuadros distintos por segundo). Al terminar,
 * el muestreador fija cuántas veces se ve cada cuadro en una secuencia de 30 cps exactos según las marcas de
 * tiempo reales: el cuadro de salida k (instante k/30) muestra el último cuadro dibujado antes de ese
 * instante. Si la página no cambió, se repite el anterior (es la misma imagen); si llegaron dos en el mismo
 * 1/30 s, queda el último. Nunca se acelera, se interpola ni se inventa un cuadro.
 *
 * Luego ffmpeg codifica UNA sola vez a H.264 (parámetros de video.ts: yuv420p, BT.709, +faststart) desde una
 * lista ffconcat con la duración exacta de cada cuadro; la música se agrega después sin recodificar la imagen
 * (-c:v copy en video.ts).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright-core";
import { argumentosH264, FFMPEG, filtroH264 } from "./video.js";

export const ANCHO = 1920;
export const ALTO = 1080;
export const CPS = 30;

export interface OpcionesCaptura {
  /** MP4 H.264 sin audio que se escribe al terminar. */
  destino: string;
  /** Carpeta de trabajo para los cuadros (se borran al terminar). */
  carpeta: string;
  ancho?: number;
  alto?: number;
  cps?: number;
  /** Calidad JPEG del screencast (0–100). Es la imagen de origen: alta, para que el texto quede nítido. */
  calidadJpeg?: number;
  /** Preset de x264 (por defecto el de video.ts). */
  preset?: string;
  metadatos?: Record<string, string>;
}

export interface EstadisticasCaptura {
  ancho: number;
  alto: number;
  cps: number;
  duracion_s: number;
  /** Cuadros que entregó Chromium. */
  cuadros_recibidos: number;
  /** Cuadros del video (= duración × cps). */
  cuadros_video: number;
  /** Cuadros distintos que llegaron al video. */
  cuadros_unicos: number;
  /** Cuadros recibidos que no llegaron al video (dos en el mismo 1/30 s). */
  cuadros_descartados: number;
  /** Cuadros distintos por segundo de video (promedio; en escenas quietas es bajo porque nada cambia). */
  cps_efectivos: number;
  /** Cuadros distintos por segundo en los segundos con movimiento (p50 y p10). */
  cps_movimiento_p50: number;
  cps_movimiento_p10: number;
  /**
   * p90 de lo mismo: lo que rinde la captura cuando la pantalla cambia sin parar (cursor viajando,
   * desplazamiento). p50 y p10 dependen de la escena: al escribir a 80 ms por letra hay ~12 cambios por segundo.
   */
  cps_movimiento_p90?: number;
  /** Mayor intervalo sin cuadro nuevo (s). */
  hueco_max_s: number;
  /** Percentil 95 del intervalo entre cuadros nuevos (s). */
  hueco_p95_s: number;
  /** Disco que ocuparon los cuadros durante la toma (MB). */
  disco_mb: number;
  /** Segundos que tardó la codificación H.264 después de la toma. */
  codificacion_s: number;
  /** CPU del proceso de Node durante la toma (% de un núcleo). */
  cpu_node_pct: number;
}

/**
 * Convierte cuadros con marca de tiempo (segundos desde el primero) en una secuencia a `cps` constantes.
 * El cuadro de salida k corresponde al instante k/cps y muestra el último cuadro recibido con t ≤ k/cps.
 */
export class MuestreadorCFR {
  private escritos = 0;
  private hayActual = false;
  private ultimoT = 0;
  readonly huecos: number[] = [];
  /** Instantes (s) de los cuadros que llegaron al video, para medir el ritmo por segundo. */
  readonly instantes: number[] = [];
  recibidos = 0;
  unicos = 0;
  descartados = 0;

  constructor(readonly cps = CPS) {}

  /**
   * Llega un cuadro en el instante t. Devuelve cuántas veces se verá el cuadro ANTERIOR (0: el anterior se
   * descarta porque este llegó en el mismo intervalo).
   */
  cuadro(t: number): number {
    this.recibidos++;
    let repetir = 0;
    if (this.hayActual) {
      if (t > this.ultimoT) this.huecos.push(t - this.ultimoT);
      const n = Math.ceil(t * this.cps - 1e-9);
      repetir = Math.max(0, n - this.escritos);
      if (repetir > 0) {
        this.unicos++;
        this.instantes.push(this.ultimoT);
        this.escritos += repetir;
      } else this.descartados++;
    }
    this.hayActual = true;
    this.ultimoT = t;
    return repetir;
  }

  /** Fin de la captura en el instante t: cuántas veces se verá el último cuadro (al menos una). */
  cerrar(t: number): number {
    if (!this.hayActual) return 0;
    const n = Math.max(this.escritos + 1, Math.ceil(t * this.cps - 1e-9));
    const repetir = n - this.escritos;
    this.unicos++;
    this.instantes.push(this.ultimoT);
    this.escritos = n;
    this.hayActual = false;
    return repetir;
  }

  get escritosTotal(): number {
    return this.escritos;
  }

  percentilHueco(p: number): number {
    return percentil(this.huecos, p);
  }

  /** Cuadros distintos por segundo en los segundos con movimiento (más de 2 cuadros nuevos). */
  ritmoEnMovimiento(): { p50: number; p10: number; p90: number } {
    const porSegundo = new Map<number, number>();
    for (const t of this.instantes) porSegundo.set(Math.floor(t), (porSegundo.get(Math.floor(t)) ?? 0) + 1);
    const activos = [...porSegundo.values()].filter((n) => n > 2);
    return { p50: percentil(activos, 0.5), p10: percentil(activos, 0.1), p90: percentil(activos, 0.9) };
  }
}

function percentil(v: number[], p: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** Lista ffconcat: cada cuadro con su duración exacta (veces/cps). El último se repite para cerrar la lista. */
export function listaConcat(cuadros: Array<{ archivo: string; veces: number }>, cps: number): string {
  const l = ["ffconcat version 1.0"];
  for (const c of cuadros) {
    if (c.veces <= 0) continue;
    l.push(`file '${c.archivo.replace(/'/g, "'\\''")}'`, `duration ${(c.veces / cps).toFixed(6)}`);
  }
  const ultimo = cuadros.filter((c) => c.veces > 0).at(-1);
  if (ultimo) l.push(`file '${ultimo.archivo.replace(/'/g, "'\\''")}'`);
  return `${l.join("\n")}\n`;
}

/** Captura de una página (el narrador) a un MP4 H.264. */
export class Captura {
  private cdp?: CDPSession;
  private readonly m: MuestreadorCFR;
  private t0?: number;
  private t0Pared = 0;
  private cpu0?: NodeJS.CpuUsage;
  private primero?: () => void;
  private n = 0;
  private anterior?: string;
  private bytes = 0;
  private detenida = false;
  private readonly cuadros: Array<{ archivo: string; veces: number }> = [];
  private readonly dir: string;
  readonly o: Required<Omit<OpcionesCaptura, "metadatos" | "preset">> &
    Pick<OpcionesCaptura, "metadatos" | "preset">;
  /** Instantes de llegada (s desde el primero) para diagnóstico: EVIDENCIAS_TRAZA=<archivo.json>. */
  readonly traza: number[] = [];

  constructor(
    private readonly pagina: Page,
    o: OpcionesCaptura,
  ) {
    this.o = {
      ancho: ANCHO,
      alto: ALTO,
      cps: CPS,
      calidadJpeg: Number(process.env.EVIDENCIAS_Q_NARRADOR ?? 88),
      ...o,
    };
    this.m = new MuestreadorCFR(this.o.cps);
    this.dir = join(this.o.carpeta, "cuadros");
  }

  /** Hora (epoch ms) del primer cuadro: el segundo 0 del video. */
  get inicioMs(): number {
    return this.t0Pared;
  }

  /** Empieza a capturar; resuelve cuando llegó el primer cuadro (el segundo 0 del video). */
  async iniciar(): Promise<number> {
    mkdirSync(this.dir, { recursive: true });
    const cdp = await this.pagina.context().newCDPSession(this.pagina);
    this.cdp = cdp;
    const listo = new Promise<void>((ok) => (this.primero = ok));
    cdp.on(
      "Page.screencastFrame",
      (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
        if (!this.detenida) this.recibir(f.data, f.metadata.timestamp ?? Date.now() / 1000);
      },
    );
    this.cpu0 = process.cpuUsage();
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this.o.calidadJpeg,
      maxWidth: this.o.ancho,
      maxHeight: this.o.alto,
      everyNthFrame: 1,
    });
    let espera: NodeJS.Timeout | undefined;
    await Promise.race([
      listo,
      new Promise(
        (_, mal) =>
          (espera = setTimeout(() => mal(new Error("la captura no recibió cuadros en 10 s")), 10_000)),
      ),
    ]).finally(() => clearTimeout(espera));
    return this.t0Pared;
  }

  private recibir(base64: string, tSeg: number) {
    if (this.t0 === undefined) {
      this.t0 = tSeg;
      // La marca de CDP es la hora del sistema en segundos; se guarda también como epoch ms.
      this.t0Pared = Math.abs(tSeg * 1000 - Date.now()) < 5000 ? tSeg * 1000 : Date.now();
      this.primero?.();
    }
    const t = tSeg - this.t0;
    if (process.env.EVIDENCIAS_TRAZA) this.traza.push(Math.round(t * 1000) / 1000);
    const repetir = this.m.cuadro(t);
    if (this.anterior) {
      if (repetir > 0) this.cuadros.push({ archivo: this.anterior, veces: repetir });
      else unlinkSync(join(this.dir, this.anterior));
    }
    const archivo = `c${String(++this.n).padStart(6, "0")}.jpg`;
    const jpeg = Buffer.from(base64, "base64");
    writeFileSync(join(this.dir, archivo), jpeg);
    this.bytes += jpeg.length;
    this.anterior = archivo;
  }

  /** Segundos de video grabados hasta ahora. */
  segundos(): number {
    return this.t0Pared ? (Date.now() - this.t0Pared) / 1000 : 0;
  }

  /** Detiene la captura, codifica el MP4 y devuelve las cifras de rendimiento. */
  async detener(): Promise<EstadisticasCaptura> {
    const fin = Date.now();
    this.detenida = true;
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp?.detach().catch(() => undefined);
    const cpu = process.cpuUsage(this.cpu0);
    if (this.anterior)
      this.cuadros.push({ archivo: this.anterior, veces: this.m.cerrar((fin - this.t0Pared) / 1000) });
    if (process.env.EVIDENCIAS_TRAZA) writeFileSync(process.env.EVIDENCIAS_TRAZA, JSON.stringify(this.traza));
    const total = this.m.escritosTotal;
    const lista = join(this.dir, "lista.ffconcat");
    writeFileSync(lista, listaConcat(this.cuadros, this.o.cps));
    const t = Date.now();
    try {
      await codificar(lista, this.o.destino, {
        ancho: this.o.ancho,
        alto: this.o.alto,
        cps: this.o.cps,
        cuadros: total,
        ...(this.o.preset ? { preset: this.o.preset } : {}),
        metadatos: this.o.metadatos ?? {},
      });
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
    const dur = total / this.o.cps;
    const mov = this.m.ritmoEnMovimiento();
    return {
      ancho: this.o.ancho,
      alto: this.o.alto,
      cps: this.o.cps,
      duracion_s: Math.round(dur * 1000) / 1000,
      cuadros_recibidos: this.m.recibidos,
      cuadros_video: total,
      cuadros_unicos: this.m.unicos,
      cuadros_descartados: this.m.descartados,
      cps_efectivos: Math.round((this.m.unicos / Math.max(0.001, dur)) * 10) / 10,
      cps_movimiento_p50: mov.p50,
      cps_movimiento_p10: mov.p10,
      cps_movimiento_p90: mov.p90,
      hueco_max_s: Math.round(Math.max(0, ...this.m.huecos) * 1000) / 1000,
      hueco_p95_s: Math.round(this.m.percentilHueco(0.95) * 1000) / 1000,
      disco_mb: Math.round((this.bytes / 1048576) * 10) / 10,
      codificacion_s: Math.round((Date.now() - t) / 100) / 10,
      cpu_node_pct: Math.round(((cpu.user + cpu.system) / 1000 / Math.max(1, fin - this.t0Pared)) * 100),
    };
  }

  /** Cierra todo sin codificar (la grabación falló). */
  async abortar(): Promise<void> {
    this.detenida = true;
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Codifica la lista ffconcat a H.264 (una sola vez) con exactamente `cuadros` cuadros. */
function codificar(
  lista: string,
  destino: string,
  o: {
    ancho: number;
    alto: number;
    cps: number;
    cuadros: number;
    preset?: string;
    metadatos: Record<string, string>;
  },
): Promise<void> {
  const h = { ancho: o.ancho, alto: o.alto, cps: o.cps, ...(o.preset ? { preset: o.preset } : {}) };
  const meta = Object.entries(o.metadatos).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    lista,
    "-vf",
    filtroH264(h),
    ...argumentosH264(h),
    "-frames:v",
    String(o.cuadros),
    ...meta,
    "-f",
    "mp4",
    destino,
  ];
  return new Promise((ok, mal) => {
    const hijo = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    hijo.stderr.on("data", (d: Buffer) => (error = (error + d.toString()).slice(-3000)));
    hijo.on("close", (c) => {
      if (c === 0 && statSync(destino, { throwIfNoEntry: false })?.size) ok();
      else mal(new Error(`ffmpeg terminó con código ${c}: ${error.trim().slice(-600)}`));
    });
  });
}
