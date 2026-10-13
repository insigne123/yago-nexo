/**
 * Prueba de rendimiento de la captura (V01), medida en la máquina donde se graba:
 *
 *   pnpm --filter @nexo/evidencias grabar --rendimiento 20 [--perfil 1600x900]
 *
 * Por cada perfil (1920×1080 a 30 cps y las alternativas 1600×900 a 30 y 1920×1080 a 25) graba, contra el
 * servidor de ensayo, una escena con actividad continua (cursor, escritura, desplazamiento, ampliación y la
 * terminal) durante N segundos y mide cuántos cuadros distintos llegan por segundo, los huecos entre cuadros,
 * el atraso de ffmpeg y el uso de CPU. No deja archivos.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import { metaGrabacion } from "./entorno.js";
import { grabarVideo, lanzarNavegador, type Demo } from "./grabador.js";
import { analizarVideo } from "./video.js";

export interface Perfil {
  ancho: number;
  alto: number;
  cps: number;
}

export const PERFILES: Perfil[] = [
  { ancho: 1920, alto: 1080, cps: 30 },
  { ancho: 1600, alto: 900, cps: 30 },
  { ancho: 1920, alto: 1080, cps: 25 },
];

/** Tiempos de CPU de la máquina (/proc/stat) para medir el uso total durante la prueba. */
function cpuMaquina(): { ocupado: number; total: number } | undefined {
  try {
    const l = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const ocioso = (l[3] ?? 0) + (l[4] ?? 0);
    const total = l.reduce((a, b) => a + b, 0);
    return { ocupado: total - ocioso, total };
  } catch {
    return undefined;
  }
}

/** Escena sintética con actividad continua durante `segundos`. */
function escena(segundos: number): Demo {
  return {
    id: "RENDIMIENTO",
    archivo: "RENDIMIENTO_captura",
    nombre: "Prueba de rendimiento de la captura",
    afirmacion: "Escena sintética del servidor de ensayo con actividad continua para medir la captura.",
    pasos: 1,
    async preparar(c) {
      await c.app.goto(`${c.estudio.url}/`);
      await c.app.evaluate(() => {
        sessionStorage.setItem("ensayo-usuario", "rendimiento");
        sessionStorage.setItem("ensayo-token", "x.e30.ensayo");
      });
      await c.app.goto(`${c.estudio.url}/ensayo/formulario`);
    },
    async ejecutar(c) {
      const e = c.estudio;
      const u = c.app;
      await e.paso({ titulo: "Actividad continua", quePasa: "Cursor, escritura, desplazamiento y ampliación sin pausa.", porQueImporta: "Medir la captura en el peor caso." });
      const fin = Date.now() + segundos * 1000;
      let i = 0;
      while (Date.now() < fin) {
        c.log(`actividad ${++i}: ${new Date().toISOString()}`, i % 2 ? "ok" : "tenue");
        await e.escribir(u.getByTestId("ensayo-nombre"), `API ${i}`);
        await e.mover(u.getByTestId("ensayo-tabla").locator("tbody tr").nth((i * 7) % 12));
        await e.desplazar(600);
        await e.zoom(u.getByTestId("ensayo-tabla").locator("tbody tr").nth(18), { ms: 900, factor: 1.8 });
        await e.desplazar(-600);
      }
      c.estudio.comprueba("actividad continua", true, `${i} ciclos`);
      return { medido: `${i} ciclos de actividad` };
    },
  };
}

export async function medirRendimiento(o: { segundos: number; perfiles?: Perfil[] }): Promise<Array<Record<string, string | number>>> {
  const meta = metaGrabacion({ ensayo: true });
  const navegador = await lanzarNavegador();
  const filas: Array<Record<string, string | number>> = [];
  try {
    for (const perfil of o.perfiles ?? PERFILES) {
      const cpu0 = cpuMaquina();
      const g = await grabarVideo(escena(o.segundos), { meta, navegador, perfil, soloCaptura: true, portadaS: 2, cierreS: 2 });
      const cpu1 = cpuMaquina();
      const s = g.captura;
      let mbMin = 0;
      let cuadros = 0;
      if (g.sinMusica) {
        const info = await analizarVideo(g.sinMusica);
        cuadros = info.cuadros;
        mbMin = (statSync(g.sinMusica).size / 1048576 / Math.max(1, s.duracion_s)) * 60;
        rmSync(g.sinMusica.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
      }
      filas.push({
        perfil: `${perfil.ancho}×${perfil.alto} a ${perfil.cps} cps`,
        "duración (s)": s.duracion_s,
        "cuadros del archivo": cuadros,
        "distintos/s (prom.)": s.cps_efectivos,
        "distintos/s en movimiento p50": s.cps_movimiento_p50,
        "p10": s.cps_movimiento_p10,
        "% distintos": Math.round((s.cuadros_unicos / Math.max(1, s.cuadros_video)) * 100),
        "descartados": s.cuadros_descartados,
        "hueco p95 (s)": s.hueco_p95_s,
        "hueco máx. (s)": s.hueco_max_s,
        "cuadros en disco (MB)": s.disco_mb,
        "H.264 después (s)": s.codificacion_s,
        "CPU Node (%)": s.cpu_node_pct,
        "CPU máquina (%)": cpu0 && cpu1 ? Math.round(((cpu1.ocupado - cpu0.ocupado) / Math.max(1, cpu1.total - cpu0.total)) * 100) : "?",
        "MB/min": Math.round(mbMin * 10) / 10,
      });
    }
  } finally {
    await navegador.close();
  }
  return filas;
}
