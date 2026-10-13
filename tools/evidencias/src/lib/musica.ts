/**
 * Música original de las demostraciones, generada por código: síntesis determinista propia, sin muestras ni
 * audio de terceros (la licencia es nuestra y no exige atribución). Misma variante y misma duración producen
 * siempre las mismas muestras (y el mismo SHA-256 del PCM).
 *
 * Estilo «ambiental cálido», en Do mayor, con la progresión Cmaj9 – Am9 – Fmaj7 – G6sus (las variantes cambian
 * el orden), un acorde cada 6 a 8 s:
 *   - colchón de pads: 5 voces por acorde, cada una con 3 osciladores levemente desafinados (onda suave de 8
 *     armónicos, sin componentes ásperos), ataque de 2,8 s y relevo de 3,2 s entre acordes;
 *   - filtro pasabajos de 12 dB/octava sobre el colchón, con su frecuencia movida por un LFO lento (≈ 1/26 Hz);
 *   - sub-bajo suave (seno con un poco de segundo armónico) en la fundamental de cada acorde;
 *   - notas escasas tipo piano de fieltro (parciales inarmónicos con caída exponencial, ataque blando de 7 ms),
 *     en una caminata por las notas del acorde entre Do 4 y Sol 5;
 *   - reverb estéreo (red de 8 líneas de retardo con amortiguación de agudos, ≈ 5 s de cola);
 *   - pasaaltos de 30 Hz, pasabajos de 7 kHz, fundido de entrada de 2 s y de salida de 3 s.
 * La pieza dura exactamente lo que el video y termina en el acorde de tónica (Cmaj9) cuando la duración lo permite.
 *
 * La normalización a −18 LUFS se hace después, con ffmpeg (loudnorm en dos pasadas; ver video.ts).
 */
import { createHash } from "node:crypto";

/** Frecuencia de muestreo (Hz). */
export const FM = 48_000;
export const ESTILO = "ambiental cálido";
export const AUTORIA =
  "Música original de Yago Nexo, generada por código (síntesis determinista propia, sin muestras ni audio de terceros)";
export const FUNDIDO_ENTRADA_S = 2;
export const FUNDIDO_SALIDA_S = 3;

export type Variante = 1 | 2 | 3;
export const VARIANTES: readonly Variante[] = [1, 2, 3];

export interface Acorde {
  nombre: string;
  /** Nota MIDI del sub-bajo. */
  bajo: number;
  /** Notas MIDI del colchón. */
  notas: number[];
}

/** Voces del colchón (Do 3 a Mi 4) y sub-bajo (La 1 a Do 2). */
export const ACORDES: Record<string, Acorde> = {
  Cmaj9: { nombre: "Cmaj9", bajo: 36, notas: [48, 52, 55, 59, 62] },
  Am9: { nombre: "Am9", bajo: 33, notas: [45, 52, 55, 59, 60] },
  Fmaj7: { nombre: "Fmaj7", bajo: 29, notas: [48, 53, 57, 60, 64] },
  G6sus: { nombre: "G6sus", bajo: 31, notas: [50, 55, 60, 62, 64] },
};
const TONICA = "Cmaj9";

interface Parametros {
  orden: string[];
  /** Duración nominal de cada acorde (s). */
  acorde: number;
  /** Desafinación de los osciladores laterales del colchón (cents). */
  cents: number;
  /** Frecuencia de corte central del filtro del colchón (Hz) y período de su LFO (s). */
  corte: number;
  periodoLfo: number;
  /** Tiempo de reverberación (s) y escala de las líneas de retardo. */
  rt60: number;
  sala: number;
  /** Probabilidad de nota de piano en cada tiempo fuerte. */
  densidad: number;
}

const PARAMETROS: Record<Variante, Parametros> = {
  1: {
    orden: ["Cmaj9", "Am9", "Fmaj7", "G6sus"],
    acorde: 7,
    cents: 6,
    corte: 1000,
    periodoLfo: 26,
    rt60: 5,
    sala: 1,
    densidad: 0.3,
  },
  2: {
    orden: ["Am9", "Fmaj7", "Cmaj9", "G6sus"],
    acorde: 7.5,
    cents: 5,
    corte: 880,
    periodoLfo: 30,
    rt60: 5.5,
    sala: 1.08,
    densidad: 0.25,
  },
  3: {
    orden: ["Fmaj7", "G6sus", "Am9", "Cmaj9"],
    acorde: 6.5,
    cents: 7,
    corte: 1120,
    periodoLfo: 23,
    rt60: 4.6,
    sala: 0.94,
    densidad: 0.34,
  },
};

/** FNV-1a de 32 bits (semillas estables a partir de un texto). */
export function hash32(texto: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(texto, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Generador pseudoaleatorio determinista (mulberry32), en [0, 1). */
export function generador(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const semillaDe = (v: Variante): number => hash32(`yago-nexo/musica/ambiental-calido/${v}`);

/** Variante que le corresponde a un video según su identificador (estable: siempre la misma). */
export function varianteParaVideo(id: string): Variante {
  return ((hash32(id) % 3) + 1) as Variante;
}

export interface TramoAcorde {
  acorde: string;
  inicio: number;
  fin: number;
}
export interface NotaPiano {
  inicio: number;
  midi: number;
  velocidad: number;
}
export interface Plan {
  variante: Variante;
  semilla: number;
  duracion: number;
  /** Duración de cada acorde (s). */
  acorde: number;
  /** Tempo implícito: 8 tiempos por acorde. */
  bpm: number;
  acordes: TramoAcorde[];
  piano: NotaPiano[];
}

export const ACORDE_MIN_S = 6;
export const ACORDE_MAX_S = 8;

/**
 * Cantidad de acordes para la duración: cada uno dura de 6 a 8 s (lo más cerca posible del nominal de la
 * variante) y, si se puede, el último es la tónica (siempre se puede desde ≈ 100 s). Si ninguna cantidad cae en
 * el rango (videos de menos de 6 s), se usa la más cercana al nominal.
 */
export function cantidadAcordes(duracion: number, p: Pick<Parametros, "orden" | "acorde">): number {
  const j = p.orden.indexOf(TONICA);
  const cerca = (k: number) => Math.abs(duracion / k - p.acorde);
  const enRango: number[] = [];
  for (
    let k = Math.max(1, Math.floor(duracion / ACORDE_MAX_S));
    k <= Math.ceil(duracion / ACORDE_MIN_S);
    k++
  ) {
    const d = duracion / k;
    if (d >= ACORDE_MIN_S && d <= ACORDE_MAX_S) enRango.push(k);
  }
  const conTonica = enRango.filter((k) => (k - 1) % p.orden.length === j);
  const elegibles = conTonica.length ? conTonica : enRango;
  if (elegibles.length) return elegibles.sort((a, b) => cerca(a) - cerca(b))[0]!;
  return Math.max(1, Math.round(duracion / p.acorde));
}

const midiAHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Plan de la pieza: acordes con sus tiempos y notas de piano (todo determinista). */
export function planificar(duracion: number, variante: Variante): Plan {
  if (!(duracion > 0) || !Number.isFinite(duracion)) throw new Error(`duración inválida: ${duracion}`);
  const p = PARAMETROS[variante];
  const semilla = semillaDe(variante);
  const azar = generador(semilla);
  const k = cantidadAcordes(duracion, p);
  const d = duracion / k;
  const acordes: TramoAcorde[] = Array.from({ length: k }, (_, i) => ({
    acorde: p.orden[i % p.orden.length]!,
    inicio: i * d,
    fin: (i + 1) * d,
  }));
  const piano: NotaPiano[] = [];
  const tiempo = d / 8;
  let previa = 67;
  for (const tramo of acordes) {
    const notas = ACORDES[tramo.acorde]!.notas.map((m) => m % 12);
    const candidatas: number[] = [];
    for (let m = 60; m <= 79; m++) if (notas.includes(m % 12)) candidatas.push(m);
    let enAcorde = 0;
    for (let b = 0; b < 8; b++) {
      const t = tramo.inicio + b * tiempo;
      // Tiempos fuertes (0, 3, 5) más probables; como mucho 3 notas por acorde; nada al principio ni al final.
      const prob = (b === 0 ? 1.4 : b === 3 || b === 5 ? 1 : 0.35) * p.densidad;
      const tirada = azar();
      const tiradaNota = azar();
      const tiradaVel = azar();
      if (tirada >= prob || enAcorde >= 3 || t < 1.5 || t > duracion - 3.5) continue;
      // Caminata suave: se prefieren las notas del acorde cercanas a la anterior y al centro (Sol 4 a Do 5).
      const pesos = candidatas.map(
        (m) =>
          ((m === previa ? 0.4 : 1) / (1 + Math.abs(m - previa) / 2.5) ** 2) *
          (1 / (1 + Math.abs(m - 69) / 6)),
      );
      const total = pesos.reduce((a, b2) => a + b2, 0);
      let r = tiradaNota * total;
      let elegida = candidatas[0]!;
      for (let i = 0; i < candidatas.length; i++) {
        r -= pesos[i]!;
        if (r <= 0) {
          elegida = candidatas[i]!;
          break;
        }
      }
      piano.push({ inicio: t + 0.03 * azar(), midi: elegida, velocidad: 0.5 + 0.3 * tiradaVel });
      previa = elegida;
      enAcorde++;
    }
  }
  return { variante, semilla, duracion, acorde: d, bpm: 60 / tiempo, acordes, piano };
}

// ── Utilidades de síntesis ──────────────────────────────────────────────────────────────────────────────

const TN = 4096;
function tabla(armonicos: number[]): Float64Array {
  const t = new Float64Array(TN + 1);
  for (let i = 0; i <= TN; i++) {
    const x = (2 * Math.PI * i) / TN;
    let v = 0;
    for (let h = 0; h < armonicos.length; h++) v += armonicos[h]! * Math.sin((h + 1) * x);
    t[i] = v;
  }
  let max = 0;
  for (const v of t) max = Math.max(max, Math.abs(v));
  for (let i = 0; i <= TN; i++) t[i]! /= max;
  return t;
}
/** Onda del colchón: diente de sierra redondeada (8 armónicos con caída rápida): cálida, sin agudos. */
const ONDA_PAD = tabla([1, 0.5, 0.28, 0.16, 0.09, 0.05, 0.028, 0.015]);
const SENO = tabla([1]);

const frac = (x: number) => x - Math.floor(x);
/** Curva de subida suave (derivada nula en ambos extremos): 0 → 1. */
const subida = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}
  /** Coeficientes RBJ (cookbook). */
  static de(tipo: "lp" | "hp", f: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * f) / FM;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    const b = tipo === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    return new Biquad(b[0]! / a0, b[1]! / a0, b[2]! / a0, (-2 * c) / a0, (1 - al) / a0);
  }
  procesar(buf: Float64Array) {
    for (let n = 0; n < buf.length; n++) {
      const x = buf[n]!;
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      buf[n] = y;
    }
  }
}

/** Pasabajos de variable de estado (TPT) con la frecuencia de corte movida por un LFO, aplicado en el lugar. */
function filtroLfo(buf: Float64Array, corte: number, periodo: number, fase: number, q = 0.55) {
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  const k = 1 / q;
  for (let n = 0; n < buf.length; n++) {
    if ((n & 31) === 0) {
      const fc = corte * 2 ** (0.6 * Math.sin((2 * Math.PI * n) / (periodo * FM) + fase));
      const g = Math.tan((Math.PI * fc) / FM);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const v3 = buf[n]! - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[n] = v2;
  }
}

const ATAQUE_PAD = 2.8;
const RELEVO_PAD = 3.2;

/** Envolvente de un acorde: sube en ATAQUE_PAD desde su inicio y se apaga en RELEVO_PAD desde su fin. */
function envolventeAcorde(t: number, inicio: number, fin: number, ultimo: boolean): number {
  const sube = subida((t - inicio) / ATAQUE_PAD);
  if (ultimo || t <= fin) return sube;
  return sube * (1 - subida((t - fin) / RELEVO_PAD));
}

/** Suma un oscilador de tabla con fase absoluta (la misma nota en acordes seguidos queda en fase). */
function oscilador(
  L: Float64Array,
  R: Float64Array,
  t: Float64Array,
  f: number,
  fase0: number,
  desde: number,
  hasta: number,
  amp: (n: number) => number,
  gL: number,
  gR: number,
) {
  const inc = (f / FM) * TN;
  let p = frac(fase0 + (f * desde) / FM) * TN;
  for (let b = desde; b < hasta; b += 32) {
    const fin = Math.min(hasta, b + 32);
    const e0 = amp(b);
    const e1 = amp(fin);
    const de = (e1 - e0) / (fin - b);
    let e = e0;
    for (let n = b; n < fin; n++) {
      const i = p | 0;
      const v = (t[i]! + (t[i + 1]! - t[i]!) * (p - i)) * e;
      L[n]! += v * gL;
      R[n]! += v * gR;
      p += inc;
      if (p >= TN) p -= TN;
      e += de;
    }
  }
}

const paneo = (p: number): [number, number] => {
  const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
};

/** Nota tipo piano de fieltro: parciales levemente inarmónicos, caída exponencial y ataque blando. */
function notaPiano(L: Float64Array, R: Float64Array, nota: NotaPiano, azar: () => number) {
  const total = L.length;
  const f = midiAHz(nota.midi);
  const n0 = Math.round(nota.inicio * FM);
  const largo = Math.min(Math.round(6 * FM), total - n0);
  if (largo <= 0) return;
  const ataque = Math.round(0.007 * FM);
  const apagado = Math.round(0.6 * FM);
  const [gL, gR] = paneo(((nota.midi - 69) / 12) * 0.35 + (azar() - 0.5) * 0.2);
  const brillo = 0.5 + 0.35 * nota.velocidad;
  const tau0 = 3.4 * (262 / f) ** 0.35;
  const H = [1, 0.5, 0.26, 0.15, 0.08, 0.045, 0.025];
  const parciales: Array<{ f: number; a: number; tau: number; fase: number }> = [];
  for (let k = 1; k <= H.length; k++) {
    const fk = k * f * Math.sqrt(1 + 0.00035 * k * k);
    if (fk > 4200) break;
    const a = nota.velocidad * H[k - 1]! * brillo ** (k - 1);
    const tau = tau0 / (1 + 0.7 * (k - 1));
    // Fase inicial al azar por parcial: el mismo espectro, sin que todas las parciales sumen su pico en el ataque.
    const fase = 2 * Math.PI * azar();
    // Las dos primeras parciales en «dos cuerdas» apenas desafinadas: batido lento, más cálido.
    if (k <= 2)
      parciales.push({ f: fk * 0.99965, a: a / 2, tau, fase }, { f: fk * 1.00035, a: a / 2, tau, fase });
    else parciales.push({ f: fk, a, tau, fase });
  }
  const env = new Float64Array(largo);
  for (const pa of parciales) {
    const w = (2 * Math.PI * pa.f) / FM;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let x = Math.cos(pa.fase);
    let y = Math.sin(pa.fase);
    let g = pa.a;
    const r = Math.exp(-1 / (pa.tau * FM));
    for (let n = 0; n < largo; n++) {
      env[n]! += y * g;
      const xn = c * x - s * y;
      y = s * x + c * y;
      x = xn;
      g *= r;
    }
  }
  for (let n = 0; n < largo; n++) {
    let e = 1;
    if (n < ataque) e = subida(n / ataque);
    if (n > largo - apagado) e *= 1 - subida((n - (largo - apagado)) / apagado);
    const v = env[n]! * e;
    L[n0 + n]! += v * gL;
    R[n0 + n]! += v * gR;
  }
}

/**
 * Reverb estéreo: red de retardos realimentada (8 líneas, matriz de Hadamard) con amortiguación de agudos. Suma
 * su salida, multiplicada por `mezcla`, a `outL`/`outR` (así no reserva otros dos canales del largo de la pieza).
 */
function reverb(
  inL: Float64Array,
  inR: Float64Array,
  rt60: number,
  sala: number,
  outL: Float64Array,
  outR: Float64Array,
  mezcla: number,
): void {
  const N = inL.length;
  const largos = [1433, 1601, 1867, 2053, 2251, 2399, 2617, 2803].map((l) => Math.round(l * sala));
  const lineas = largos.map((l) => new Float64Array(l));
  const pos = new Int32Array(8);
  const ganancia = largos.map((l) => 10 ** ((-3 * l) / (rt60 * FM)));
  const amort = 1 - Math.exp((-2 * Math.PI * 3800) / FM);
  const lp = new Float64Array(8);
  const y = new Float64Array(8);
  const preRetardo = Math.round(0.025 * FM);
  const esc = 1 / Math.sqrt(8);
  for (let n = 0; n < N; n++) {
    const xl = n >= preRetardo ? inL[n - preRetardo]! : 0;
    const xr = n >= preRetardo ? inR[n - preRetardo]! : 0;
    for (let i = 0; i < 8; i++) {
      const v = lineas[i]![pos[i]!]!;
      lp[i]! += amort * (v - lp[i]!);
      y[i] = lp[i]! * ganancia[i]!;
    }
    outL[n]! += (y[0]! - y[2]! + y[4]! - y[6]!) * mezcla;
    outR[n]! += (y[1]! - y[3]! + y[5]! - y[7]!) * mezcla;
    // Hadamard 8×8 rápida.
    for (let h = 1; h < 8; h <<= 1) {
      for (let i = 0; i < 8; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const a = y[j]!;
          const b = y[j + h]!;
          y[j] = a + b;
          y[j + h] = a - b;
        }
      }
    }
    for (let i = 0; i < 8; i++) {
      const entrada = (i & 1 ? xr : xl) * (i & 2 ? -0.5 : 0.5);
      lineas[i]![pos[i]!] = y[i]! * esc + entrada;
      pos[i] = pos[i]! + 1 === largos[i]! ? 0 : pos[i]! + 1;
    }
  }
}

export interface Pista {
  plan: Plan;
  fm: number;
  izquierda: Float32Array;
  derecha: Float32Array;
}

/**
 * Sintetiza la pieza completa para la duración pedida (en segundos, la del video): estéreo, 48 kHz, con los
 * fundidos de entrada y salida aplicados, picos a no más de 13 dB sobre la sonoridad y sonoridad en −20 LUFS (la
 * final, −18 LUFS, la fija loudnorm).
 */
export function sintetizar(duracion: number, variante: Variante): Pista {
  const plan = planificar(duracion, variante);
  const p = PARAMETROS[variante];
  const N = Math.round(duracion * FM);
  const [L, R] = conReverb(plan, p, N);
  for (const canal of [L, R]) {
    Biquad.de("hp", 30).procesar(canal);
    Biquad.de("lp", 7000).procesar(canal);
  }

  // Fundidos (curvas suaves).
  const nIn = Math.min(N, Math.round(FUNDIDO_ENTRADA_S * FM));
  const nOut = Math.min(N, Math.round(FUNDIDO_SALIDA_S * FM));
  for (let n = 0; n < N; n++) {
    let g = 1;
    if (n < nIn) g *= subida(n / nIn);
    const restante = N - 1 - n;
    if (restante < nOut) g *= subida(restante / nOut);
    L[n]! *= g;
    R[n]! *= g;
  }

  // Relación pico/sonoridad acotada (los ataques del piano no pasan de 13 dB sobre la sonoridad integrada) y
  // sonoridad en −20 LUFS: así loudnorm siempre aplica una ganancia lineal y el pico real final queda holgado.
  const sonoridad = sonoridadIntegrada(L, R);
  if (Number.isFinite(sonoridad)) {
    controlarPicos(L, R, sonoridad + PICO_SOBRE_SONORIDAD_DB);
    const final = sonoridadIntegrada(L, R);
    const esc = 10 ** ((SONORIDAD_SINTESIS - final) / 20);
    for (let n = 0; n < N; n++) {
      L[n]! *= esc;
      R[n]! *= esc;
    }
  }
  return { plan, fm: FM, izquierda: Float32Array.from(L), derecha: Float32Array.from(R) };
}

/**
 * Mezcla seca más la reverb, en dos canales de N muestras. Separada en funciones para que los canales
 * intermedios (sub-bajo, piano, envíos) queden libres apenas se usan: con 240 s de música, cada canal ocupa
 * 92 MB y el máximo en memoria baja de 11 canales a 7.
 */
function conReverb(plan: Plan, p: Parametros, N: number): [Float64Array, Float64Array] {
  const { L, R, envioL, envioR } = mezclaSeca(plan, p, N);
  reverb(envioL, envioR, p.rt60, p.sala, L, R, 0.5);
  return [L, R];
}

/** Colchón filtrado + sub-bajo + piano (mezcla seca, en L y R) y los envíos a la reverb. */
function mezclaSeca(
  plan: Plan,
  p: Parametros,
  N: number,
): { L: Float64Array; R: Float64Array; envioL: Float64Array; envioR: Float64Array } {
  const variante = plan.variante;
  const azar = generador(plan.semilla ^ 0x5bd1e995);

  // Colchón.
  const padL = new Float64Array(N);
  const padR = new Float64Array(N);
  const subL = new Float64Array(N);
  plan.acordes.forEach((tramo, i) => {
    const ultimo = i === plan.acordes.length - 1;
    const acorde = ACORDES[tramo.acorde]!;
    const desde = Math.round(tramo.inicio * FM);
    const hasta = ultimo ? N : Math.min(N, Math.round((tramo.fin + RELEVO_PAD) * FM));
    const env = (n: number) => envolventeAcorde(n / FM, tramo.inicio, tramo.fin, ultimo);
    acorde.notas.forEach((m, v) => {
      const f = midiAHz(m);
      const h = hash32(`${variante}/${m}`);
      const fLfo = 0.05 + ((h & 0xff) / 255) * 0.06;
      const faseLfo = ((h >>> 8) & 0xff) / 40;
      // Voces graves un poco más presentes; la más aguda, más suave.
      const peso = (v === acorde.notas.length - 1 ? 0.7 : 1) * (m < 50 ? 1.1 : 1) * 0.11;
      const amp = (n: number) =>
        env(n) * peso * (1 + 0.15 * Math.sin(2 * Math.PI * fLfo * (n / FM) + faseLfo));
      const centro = ((m - 54) / 12) * 0.5;
      for (const [j, cents] of [-p.cents, 0, p.cents].entries()) {
        const [gL, gR] = paneo(centro + (j - 1) * 0.35);
        oscilador(
          padL,
          padR,
          ONDA_PAD,
          f * 2 ** (cents / 1200),
          ((h >>> (j * 5)) & 0x3ff) / 1024,
          desde,
          hasta,
          amp,
          gL / 3,
          gR / 3,
        );
      }
    });
    // Sub-bajo (mono): fundamental y un poco de segundo armónico para que se oiga también en parlantes chicos.
    const fb = midiAHz(acorde.bajo);
    const envSub = (n: number) => env(n) * 0.075;
    oscilador(subL, subL, SENO, fb, 0, desde, hasta, envSub, 0.5, 0.5);
    oscilador(subL, subL, SENO, 2 * fb, 0.25, desde, hasta, (n) => envSub(n) * 0.22, 0.5, 0.5);
  });
  filtroLfo(padL, p.corte, p.periodoLfo, 0);
  filtroLfo(padR, p.corte, p.periodoLfo, 0.4);

  // Piano de fieltro.
  const piL = new Float64Array(N);
  const piR = new Float64Array(N);
  for (const nota of plan.piano) notaPiano(piL, piR, { ...nota, velocidad: nota.velocidad * 0.36 }, azar);

  // Reverb (el sub-bajo no entra: el grave reverberado embarra).
  const envioL = new Float64Array(N);
  const envioR = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    envioL[n] = padL[n]! * 0.45 + piL[n]! * 0.8;
    envioR[n] = padR[n]! * 0.45 + piR[n]! * 0.8;
  }
  // Mezcla seca en el lugar, sobre el colchón (mismo orden de sumas: colchón + sub-bajo + piano).
  for (let n = 0; n < N; n++) {
    padL[n] = padL[n]! + subL[n]! + piL[n]!;
    padR[n] = padR[n]! + subL[n]! + piR[n]!;
  }
  return { L: padL, R: padR, envioL, envioR };
}

/** Sonoridad de la síntesis antes de loudnorm (LUFS) y pico máximo sobre la sonoridad (dB). */
export const SONORIDAD_SINTESIS = -20;
export const PICO_SOBRE_SONORIDAD_DB = 13;

/**
 * Sonoridad integrada según ITU-R BS.1770-4 (ponderación K, bloques de 400 ms con 75 % de traslape, compuerta
 * absoluta de −70 LUFS y relativa de −10 LU), para estéreo a 48 kHz.
 */
/** Coeficientes de BS.1770 para 48 kHz (b0, b1, b2, a1, a2): estante agudo (+4 dB) y pasaaltos (RLB). */
const PONDERACION_K = [
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
  [1, -2, 1, -1.99004745483398, 0.99007225036621],
] as const;

/** Las dos etapas de la ponderación K de un canal, muestra a muestra (sin reservar el canal filtrado). */
function filtroK(): (x: number) => number {
  const [[b0, b1, b2, a1, a2], [c0, c1, c2, d1, d2]] = PONDERACION_K;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let u1 = 0;
  let u2 = 0;
  let z1 = 0;
  let z2 = 0;
  return (xn: number) => {
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xn;
    y2 = y1;
    y1 = yn;
    const zn = c0 * yn + c1 * u1 + c2 * u2 - d1 * z1 - d2 * z2;
    u2 = u1;
    u1 = yn;
    z2 = z1;
    z1 = zn;
    return zn;
  };
}

export function sonoridadIntegrada(L: ArrayLike<number>, R: ArrayLike<number>): number {
  const N = L.length;
  const kl = filtroK();
  const kr = filtroK();
  // Energía acumulada para sumar bloques en O(1).
  const acum = new Float64Array(N + 1);
  for (let n = 0; n < N; n++) {
    const l = kl(L[n]!);
    const r = kr(R[n]!);
    acum[n + 1] = acum[n]! + l * l + r * r;
  }
  const bloque = Math.round(0.4 * FM);
  const paso = Math.round(0.1 * FM);
  const energias: number[] = [];
  for (let i = 0; i + bloque <= N; i += paso) energias.push((acum[i + bloque]! - acum[i]!) / bloque);
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = energias.filter((z) => lufs(z) > -70);
  if (!abs.length) return -Infinity;
  const umbral = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => lufs(z) > umbral);
  return lufs(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/**
 * Control de picos con anticipación, sin recortar: calcula la ganancia necesaria en cada muestra para no pasar
 * del techo y la suaviza con pendientes acotadas (baja a lo más 50 dB/s antes del pico y sube a lo más 8 dB/s
 * después). Solo baja la ganancia; nunca deforma la onda.
 */
export function controlarPicos(L: Float64Array, R: Float64Array, techoDb: number): number {
  const N = L.length;
  const g = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const p = Math.max(Math.abs(L[n]!), Math.abs(R[n]!));
    g[n] = p > 0 ? Math.min(0, techoDb - 20 * Math.log10(p)) : 0;
  }
  const baja = 50 / FM;
  const sube = 8 / FM;
  for (let n = 1; n < N; n++) g[n] = Math.min(g[n]!, g[n - 1]! + sube);
  for (let n = N - 2; n >= 0; n--) g[n] = Math.min(g[n]!, g[n + 1]! + baja);
  let maxReduccion = 0;
  for (let n = 0; n < N; n++) {
    maxReduccion = Math.min(maxReduccion, g[n]!);
    const f = 10 ** (g[n]! / 20);
    L[n]! *= f;
    R[n]! *= f;
  }
  return -maxReduccion;
}

/** WAV estéreo de 32 bits en coma flotante (formato 3, IEEE float), sin metadatos: el mismo PCM da el mismo archivo. */
export function wav(p: Pista): Buffer {
  const n = p.izquierda.length;
  const datos = n * 2 * 4;
  const b = Buffer.alloc(44 + datos);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + datos, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(p.fm, 24);
  b.writeUInt32LE(p.fm * 8, 28);
  b.writeUInt16LE(8, 32);
  b.writeUInt16LE(32, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(datos, 40);
  for (let i = 0; i < n; i++) {
    b.writeFloatLE(p.izquierda[i]!, 44 + i * 8);
    b.writeFloatLE(p.derecha[i]!, 48 + i * 8);
  }
  return b;
}

/** SHA-256 de las muestras (reproducibilidad: misma variante y duración ⇒ mismo valor). */
export function huellaPcm(p: Pista): string {
  return createHash("sha256")
    .update(Buffer.from(p.izquierda.buffer, p.izquierda.byteOffset, p.izquierda.byteLength))
    .update(Buffer.from(p.derecha.buffer, p.derecha.byteOffset, p.derecha.byteLength))
    .digest("hex");
}

/** Descripción breve de la pieza (para evidencias.json y el reporte). */
export function describir(plan: Plan): string {
  const orden = PARAMETROS[plan.variante].orden.join(" – ");
  return `${ESTILO}, variante ${plan.variante}: Do mayor, ${orden}, un acorde cada ${plan.acorde.toFixed(1)} s (≈ ${Math.round(plan.bpm)} pulsos por minuto); colchón de pads con filtro y LFO lento, sub-bajo suave, ${plan.piano.length === 1 ? "1 nota" : `${plan.piano.length} notas`} de piano de fieltro y reverb estéreo`;
}
