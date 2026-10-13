/**
 * Genera las muestras de la música de los videos en tools/evidencias/musica/ para escucharlas y revisarlas:
 * una por variante (estilo «ambiental cálido»), normalizada como en los videos (loudnorm en dos pasadas a −18 LUFS,
 * pico real ≤ −1,5 dBTP, AAC de 160 kb/s), con su espectrograma PNG y sus mediciones en muestras.json.
 *
 *   pnpm --filter @nexo/evidencias musica              # 50 s por variante
 *   pnpm --filter @nexo/evidencias musica -- 120       # otra duración (s)
 *
 * Todo es determinista: la misma duración produce los mismos archivos (mismo SHA-256).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PAQUETE } from "./entorno.js";
import { AUTORIA, describir, ESTILO, FUNDIDO_ENTRADA_S, FUNDIDO_SALIDA_S, huellaPcm, sintetizar, VARIANTES, wav } from "./musica.js";
import { AUDIO, espectrograma, FFMPEG, filtroLoudnorm, leerLoudnorm, medirAstats, medirLoudnorm, medirSonoridad } from "./video.js";

const run = promisify(execFile);
const duracion = Number(process.argv.slice(2).find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 50);
const salida = join(PAQUETE, "musica");
mkdirSync(salida, { recursive: true });
const trabajo = mkdtempSync(join(tmpdir(), "musica-muestras-"));
const variantes: Array<Record<string, unknown>> = [];
try {
  for (const v of VARIANTES) {
    const t0 = Date.now();
    const pista = sintetizar(duracion, v);
    const rutaWav = join(trabajo, `v${v}.wav`);
    writeFileSync(rutaWav, wav(pista));
    const medicion = await medirLoudnorm(rutaWav);
    const archivo = `ambiental-calido-${v}.m4a`;
    const destino = join(salida, archivo);
    const r = await run(
      FFMPEG,
      ["-y", "-hide_banner", "-nostats", "-i", rutaWav, "-af", `${filtroLoudnorm(medicion)},aresample=${AUDIO.frecuencia}`, "-c:a", "aac", "-b:a", `${AUDIO.kbps}k`, "-ar", String(AUDIO.frecuencia), "-ac", "2", "-map_metadata", "-1", "-metadata", `title=Yago Nexo · ${ESTILO} · variante ${v}`, "-metadata", `comment=${AUTORIA}`, "-movflags", "+faststart", "-fflags", "+bitexact", "-flags:a", "+bitexact", destino],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const normalizacion = leerLoudnorm(r.stderr).normalization_type;
    const son = await medirSonoridad(destino);
    const est = await medirAstats(destino);
    const png = `ambiental-calido-${v}.png`;
    await espectrograma(destino, join(salida, png), { ancho: 1200, alto: 450 });
    const fila = {
      variante: v,
      archivo,
      espectrograma: png,
      duracion_s: duracion,
      descripcion: describir(pista.plan),
      semilla: pista.plan.semilla,
      acordes: pista.plan.acordes.map((a) => a.acorde),
      segundos_por_acorde: Math.round(pista.plan.acorde * 100) / 100,
      pulsos_por_minuto: Math.round(pista.plan.bpm),
      notas_piano: pista.plan.piano.length,
      sha256_pcm: huellaPcm(pista),
      sha256_m4a: createHash("sha256").update(readFileSync(destino)).digest("hex"),
      normalizacion,
      lufs_integrado: son.integrado,
      rango_lu: son.lra,
      pico_real_dbtp: son.picoReal,
      pico_dbfs: est.picoDb,
      rms_dbfs: est.rmsDb,
      salto_maximo: est.saltoMaximo,
      factor_plano: est.factorPlano,
    };
    variantes.push(fila);
    console.log(`variante ${v}: ${son.integrado} LUFS, pico real ${son.picoReal} dBTP, LRA ${son.lra} LU, ${normalizacion} · ${Date.now() - t0} ms`);
  }
} finally {
  rmSync(trabajo, { recursive: true, force: true });
}
writeFileSync(
  join(salida, "muestras.json"),
  `${JSON.stringify(
    {
      $comment: "Muestras de la música original de los videos. Las genera pnpm --filter @nexo/evidencias musica (tools/evidencias/src/lib/musica-muestras.ts); no editar a mano.",
      estilo: ESTILO,
      autoria: AUTORIA,
      sintesis: "tools/evidencias/src/lib/musica.ts",
      normalizacion: `loudnorm en dos pasadas: ${AUDIO.lufs} LUFS integrado, pico real objetivo ${AUDIO.picoObjetivo} dBTP (máximo ${AUDIO.picoMaximo}), AAC ${AUDIO.kbps} kb/s a ${AUDIO.frecuencia} Hz`,
      fundidos_s: { entrada: FUNDIDO_ENTRADA_S, salida: FUNDIDO_SALIDA_S },
      variantes,
    },
    null,
    2,
  )}\n`,
);
console.log(`Listo: ${variantes.length} muestras en ${salida}`);
