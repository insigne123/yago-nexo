/**
 * Prueba de punta a punta con un video sintético (testsrc2 de ffmpeg, 1920×1080 a 30 cps): se codifica en H.264,
 * se le mezcla la música, se generan los WebVTT y se verifica. Se omite si no hay ffmpeg con libx264.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remezclar } from "./lib/musica-mezclar.js";
import {
  argumentosH264,
  FFMPEG,
  filtroH264,
  hashFlujoVideo,
  medirAstats,
  sha256Archivo,
  terminarVideo,
  type Publicacion,
} from "./lib/video.js";
import type { ArchivoPasos } from "./lib/vtt.js";
import { esFormatoAnterior, leerSumas, verificarEvidencia, type EntradaEvidencia } from "./verificar.js";

const codificadores = (() => {
  try {
    return existsSync(FFMPEG)
      ? execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" })
      : "";
  } catch {
    return "";
  }
})();
const conX264 = /libx264/.test(codificadores);
const conVp9 = /libvpx-vp9/.test(codificadores);

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
    {
      n: 1,
      inicio_s: 1,
      fin_s: 8,
      titulo: "Primer paso",
      que_pasa: "Se abre la Consola y se ve el inventario vacío.",
      por_que_importa: "Estado inicial conocido.",
      comprueba: [{ texto: "inventario vacío", ok: true, valor: 0 }],
    },
    {
      n: 2,
      inicio_s: 8,
      fin_s: 15.5,
      titulo: "Segundo paso",
      que_pasa: "Se lanza el escaneo y aparecen los hallazgos ordenados por exposición.",
      por_que_importa: "Se ve el resultado en vivo.",
      comprueba: [{ texto: "escaneo terminado", ok: true, valor: "6,9 s" }],
    },
  ],
});

// ── Esquema de evidencias.json (apps/site/src/data/evidencias.schema.json) ────────────────────────────────

type Esquema = {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, Esquema>;
  items?: Esquema;
  pattern?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
};
const ESQUEMA = JSON.parse(
  readFileSync(new URL("../../../apps/site/src/data/evidencias.schema.json", import.meta.url), "utf8"),
) as Esquema & { $defs: Record<string, Esquema> };

/** Validador mínimo (el subconjunto de JSON Schema que usa el esquema); devuelve los problemas encontrados. */
function validar(dato: unknown, esq: Esquema = ESQUEMA, ruta = "$"): string[] {
  if (esq.$ref) return validar(dato, ESQUEMA.$defs[esq.$ref.replace("#/$defs/", "")]!, ruta);
  const p: string[] = [];
  const tipo = Array.isArray(dato) ? "array" : dato === null ? "null" : typeof dato;
  if (esq.type === "integer" ? !Number.isInteger(dato) : esq.type && esq.type !== tipo)
    return [`${ruta}: se espera ${esq.type}`];
  if (esq.enum && !esq.enum.includes(dato))
    p.push(`${ruta}: ${String(dato)} no está en ${esq.enum.join(", ")}`);
  if ("const" in esq && dato !== esq.const) p.push(`${ruta}: debe ser ${String(esq.const)}`);
  if (typeof dato === "string" && esq.pattern && !new RegExp(esq.pattern).test(dato))
    p.push(`${ruta}: «${dato}» no calza con ${esq.pattern}`);
  if (typeof dato === "number") {
    if (esq.minimum !== undefined && dato < esq.minimum) p.push(`${ruta}: ${dato} < ${esq.minimum}`);
    if (esq.maximum !== undefined && dato > esq.maximum) p.push(`${ruta}: ${dato} > ${esq.maximum}`);
    if (esq.exclusiveMinimum !== undefined && dato <= esq.exclusiveMinimum)
      p.push(`${ruta}: ${dato} ≤ ${esq.exclusiveMinimum}`);
  }
  if (Array.isArray(dato) && esq.items)
    dato.forEach((x, i) => p.push(...validar(x, esq.items, `${ruta}[${i}]`)));
  if (tipo === "object" && (esq.properties || esq.required)) {
    const o = dato as Record<string, unknown>;
    for (const k of esq.required ?? []) if (!(k in o)) p.push(`${ruta}: falta «${k}»`);
    // Todo campo que escribe el grabador debe estar declarado (salvo en objetos libres como data y capture).
    for (const [k, v] of Object.entries(o)) {
      const sub = esq.properties?.[k];
      if (!sub) p.push(`${ruta}: «${k}» no está en el esquema`);
      else p.push(...validar(v, sub, `${ruta}.${k}`));
    }
  }
  return p;
}

describe("esquema de evidencias.json", () => {
  it("el índice publicado hoy en el sitio (formato anterior) cumple el esquema", () => {
    const sitio = JSON.parse(
      readFileSync(new URL("../../../apps/site/src/data/evidencias.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(validar(sitio)).toEqual([]);
  });
  it("el validador detecta campos sin declarar, ensayos y picos fuera de norma", () => {
    const e = {
      id: "D-01",
      title: "t",
      claim: "c",
      file: "D-01_x.mp4",
      duration_seconds: 10,
      sha256: "a".repeat(64),
      version: "1.2.0",
      commit: "abc1234",
      recorded_at: "x",
      environment: "lab",
      result: "r",
    };
    expect(validar({ evidencias: [e] })).toEqual([]);
    expect(validar({ evidencias: [{ ...e, rehearsal: true }] })).toHaveLength(1);
    expect(validar({ evidencias: [{ ...e, otro: 1 }] })).toHaveLength(1);
    expect(
      validar({ evidencias: [{ ...e, music: { style: "s", variant: 2, author: "a", true_peak_dbtp: -1 } }] }),
    ).toHaveLength(1);
    expect(validar({ evidencias: [{ ...e, duration_seconds: 241 }] })).toHaveLength(1);
  });
});

describe.skipIf(!conX264)("video sintético de punta a punta", () => {
  let base: string;
  let sinMusica: string;

  const preparar = async (
    carpeta: string,
    ensayo: boolean,
  ): Promise<{ e: EntradaEvidencia; pub: Publicacion }> => {
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(join(carpeta, "D-01_prueba.pasos.json"), JSON.stringify(pasos(ensayo)));
    const pub = await terminarVideo({
      sinMusica,
      carpeta,
      nombre: "D-01_prueba",
      id: "D-01",
      titulo: "Prueba sintética",
      temporal: base,
      segundoPortada: false,
    });
    const e: EntradaEvidencia = {
      id: "D-01",
      version: "1.2.0",
      commit: "abc1234",
      checks: [{ texto: "prueba", ok: true }],
      ...pub,
    };
    writeFileSync(join(carpeta, "SHA256SUMS.txt"), `${pub.sha256}  ${pub.file}\n`);
    return { e, pub };
  };
  const verificar = (carpeta: string, e: EntradaEvidencia) =>
    verificarEvidencia(e, {
      carpeta,
      sumas: leerSumas(readFileSync(join(carpeta, "SHA256SUMS.txt"), "utf8")),
      sitio: null,
      decodificar: false,
    });

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "evidencias-prueba-"));
    sinMusica = join(base, "fuente.mp4");
    execFileSync(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=30:duration=16",
      "-vf",
      filtroH264(),
      ...argumentosH264({ preset: "ultrafast" }),
      "-f",
      "mp4",
      sinMusica,
    ]);
  }, 120_000);

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("mezcla la música sin tocar la imagen y cumple todos los criterios", async () => {
    const carpeta = join(base, "registro");
    const md5Antes = await hashFlujoVideo(sinMusica);
    const { e, pub } = await preparar(carpeta, false);
    expect(pub.video_stream_md5).toBe(md5Antes);
    expect(await hashFlujoVideo(join(carpeta, pub.file))).toBe(md5Antes);
    expect(pub).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      frames: 480,
      rehearsal: false,
      chapters: [{ n: 1 }, { n: 2 }],
    });
    expect(Math.abs(pub.music.integrated_lufs + 18)).toBeLessThanOrEqual(1);
    expect(pub.music.true_peak_dbtp).toBeLessThanOrEqual(-1.5);
    const astats = await medirAstats(join(carpeta, pub.file));
    expect(astats.factorPlano).toBe(0);
    for (const f of [pub.subtitles, pub.chapters_file, pub.steps_file, pub.without_music.file])
      expect(existsSync(join(carpeta, f))).toBe(true);
    const r = await verificar(carpeta, e);
    expect(r.criterios.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    // Lo que entrega terminarVideo(), con los campos que agrega el grabador, cumple el esquema del sitio.
    const entrada = {
      ...e,
      title: "Prueba",
      claim: "x",
      recorded_at: "2026-10-13T08:00:00-03:00",
      environment: "laboratorio",
      result: "x",
      tag: "v1.2.0",
      layers: ["cursor resaltado"],
      zooms: [{ inicio_s: 2, fin_s: 4, factor: 1.8 }],
      zoom_fraction: 0.12,
      capture: {},
      machine: { cpu: "x", cores: 4, load_start: 1, load_end: 1 },
    };
    expect(validar({ generado: new Date().toISOString(), evidencias: [entrada] })).toEqual([]);
  }, 180_000);

  it("cambiar la variante de la música no toca la imagen y deja el índice verificable", async () => {
    const carpeta = join(base, "remezcla");
    const { e, pub } = await preparar(carpeta, false);
    writeFileSync(
      join(carpeta, "evidencias.json"),
      JSON.stringify({ evidencias: [{ ...e, title: "Prueba sintética" }] }),
    );
    const otra = pub.music.variant === 1 ? 2 : 1;
    const [nuevo] = await remezclar({ carpeta, ids: ["D-01"], variante: otra, temporal: base, sitio: false });
    expect(nuevo!.music.variant).toBe(otra);
    expect(nuevo!.video_stream_md5).toBe(pub.video_stream_md5);
    expect(nuevo!.sha256).not.toBe(pub.sha256);
    expect(await sha256Archivo(join(carpeta, nuevo!.file))).toBe(nuevo!.sha256);
    const indice = JSON.parse(readFileSync(join(carpeta, "evidencias.json"), "utf8")) as {
      evidencias: EntradaEvidencia[];
    };
    expect(indice.evidencias[0]).toMatchObject({
      id: "D-01",
      sha256: nuevo!.sha256,
      checks: [{ texto: "prueba", ok: true }],
    });
    const r = await verificar(carpeta, indice.evidencias[0]!);
    expect(r.criterios.filter((c) => !c.ok)).toEqual([]);
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
    execFileSync(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sinMusica,
      ...argumentosH264({ preset: "ultrafast", crf: 30 }),
      "-f",
      "mp4",
      otro,
    ]);
    copyFileSync(otro, join(carpeta, e.without_music!.file));
    const r2 = await verificar(carpeta, e);
    expect(r2.criterios.find((c) => c.clave === "flujo de video")).toMatchObject({ ok: false });
  }, 180_000);
});

describe.skipIf(!conVp9)("respaldo del formato anterior (WebM)", () => {
  let base: string;
  let e: EntradaEvidencia;
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "evidencias-anterior-"));
    const file = "D-03_contratos.webm";
    execFileSync(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=15:duration=3",
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "300k",
      join(base, file),
    ]);
    const { sha256Archivo } = await import("./lib/video.js");
    const sha256 = await sha256Archivo(join(base, file));
    writeFileSync(join(base, "SHA256SUMS.txt"), `${sha256}  ${file}\n`);
    e = {
      id: "D-03",
      file,
      sha256,
      duration_seconds: 3,
      version: "1.0.0",
      commit: "1e1589b",
      checks: [{ texto: "contrato publicado", ok: true }],
    };
  }, 120_000);
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const opciones = (permitirAnteriores: boolean) => ({
    carpeta: base,
    sumas: leerSumas(readFileSync(join(base, "SHA256SUMS.txt"), "utf8")),
    sitio: null,
    decodificar: true,
    permitirAnteriores,
  });

  it("sin la opción, un WebM no pasa: el formato publicado es MP4 con pasos, audio y subtítulos", async () => {
    expect(esFormatoAnterior(e)).toBe(true);
    const r = await verificarEvidencia(e, opciones(false));
    expect(r.ok).toBe(false);
    expect(r.criterios.filter((c) => !c.ok).map((c) => c.clave)).toEqual(
      expect.arrayContaining(["archivo", "pasos", "audio"]),
    );
  });

  it("con --permitir-anteriores se acepta como respaldo revisando solo su integridad", async () => {
    const r = await verificarEvidencia(e, opciones(true));
    expect(r.criterios.filter((c) => !c.ok)).toEqual([]);
    expect(r).toMatchObject({ ok: true, anterior: true });
    // La integridad sí se exige: otra suma, un ensayo o un escenario con fallas no pasan.
    expect((await verificarEvidencia({ ...e, sha256: "0".repeat(64) }, opciones(true))).ok).toBe(false);
    expect((await verificarEvidencia({ ...e, rehearsal: true }, opciones(true))).ok).toBe(false);
    expect((await verificarEvidencia({ ...e, checks: [{ texto: "x", ok: false }] }, opciones(true))).ok).toBe(
      false,
    );
  });
});
