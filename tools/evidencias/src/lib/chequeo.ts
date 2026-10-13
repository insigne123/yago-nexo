/**
 * Chequeo previo de la máquina antes de grabar (V10): disco, memoria, CPU y herramientas. En modo oficial
 * aborta con un mensaje claro si algo no alcanza (§5.4: disco ampliado con ≥ 8 GB libres, nadie más usando
 * la VM); en ensayo los umbrales son menores y la carga de CPU solo avisa.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";

export interface Recursos {
  rutaDisco: string;
  discoLibreBytes: number;
  memoriaDisponibleBytes: number;
  nucleos: number;
  /** Carga media del último minuto. */
  carga1: number;
  modeloCpu: string;
  ffmpegH264: boolean;
  navegador: boolean;
}

export interface Umbrales {
  discoMinGB: number;
  memoriaMinGB: number;
  nucleosMin: number;
  /** Carga por núcleo sobre la cual se aborta (Infinity: solo avisa). */
  cargaMaxPorNucleo: number;
  /** Carga por núcleo sobre la cual se avisa. */
  cargaAvisoPorNucleo: number;
}

export const UMBRALES_OFICIAL: Umbrales = { discoMinGB: 8, memoriaMinGB: 3, nucleosMin: 4, cargaMaxPorNucleo: 0.6, cargaAvisoPorNucleo: 0.35 };
export const UMBRALES_ENSAYO: Umbrales = { discoMinGB: 2, memoriaMinGB: 1.5, nucleosMin: 2, cargaMaxPorNucleo: Infinity, cargaAvisoPorNucleo: 0.5 };

export interface ResultadoChequeo {
  ok: boolean;
  problemas: string[];
  avisos: string[];
  resumen: string;
}

const GB = 1024 ** 3;
const fmtGB = (b: number) => `${(b / GB).toFixed(1).replace(".", ",")} GB`;

export function evaluarRecursos(r: Recursos, u: Umbrales): ResultadoChequeo {
  const problemas: string[] = [];
  const avisos: string[] = [];
  if (r.discoLibreBytes < u.discoMinGB * GB)
    problemas.push(`disco: ${fmtGB(r.discoLibreBytes)} libres en ${r.rutaDisco}; se exigen ${u.discoMinGB} GB. Libere espacio o amplíe el disco antes de grabar.`);
  if (r.memoriaDisponibleBytes < u.memoriaMinGB * GB)
    problemas.push(`memoria: ${fmtGB(r.memoriaDisponibleBytes)} disponibles; se exigen ${u.memoriaMinGB} GB. Cierre otros procesos.`);
  if (r.nucleos < u.nucleosMin) problemas.push(`CPU: ${r.nucleos} núcleos; se exigen ${u.nucleosMin} para capturar 1920×1080 a 30 cps.`);
  const porNucleo = r.carga1 / Math.max(1, r.nucleos);
  const carga = `carga ${r.carga1.toFixed(2)} en ${r.nucleos} núcleos (${Math.round(porNucleo * 100)} %)`;
  if (porNucleo > u.cargaMaxPorNucleo) problemas.push(`CPU ocupada: ${carga}; nadie debe compilar ni levantar contenedores mientras se graba.`);
  else if (porNucleo > u.cargaAvisoPorNucleo) avisos.push(`CPU con ${carga}: la captura puede perder cuadros.`);
  if (!r.ffmpegH264) problemas.push("ffmpeg: no se encontró /usr/bin/ffmpeg con libx264 (H.264).");
  if (!r.navegador) problemas.push("Chromium: no está instalado en PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers).");
  const resumen = `disco ${fmtGB(r.discoLibreBytes)} libres · memoria ${fmtGB(r.memoriaDisponibleBytes)} · ${r.nucleos} núcleos (${r.modeloCpu}) · carga ${r.carga1.toFixed(2)}`;
  return { ok: problemas.length === 0, problemas, avisos, resumen };
}

function memoriaDisponible(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch {
    /* sin /proc */
  }
  return freemem();
}

function discoLibre(ruta: string): number {
  let p = ruta;
  while (!existsSync(p) && p.length > 1) p = p.replace(/\/[^/]*\/?$/, "") || "/";
  const s = statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

export function ffmpegConH264(bin = "/usr/bin/ffmpeg"): boolean {
  if (!existsSync(bin)) return false;
  try {
    return /libx264/.test(execFileSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
}

export function medirRecursos(rutaDisco: string, navegador: () => boolean): Recursos {
  const c = cpus();
  return {
    rutaDisco,
    discoLibreBytes: discoLibre(rutaDisco),
    memoriaDisponibleBytes: memoriaDisponible(),
    nucleos: c.length,
    carga1: loadavg()[0] ?? 0,
    modeloCpu: (c[0]?.model ?? "?").replace(/\s+/g, " ").trim(),
    ffmpegH264: ffmpegConH264(),
    navegador: navegador(),
  };
}

/** Disco libre de las rutas que usa la grabación (la menor de ellas). */
export function rutaMasLlena(rutas: string[]): string {
  let peor = rutas[0] ?? "/";
  let min = Infinity;
  for (const r of rutas) {
    const libre = discoLibre(r);
    if (libre < min) {
      min = libre;
      peor = r;
    }
  }
  return peor;
}
