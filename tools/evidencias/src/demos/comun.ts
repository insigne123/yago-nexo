/** Utilidades compartidas por los guiones de las demostraciones. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desdeRaiz } from "../lib/entorno.js";
import { ENV_HIJOS, type Contexto } from "../lib/grabador.js";

export const ejecutar = promisify(execFile);

/**
 * Corre una verificación automática de tools/lab-bootstrap (la misma que usa el equipo) y muestra su salida.
 * Devuelve true si terminó con código 0.
 */
export async function verificacionLab(c: Contexto, _script: string, nombre: string, env: Record<string, string> = {}): Promise<{ ok: boolean; salida: string[] }> {
  // Se ejecuta exactamente lo que se muestra: el script `nombre` de tools/lab-bootstrap (corre src/<_script>.ts).
  const args = ["--silent", "--filter", "@nexo/lab-bootstrap", nombre];
  const r = await c.ejecutarComando("pnpm", args, { cwd: desdeRaiz(), mostrar: `pnpm ${args.join(" ")}`, env });
  return { ok: r.codigo === 0, salida: r.salida };
}

/** Corre un script de tools/lab-bootstrap sin mostrarlo (preparación). */
export async function scriptLab(script: string): Promise<string> {
  const { stdout } = await ejecutar(desdeRaiz("tools/lab-bootstrap/node_modules/.bin/tsx"), [`src/${script}.ts`], {
    cwd: desdeRaiz("tools/lab-bootstrap"),
    env: ENV_HIJOS(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** nexo-ctl, la CLI del pipeline, con la configuración de etapas del repositorio. */
export function nexoCtl(c: Contexto, args: string[], mostrar?: string) {
  return c.ejecutarComando(desdeRaiz("tools/nexo-ctl/node_modules/.bin/tsx"), ["src/cli.ts", "-c", "../../nexo-ctl.config.yaml", ...args], {
    cwd: desdeRaiz("tools/nexo-ctl"),
    mostrar: mostrar ?? `nexo-ctl ${args.join(" ")}`,
    tablas: false,
  });
}

/** Espera hasta que fn() cumpla pred o se acabe el tiempo; devuelve el valor y los segundos. */
export async function esperarHasta<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutSeg: number, cadaMs = 1000): Promise<{ valor: T; seg: number } | undefined> {
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
export async function verPagina(c: Contexto, objetivo?: Parameters<Contexto["estudio"]["mover"]>[0]): Promise<void> {
  const vp = c.app.viewportSize() ?? { width: 1280, height: 720 };
  const destino = objetivo ?? { x: Math.round(vp.width * 0.5), y: Math.round(vp.height * 0.42), width: 24, height: 24 };
  await c.estudio.mover(destino).catch(() => undefined);
}
