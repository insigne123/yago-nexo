/**
 * Graba las demostraciones registradas y actualiza el índice de evidencias.
 *
 *   pnpm --filter @nexo/evidencias grabar                         # todas, contra el laboratorio (modo oficial)
 *   pnpm --filter @nexo/evidencias grabar -- D-01 BT-005          # solo algunas
 *   pnpm --filter @nexo/evidencias grabar -- --etiqueta v1.2.0    # etiqueta de la versión (por defecto v1.2.0)
 *   pnpm --filter @nexo/evidencias grabar --ensayo d04            # ENSAYO sin laboratorio (servidor de ensayo)
 *   pnpm --filter @nexo/evidencias grabar --ensayo motor          # ensayo propio del motor (todas las capas)
 *   pnpm --filter @nexo/evidencias grabar --rendimiento 20        # prueba de rendimiento de la captura
 *
 * Opciones: --salida <carpeta>, --sin-compilar, --ritmo <0,5–2> (solo pausas de lectura),
 * --perfil 1600x900 | 1920x1080@25 (captura alternativa si 1920×1080 a 30 cps no rinde).
 * Las demostraciones se graban en el orden en que se piden (la sesión oficial: ver README.md, «Grabación oficial»).
 *
 * Modo oficial: exige la etiqueta (HEAD = etiqueta + cambios solo en tools/evidencias y tools/aceptacion, sin
 * cambios sin confirmar), el chequeo previo de la máquina (disco ≥ 8 GB, memoria, CPU), el laboratorio arriba
 * (make up, make legado, make continuidad) y el bootstrap aplicado. Compila la Consola antes de grabar.
 * Salida: release/evidencias/<ID>_<tema>.mp4 (+ .sin-musica.mp4, .pasos.json, .vtt, .capitulos.vtt, .jpg),
 * evidencias.json y SHA256SUMS.txt; copia del índice y de las sumas en apps/site/src/data/.
 *
 * Modo ensayo: sin laboratorio ni Docker; los guiones corren contra un servidor local que imita la Consola,
 * Keycloak, el gateway y los portales. Todo el video va rotulado ENSAYO, su pasos.json dice ensayo:true, se
 * escribe en release/evidencias/ensayo y nunca entra en evidencias.json del sitio (verificar.ts lo rechaza). En su
 * carpeta deja un índice de ensayo (rehearsal: true) para correr `verificar -- --dir <carpeta> --sin-sitio`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  evaluarRecursos,
  medirRecursos,
  rutaMasLlena,
  UMBRALES_ENSAYO,
  UMBRALES_OFICIAL,
} from "./lib/chequeo.js";
import { elegirEnOrden, leerArgumentos } from "./lib/cli.js";
import { ServidorEnsayo } from "./lib/ensayo.js";
import {
  cargarEnv,
  desdeRaiz,
  leerVersion,
  metaGrabacion,
  problemasModoOficial,
  revisarEtiqueta,
  SALIDA,
  SALIDA_ENSAYO,
} from "./lib/entorno.js";
import type { Evidencia } from "./lib/grabador.js";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

let args: ReturnType<typeof leerArgumentos>;
try {
  args = leerArgumentos(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
const ensayo = args.ensayo || args.rendimiento !== undefined;

// ── Modo ensayo: el servidor de ensayo se levanta ANTES de cargar los guiones (sus URL se fijan al cargar) ──
let servidorEnsayo: ServidorEnsayo | undefined;
if (ensayo) {
  servidorEnsayo = new ServidorEnsayo();
  await servidorEnsayo.iniciar();
  const u = servidorEnsayo.url;
  process.env.NEXO_EVIDENCIAS_ENSAYO_URL = u;
  process.env.KEYCLOAK_URL = `${u}/keycloak/realms/nexo`;
  process.env.NEXO_WSO2_URL = `${u}/wso2`;
  process.env.NEXO_CONSOLE_URL = `${u}/api/v1`;
  process.env.NEXO_LAB_CHAOS_V2 = `${u}/chaos-v2/_chaos`;
  console.log(
    `ENSAYO sin laboratorio: servidor de ensayo en ${u}. Nada de lo que se grabe es evidencia ni se publica.`,
  );
} else {
  // Modo oficial: la versión grabada es la etiqueta (V10). Se revisa antes de tocar el laboratorio.
  const problemas = problemasModoOficial(revisarEtiqueta(args.etiqueta), leerVersion());
  if (problemas.length) {
    console.error(`Modo oficial: no se puede grabar.\n  ${problemas.join("\n  ")}`);
    process.exit(2);
  }
  try {
    cargarEnv();
  } catch (e) {
    console.error(`Modo oficial: no se puede grabar: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

const lab = await import("./lib/lab.js");
await lab.instalarDespachadorEnsayo();
const { DEMOS } = await import("./demos/index.js");
const { guionMotor } = await import("./lib/guion-ensayo.js");
const { grabarVideo, lanzarNavegador } = await import("./lib/grabador.js");

const terminar = async (codigo: number): Promise<never> => {
  await servidorEnsayo?.detener();
  process.exit(codigo);
};

const salida = args.salida ?? (ensayo ? SALIDA_ENSAYO : SALIDA);
if (ensayo && resolve(salida) === resolve(SALIDA)) {
  console.error(
    `Un ensayo no se escribe en ${SALIDA} (la carpeta que se publica): use --salida con otra carpeta o la de ensayo por defecto.`,
  );
  await terminar(2);
}

// ── Chequeo previo de la máquina (V10) ──────────────────────────────────────────────────────────────────
function chequeo(): boolean {
  mkdirSync(salida, { recursive: true });
  const r = evaluarRecursos(
    medirRecursos(rutaMasLlena([salida, tmpdir()]), () => existsSync(chromium.executablePath())),
    ensayo ? UMBRALES_ENSAYO : UMBRALES_OFICIAL,
  );
  console.log(`Chequeo previo: ${r.resumen}`);
  for (const a of r.avisos) console.log(`  ⚠ ${a}`);
  if (!r.ok) {
    console.error(`No se puede grabar:\n  ${r.problemas.join("\n  ")}`);
    return false;
  }
  return true;
}

// ── Prueba de rendimiento de la captura (V01) ───────────────────────────────────────────────────────────
if (args.rendimiento !== undefined) {
  const { medirRendimiento } = await import("./lib/rendimiento.js");
  if (!chequeo()) await terminar(2);
  const perfiles = args.perfil ? [args.perfil] : undefined;
  const filas = await medirRendimiento({ segundos: args.rendimiento, ...(perfiles ? { perfiles } : {}) });
  console.table(filas);
  await terminar(0);
}

const meta = metaGrabacion({ ensayo, etiqueta: args.etiqueta });
console.log(
  `Yago Nexo ${meta.version} · producto ${meta.commitProducto}${meta.etiquetaExiste ? ` (${meta.etiqueta})` : " (HEAD: la etiqueta aún no existe)"} · herramientas ${meta.commitHerramientas}`,
);

const disponibles = ensayo ? [...DEMOS, guionMotor] : DEMOS;
// Se graban en el orden pedido (el de la sesión oficial: D-02 primero, D-05 al final); sin ids, en el de DEMOS.
const elegidas = args.ids.length ? elegirEnOrden(disponibles, args.ids) : ensayo ? [guionMotor] : DEMOS;
if (args.ids.length && elegidas.length !== new Set(args.ids).size) {
  console.error(
    `Demostración desconocida: ${args.ids.filter((i) => !disponibles.some((d) => d.id === i)).join(", ")}. Disponibles: ${disponibles.map((d) => d.id).join(", ")}`,
  );
  await terminar(2);
}
if (!chequeo()) await terminar(2);

// La Consola que se graba se compila desde el mismo commit (apps/console-web/dist).
if (!ensayo && !args.sinCompilar) {
  console.log("Compilando la Consola (apps/console-web)…");
  execFileSync("pnpm", ["--filter", "@nexo/console-web", "build"], {
    cwd: desdeRaiz(),
    stdio: ["ignore", "ignore", "inherit"],
  });
}

const INDICE = join(SALIDA, "evidencias.json");
mkdirSync(salida, { recursive: true });
const previas: Evidencia[] =
  !ensayo && existsSync(INDICE)
    ? (JSON.parse(readFileSync(INDICE, "utf8")) as { evidencias: Evidencia[] }).evidencias
    : [];

function escribirIndice(lista: Evidencia[]) {
  const orden = DEMOS.map((d) => d.id);
  // Solo demostraciones vigentes cuyo video existe (se descartan pruebas, ensayos y entradas sin archivo).
  const ordenadas = lista
    .filter((e) => orden.includes(e.id) && !e.rehearsal && existsSync(join(SALIDA, e.file)))
    .sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id));
  const indice = {
    $schema: "./evidencias.schema.json",
    $comment:
      "Índice de las demostraciones registradas de Yago Nexo. Lo genera tools/evidencias (pnpm --filter @nexo/evidencias grabar). Los videos se publican junto al sitio en /evidencias/<archivo>.",
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

/**
 * Índice de ENSAYO en la carpeta de salida del ensayo (nunca en release/evidencias ni en el sitio): permite correr
 * `verificar -- --dir <carpeta> --sin-sitio` sobre los ensayos, que deben cumplir todo salvo «no es ensayo».
 */
function escribirIndiceEnsayo(nuevas: Evidencia[]) {
  const archivo = join(salida, "evidencias.json");
  const previasEnsayo: Evidencia[] = existsSync(archivo)
    ? ((JSON.parse(readFileSync(archivo, "utf8")) as { evidencias?: Evidencia[] }).evidencias ?? [])
    : [];
  const porId = new Map(previasEnsayo.map((e) => [e.id, e]));
  for (const e of nuevas) porId.set(e.id, e);
  const vigentes = [...porId.values()].filter((e) => existsSync(join(salida, e.file)));
  const indice = {
    $comment:
      "ENSAYO sin laboratorio: índice de prueba del motor de grabación. No es evidencia, no se publica y verificar.ts lo rechaza («no es ensayo»).",
    generado: new Date().toISOString(),
    ensayo: true,
    evidencias: vigentes.map((e) => ({ ...e, rehearsal: true })),
  };
  writeFileSync(archivo, `${JSON.stringify(indice, null, 2)}\n`);
  writeFileSync(
    join(salida, "SHA256SUMS.txt"),
    `${vigentes.map((e) => `${e.sha256}  ${e.file}`).join("\n")}\n`,
  );
}

/*
 * Las reglas activas del guardián de anomalías quedan en pausa durante la sesión de grabación: la carga de
 * prueba de varias demostraciones (20 llamadas/s sin historia previa) se trataría como abuso y bloquearía al
 * consumidor del laboratorio a mitad de otra demostración. D-02 crea y activa su propia regla. Al final se
 * reactivan, cuando ya no queda carga reciente en la ventana del guardián.
 */
type Regla = {
  id: string;
  name: string;
  enabled: boolean;
  metric: string;
  sensitivity: number;
  minVolume: number;
  action: string;
  blockTtlMinutes: number;
  apiId?: string;
};
const pausadas: Regla[] = [];
const activar = async (r: Regla, enabled: boolean) =>
  lab.consola(await lab.tokenPersona("admin.nexo"), "PATCH", `/anomaly-rules/${r.id}`, {
    name: r.name,
    apiId: r.apiId,
    metric: r.metric,
    sensitivity: r.sensitivity,
    minVolume: r.minVolume,
    action: r.action,
    blockTtlMinutes: r.blockTtlMinutes,
    enabled,
  });
if (!ensayo) {
  const adm = await lab.tokenPersona("admin.nexo");
  pausadas.push(...(await lab.consola<Regla[]>(adm, "GET", "/anomaly-rules")).data.filter((r) => r.enabled));
  for (const r of pausadas) await activar(r, false);
  if (pausadas.length)
    console.log(
      `Reglas del guardián en pausa durante la grabación: ${pausadas.map((r) => r.name).join(", ")}`,
    );
}

const navegador = await lanzarNavegador();
const lista = new Map(previas.map((e) => [e.id, e]));
const fallas: string[] = [];
for (const demo of elegidas) {
  console.log(`\n▶ ${demo.id} · ${demo.nombre}${ensayo ? " · ENSAYO" : ""}`);
  const t0 = Date.now();
  if (!chequeo()) {
    fallas.push(`${demo.id}: chequeo previo`);
    break;
  }
  try {
    const g = await grabarVideo(demo, {
      meta,
      navegador,
      salida,
      ritmo: args.ritmo,
      ...(args.perfil ? { perfil: args.perfil } : {}),
    });
    const ev = g.evidencia!;
    if (!ensayo) {
      lista.set(ev.id, ev);
      escribirIndice([...lista.values()]);
    } else escribirIndiceEnsayo([ev]);
    for (const a of g.avisos) console.log(`  ⚠ ${a}`);
    console.log(`✔ ${demo.id}: ${join(salida, ev.file)} · ${ev.duration_seconds} s · ${ev.result}`);
  } catch (e) {
    fallas.push(`${demo.id}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(
      `✘ ${demo.id} NO se guardó (${Math.round((Date.now() - t0) / 1000)} s): ${e instanceof Error ? e.message : e}`,
    );
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
  await terminar(1);
}
console.log(
  `\nListo: ${elegidas.length} ${ensayo ? "ensayos (no publicables)" : "demostraciones"} en ${salida}`,
);
await terminar(0);
