/**
 * Graba las demostraciones registradas contra el laboratorio y actualiza el índice de evidencias.
 *
 *   pnpm --filter @nexo/evidencias grabar                 # todas
 *   pnpm --filter @nexo/evidencias grabar -- D-01 BT-005  # solo algunas
 *   pnpm --filter @nexo/evidencias grabar -- --permitir-cambios   # con cambios sin confirmar (pruebas)
 *
 * Requisitos: laboratorio arriba (make up, make legado, make continuidad) y el bootstrap aplicado. Compila la
 * Consola antes de grabar (--sin-compilar lo omite).
 *
 * Salida: release/evidencias/<ID>_<tema>.webm, evidencias.json y SHA256SUMS.txt; copia del índice y de las
 * sumas en apps/site/src/data/ para la página /evidencias del sitio.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMOS } from "./demos/index.js";
import { cargarEnv, desdeRaiz, meta, SALIDA } from "./lib/entorno.js";
import { grabar, lanzarNavegador, type Evidencia } from "./lib/grabador.js";
import { consola, tokenPersona } from "./lib/lab.js";

cargarEnv();
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

const args = process.argv.slice(2).filter((a) => a !== "--");
const permitirCambios = args.includes("--permitir-cambios");
const pedidas = args.filter((a) => !a.startsWith("--"));
const elegidas = pedidas.length ? DEMOS.filter((d) => pedidas.includes(d.id)) : DEMOS;
if (pedidas.length && elegidas.length !== pedidas.length) {
  const conocidas = DEMOS.map((d) => d.id).join(", ");
  console.error(`Demostración desconocida. Disponibles: ${conocidas}`);
  process.exit(2);
}

const m = meta();
const sucios = m.cambiosLocales.filter((f) => !f.startsWith("release/evidencias") && !f.startsWith("apps/site/src/data/evidencias") && !f.startsWith("apps/site/src/data/SHA256SUMS"));
if (sucios.length && !permitirCambios) {
  console.error(`Hay cambios sin confirmar; el commit del video no los incluiría:\n  ${sucios.join("\n  ")}\nConfirme los cambios o use --permitir-cambios (solo para pruebas).`);
  process.exit(2);
}

// La Consola que se graba se compila desde el mismo commit (apps/console-web/dist).
if (!args.includes("--sin-compilar")) {
  console.log("Compilando la Consola (apps/console-web)…");
  execFileSync("pnpm", ["--filter", "@nexo/console-web", "build"], { cwd: desdeRaiz(), stdio: ["ignore", "ignore", "inherit"] });
}

const INDICE = join(SALIDA, "evidencias.json");
mkdirSync(SALIDA, { recursive: true });
const previas: Evidencia[] = existsSync(INDICE) ? (JSON.parse(readFileSync(INDICE, "utf8")) as { evidencias: Evidencia[] }).evidencias : [];

function escribirIndice(lista: Evidencia[]) {
  const orden = DEMOS.map((d) => d.id);
  // Solo demostraciones vigentes cuyo video existe (se descartan pruebas y entradas sin archivo).
  const ordenadas = lista
    .filter((e) => orden.includes(e.id) && existsSync(join(SALIDA, e.file)))
    .sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id));
  const indice = {
    $comment: "Índice de las demostraciones registradas de Yago Nexo. Lo genera tools/evidencias (pnpm --filter @nexo/evidencias grabar). Los videos se publican junto al sitio en /evidencias/<archivo>.",
    generado: new Date().toISOString(),
    evidencias: ordenadas,
  };
  writeFileSync(INDICE, `${JSON.stringify(indice, null, 2)}\n`);
  const sumas = ordenadas.map((e) => `${e.sha256}  ${e.file}`).join("\n");
  writeFileSync(join(SALIDA, "SHA256SUMS.txt"), `${sumas}\n`);
  const datos = desdeRaiz("apps/site/src/data");
  copyFileSync(INDICE, join(datos, "evidencias.json"));
  copyFileSync(join(SALIDA, "SHA256SUMS.txt"), join(datos, "SHA256SUMS.txt"));
}

/*
 * Las reglas activas del guardián de anomalías quedan en pausa durante la sesión de grabación: la carga de
 * prueba de varias demostraciones (20 llamadas/s sin historia previa) se trataría como abuso y bloquearía al
 * consumidor del laboratorio a mitad de otra demostración. D-02 crea y activa su propia regla. Al final se
 * reactivan, cuando ya no queda carga reciente en la ventana del guardián.
 */
type Regla = { id: string; name: string; enabled: boolean; metric: string; sensitivity: number; minVolume: number; action: string; blockTtlMinutes: number; apiId?: string };
const adm = await tokenPersona("admin.nexo");
const pausadas = (await consola<Regla[]>(adm, "GET", "/anomaly-rules")).data.filter((r) => r.enabled);
const activar = async (r: Regla, enabled: boolean) =>
  consola(await tokenPersona("admin.nexo"), "PATCH", `/anomaly-rules/${r.id}`, { name: r.name, apiId: r.apiId, metric: r.metric, sensitivity: r.sensitivity, minVolume: r.minVolume, action: r.action, blockTtlMinutes: r.blockTtlMinutes, enabled });
for (const r of pausadas) await activar(r, false);
if (pausadas.length) console.log(`Reglas del guardián en pausa durante la grabación: ${pausadas.map((r) => r.name).join(", ")}`);

const navegador = await lanzarNavegador();
const lista = new Map(previas.map((e) => [e.id, e]));
const fallas: string[] = [];
for (const demo of elegidas) {
  console.log(`\n▶ ${demo.id} · ${demo.nombre}`);
  const t0 = Date.now();
  try {
    const ev = await grabar(demo, { meta: m, navegador });
    lista.set(ev.id, ev);
    escribirIndice([...lista.values()]);
    console.log(`✔ ${demo.id}: ${ev.file} · ${ev.duration_seconds} s · ${ev.result}`);
  } catch (e) {
    fallas.push(`${demo.id}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`✘ ${demo.id} NO se guardó (${Math.round((Date.now() - t0) / 1000)} s): ${e instanceof Error ? e.message : e}`);
  }
}
await navegador.close();
if (pausadas.length) {
  console.log("Esperando 60 s sin carga antes de reactivar las reglas del guardián…");
  await new Promise((r) => setTimeout(r, 60_000));
  for (const r of pausadas) await activar(r, true);
  console.log(`Reglas reactivadas: ${pausadas.map((r) => r.name).join(", ")}`);
}
if (fallas.length) {
  console.error(`\n${fallas.length} demostraciones fallaron:\n  ${fallas.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nListo: ${elegidas.length} demostraciones en ${SALIDA}`);
