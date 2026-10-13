/**
 * Prueba de punta a punta con un video sintético (testsrc2 de ffmpeg, 1920×1080 a 30 cps): se codifica en H.264,
 * se le mezcla la música, se generan los WebVTT y se verifica. Se omite si no hay ffmpeg con libx264.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { argumentosH264, FFMPEG, filtroH264, hashFlujoVideo, medirAstats, terminarVideo, type Publicacion } from "./lib/video.js";
import type { ArchivoPasos } from "./lib/vtt.js";
import { leerSumas, verificarEvidencia, type EntradaEvidencia } from "./verificar.js";

const conX264 = (() => {
  try {
    return existsSync(FFMPEG) && /libx264/.test(execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" }));
  } catch {
    return false;
  }
})();

const pasos = (ensayo: boolean): ArchivoPasos => ({
  producto: "Yago Nexo",
  version: "1.2.0",
  commit_producto: "abc1234",
  commit_herramientas: "def5678",
  ensayo,
  ancho: 1920,
  alto: 1080,
  cps: 30,
  duracion_s: 16,
  pasos: [
    { n: 1, inicio_s: 1, fin_s: 8, titulo: "Primer paso", que_pasa: "Se abre la Consola y se ve el inventario vacío.", por_que_importa: "Estado inicial conocido.", comprueba: [{ texto: "inventario vacío", ok: true, valor: 0 }] },
    { n: 2, inicio_s: 8, fin_s: 15.5, titulo: "Segundo paso", que_pasa: "Se lanza el escaneo y aparecen los hallazgos ordenados por exposición.", por_que_importa: "Se ve el resultado en vivo.", comprueba: [{ texto: "escaneo terminado", ok: true, valor: "6,9 s" }] },
  ],
});

describe.skipIf(!conX264)("video sintético de punta a punta", () => {
  let base: string;
  let sinMusica: string;

  const preparar = async (carpeta: string, ensayo: boolean): Promise<{ e: EntradaEvidencia; pub: Publicacion }> => {
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(join(carpeta, "D-01_prueba.pasos.json"), JSON.stringify(pasos(ensayo)));
    const pub = await terminarVideo({ sinMusica, carpeta, nombre: "D-01_prueba", id: "D-01", titulo: "Prueba sintética", temporal: base, segundoPortada: false });
    const e: EntradaEvidencia = { id: "D-01", version: "1.2.0", commit: "abc1234", checks: [{ texto: "prueba", ok: true }], ...pub };
    writeFileSync(join(carpeta, "SHA256SUMS.txt"), `${pub.sha256}  ${pub.file}\n`);
    return { e, pub };
  };
  const verificar = (carpeta: string, e: EntradaEvidencia) =>
    verificarEvidencia(e, { carpeta, sumas: leerSumas(readFileSync(join(carpeta, "SHA256SUMS.txt"), "utf8")), sitio: null, decodificar: false });

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "evidencias-prueba-"));
    sinMusica = join(base, "fuente.mp4");
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=16", "-vf", filtroH264(), ...argumentosH264({ preset: "ultrafast" }), "-f", "mp4", sinMusica]);
  }, 120_000);

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("mezcla la música sin tocar la imagen y cumple todos los criterios", async () => {
    const carpeta = join(base, "registro");
    const md5Antes = await hashFlujoVideo(sinMusica);
    const { e, pub } = await preparar(carpeta, false);
    expect(pub.video_stream_md5).toBe(md5Antes);
    expect(await hashFlujoVideo(join(carpeta, pub.file))).toBe(md5Antes);
    expect(pub).toMatchObject({ width: 1920, height: 1080, fps: 30, frames: 480, rehearsal: false, chapters: [{ n: 1 }, { n: 2 }] });
    expect(Math.abs(pub.music.integrated_lufs + 18)).toBeLessThanOrEqual(1);
    expect(pub.music.true_peak_dbtp).toBeLessThanOrEqual(-1.5);
    const astats = await medirAstats(join(carpeta, pub.file));
    expect(astats.factorPlano).toBe(0);
    for (const f of [pub.subtitles, pub.chapters_file, pub.steps_file, pub.without_music.file]) expect(existsSync(join(carpeta, f))).toBe(true);
    const r = await verificar(carpeta, e);
    expect(r.criterios.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
  }, 180_000);

  it("rechaza una grabación de ensayo", async () => {
    const carpeta = join(base, "ensayo");
    const { e } = await preparar(carpeta, true);
    const r = await verificar(carpeta, e);
    expect(r.ok).toBe(false);
    expect(r.criterios.find((c) => c.clave === "no es ensayo")).toMatchObject({ ok: false });
    // Aunque alguien cambie el pasos.json y el índice, el MP4 sigue rotulado como ensayo.
    const p = JSON.parse(readFileSync(join(carpeta, e.steps_file!), "utf8")) as ArchivoPasos;
    writeFileSync(join(carpeta, e.steps_file!), JSON.stringify({ ...p, ensayo: false }));
    const r2 = await verificar(carpeta, { ...e, rehearsal: false });
    expect(r2.criterios.find((c) => c.clave === "no es ensayo")).toMatchObject({ ok: false });
  }, 180_000);

  it("detecta subtítulos desactualizados, un SHA-256 distinto y una imagen recodificada", async () => {
    const carpeta = join(base, "alterado");
    const { e } = await preparar(carpeta, false);
    writeFileSync(join(carpeta, e.subtitles!), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\notro\n");
    const r = await verificar(carpeta, { ...e, sha256: "0".repeat(64) });
    const fallan = r.criterios.filter((c) => !c.ok).map((c) => c.clave);
    expect(fallan).toEqual(expect.arrayContaining(["subtítulos", "sha256"]));
    // Archivo «sin música» recodificado: el flujo de video ya no es el mismo.
    const otro = join(base, "otro.mp4");
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", sinMusica, ...argumentosH264({ preset: "ultrafast", crf: 30 }), "-f", "mp4", otro]);
    copyFileSync(otro, join(carpeta, e.without_music!.file));
    const r2 = await verificar(carpeta, e);
    expect(r2.criterios.find((c) => c.clave === "flujo de video")).toMatchObject({ ok: false });
  }, 180_000);
});
