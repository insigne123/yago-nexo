/** Utilidades compartidas por los guiones de las demostraciones. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright-core";
import { desdeRaiz } from "../lib/entorno.js";
import { ENV_HIJOS, pulsoRepintado, type Contexto, type Vista } from "../lib/grabador.js";

export const ejecutar = promisify(execFile);

/**
 * Corre una verificación automática de tools/lab-bootstrap (la misma que usa el equipo) y muestra su salida.
 * Devuelve true si terminó con código 0.
 */
export async function verificacionLab(
  c: Contexto,
  _script: string,
  nombre: string,
  env: Record<string, string> = {},
): Promise<{ ok: boolean; salida: string[] }> {
  // Se ejecuta exactamente lo que se muestra: el script `nombre` de tools/lab-bootstrap (corre src/<_script>.ts).
  const args = ["--silent", "--filter", "@nexo/lab-bootstrap", nombre];
  const r = await c.ejecutarComando("pnpm", args, {
    cwd: desdeRaiz(),
    mostrar: `pnpm ${args.join(" ")}`,
    env,
  });
  return { ok: r.codigo === 0, salida: r.salida };
}

/** Corre un script de tools/lab-bootstrap sin mostrarlo (preparación). */
export async function scriptLab(script: string): Promise<string> {
  const { stdout } = await ejecutar(
    desdeRaiz("tools/lab-bootstrap/node_modules/.bin/tsx"),
    [`src/${script}.ts`],
    {
      cwd: desdeRaiz("tools/lab-bootstrap"),
      env: ENV_HIJOS(),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout;
}

/** nexo-ctl, la CLI del pipeline, con la configuración de etapas del repositorio. */
export function nexoCtl(c: Contexto, args: string[], mostrar?: string) {
  return c.ejecutarComando(
    desdeRaiz("tools/nexo-ctl/node_modules/.bin/tsx"),
    ["src/cli.ts", "-c", "../../nexo-ctl.config.yaml", ...args],
    {
      cwd: desdeRaiz("tools/nexo-ctl"),
      mostrar: mostrar ?? `nexo-ctl ${args.join(" ")}`,
      tablas: false,
    },
  );
}

/** Espera hasta que fn() cumpla pred o se acabe el tiempo; devuelve el valor y los segundos. */
export async function esperarHasta<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutSeg: number,
  cadaMs = 1000,
): Promise<{ valor: T; seg: number } | undefined> {
  const t0 = Date.now();
  for (;;) {
    const valor = await fn();
    if (pred(valor)) return { valor, seg: (Date.now() - t0) / 1000 };
    if ((Date.now() - t0) / 1000 > timeoutSeg) return undefined;
    await new Promise((r) => setTimeout(r, cadaMs));
  }
}

export const fmt = (n: number) => new Intl.NumberFormat("es-CL").format(n);

/**
 * Después de una navegación de documento completo (c.ir, goto, reload), lleva el cursor visible a la página
 * (al objetivo o al centro). Así la página repinta y la captura recibe el cuadro nuevo enseguida: sin un
 * repintado, el screencast puede seguir mostrando la página anterior unos segundos.
 */
export async function verPagina(
  c: Contexto,
  objetivo?: Parameters<Contexto["estudio"]["mover"]>[0],
): Promise<void> {
  const vp = c.app.viewportSize() ?? { width: 1280, height: 720 };
  const destino = objetivo ?? {
    x: Math.round(vp.width * 0.5),
    y: Math.round(vp.height * 0.42),
    width: 24,
    height: 24,
  };
  await c.estudio.mover(destino).catch(() => undefined);
}

/** El pulso de repintado vive en el motor (Contexto.vista y Contexto.mostrar lo usan); se reexporta aquí. */
export { pulsoRepintado };

/**
 * Cambia la vista del estudio. Al pasar a una vista más baja (de «app» a «dividido») la ventana operada se achica,
 * pero si nada cambia en lo que queda a la vista la página no se repinta y la narradora seguiría con el cuadro
 * anterior, escalado a unos 2/3 del ancho: Contexto.vista ya hace entregar cuadros seguidos (pulsoRepintado).
 * Se mantiene por compatibilidad con los guiones que la usan.
 */
export async function cambiarVista(c: Contexto, v: Vista): Promise<void> {
  await c.vista(v);
}

/**
 * Pone en pantalla otra página operada (ya cargada). Contexto.mostrar ya la hace entregar cuadros enseguida (una
 * página quieta que recién se pone en pantalla podía tardar en verse). Se mantiene por compatibilidad.
 */
export async function mostrarLista(c: Contexto, p: Page): Promise<void> {
  await c.mostrar(p);
}

/**
 * Espera a que una página termine de cargar. Con objetivo: hasta que el objetivo se vea (a lo más `ms`) y después
 * un momento de red quieta (a lo más `redMs`, por defecto 2 s), para que termine de dibujar lo que lo rodea; sin
 * objetivo, solo la red quieta (por defecto hasta 8 s). Devuelve true si el objetivo apareció. Sirve para no
 * mostrar ni ampliar una página en blanco o con «Loading…»: se carga primero (también fuera de pantalla) y se
 * muestra después.
 */
export async function esperarCarga(
  p: Page,
  objetivo?: Locator,
  o: { ms?: number; redMs?: number } = {},
): Promise<boolean> {
  const red = (ms: number) => p.waitForLoadState("networkidle", { timeout: ms }).catch(() => undefined);
  if (!objetivo) {
    await red(o.redMs ?? 8000);
    return true;
  }
  const visto = await objetivo
    .first()
    .waitFor({ state: "visible", timeout: o.ms ?? 20_000 })
    .then(
      () => true,
      () => false,
    );
  await red(o.redMs ?? 2000);
  return visto;
}

/** Texto visible de un elemento en una sola línea (los bloques internos separados por « · »). */
export async function textoEnLinea(loc: Locator): Promise<string> {
  const t = await loc.innerText({ timeout: 2000 }).catch(() => "");
  return t
    .split(/\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}
