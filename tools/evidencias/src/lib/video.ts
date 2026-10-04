/**
 * Recodificación y verificación de los videos con ffmpeg/ffprobe. Se usa el ffmpeg del sistema si existe;
 * si no, el que trae Playwright en PLAYWRIGHT_BROWSERS_PATH (solo VP8, sin ffprobe: la duración y los
 * cuadros se obtienen decodificando el archivo completo).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function ffmpegPlaywright(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith("ffmpeg"));
  const bin = dir ? join(base, dir, "ffmpeg-linux") : undefined;
  return bin && existsSync(bin) ? bin : undefined;
}

export const FFMPEG = existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : (ffmpegPlaywright() ?? "ffmpeg");
const FFPROBE = existsSync("/usr/bin/ffprobe") ? "/usr/bin/ffprobe" : undefined;

/**
 * Recorta el instante previo a la portada y recodifica en VP9 (WebM) a 1280×720 y 15 cuadros por segundo,
 * con calidad constante: el texto de la Consola y de la terminal se lee bien y cada video queda en pocos MB.
 * Si el ffmpeg disponible no trae VP9 (el de Playwright), usa VP8 a tasa fija.
 */
export async function transcodificar(origen: string, destino: string, recorteSeg: number): Promise<void> {
  const vp9 = FFMPEG === "/usr/bin/ffmpeg";
  const codec = vp9
    ? ["-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-tile-columns", "2", "-threads", "4"]
    : ["-c:v", "libvpx", "-b:v", "700k", "-crf", "12", "-qmin", "4", "-qmax", "48", "-deadline", "good", "-cpu-used", "4", "-threads", "3"];
  await run(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", "-ss", recorteSeg.toFixed(2), "-i", origen, "-an", "-vf", "scale=1280:720,fps=15", ...codec, "-g", "300", destino],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

export interface InfoVideo {
  duracion: number;
  cuadros: number;
  ancho: number;
  alto: number;
  codec: string;
}

export async function analizarVideo(archivo: string): Promise<InfoVideo> {
  if (FFPROBE) {
    const { stdout } = await run(FFPROBE, [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames:format=duration",
      "-of",
      "json",
      archivo,
    ]);
    const j = JSON.parse(stdout) as { streams?: Array<{ codec_name: string; width: number; height: number; nb_read_frames?: string }>; format?: { duration?: string } };
    const s = j.streams?.[0];
    return { duracion: Number(j.format?.duration ?? 0), cuadros: Number(s?.nb_read_frames ?? 0), ancho: s?.width ?? 0, alto: s?.height ?? 0, codec: s?.codec_name ?? "?" };
  }
  // Sin ffprobe: decodifica todo y lee el último «frame= N … time=HH:MM:SS.xx» del informe de ffmpeg.
  const r = await run(FFMPEG, ["-hide_banner", "-i", archivo, "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const err = String(r.stderr);
  const cuadros = [...err.matchAll(/frame=\s*(\d+)/g)].pop()?.[1];
  const t = [...err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const dim = /, (\d{3,4})x(\d{3,4})/.exec(err);
  return {
    duracion: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : 0,
    cuadros: Number(cuadros ?? 0),
    ancho: Number(dim?.[1] ?? 0),
    alto: Number(dim?.[2] ?? 0),
    codec: /Video: (\w+)/.exec(err)?.[1] ?? "?",
  };
}
