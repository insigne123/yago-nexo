/**
 * Carga a través del gateway con el mismo generador que usan las verificaciones del laboratorio
 * (tools/lab-bootstrap/src/load.ts), mostrando en la terminal lo que ve el consumidor cada segundo.
 */
import { runLoad, type LoadResult, type LoadSecond } from "../../../lab-bootstrap/src/load.js";
import type { Contexto } from "../lib/grabador.js";

export type { LoadResult, LoadSecond };

export interface CargaEnCurso {
  detener(): void;
  resultado: Promise<LoadResult>;
  /** Últimos segundos observados (para reaccionar durante la demostración). */
  segundos: LoadSecond[];
}

export function iniciarCarga(
  c: Contexto,
  o: { url: string; rps: number; segundos: number; etiqueta: string; cadaSeg?: number; app?: string; codigos?: boolean },
): CargaEnCurso {
  const ctrl = new AbortController();
  const vistos: LoadSecond[] = [];
  const cada = o.cadaSeg ?? 1;
  let acumulado = { ok: 0, err: 0, versiones: {} as Record<string, number> };
  c.log(`$ carga --url ${o.url.replace("https://apim:8243", "gateway")} --rps ${o.rps}   # ${o.etiqueta}`, "cmd");
  const resultado = runLoad({
    url: o.url,
    rps: o.rps,
    seconds: o.segundos,
    signal: ctrl.signal,
    app: o.app,
    onSecond: (s) => {
      vistos.push(s);
      acumulado.ok += s.ok;
      acumulado.err += s.errores;
      for (const [k, n] of Object.entries(s.versiones)) acumulado.versiones[k] = (acumulado.versiones[k] ?? 0) + n;
      if ((s.t + 1) % cada === 0) {
        const versiones = Object.entries(acumulado.versiones)
          .map(([k, n]) => `v${k}:${n}`)
          .join(" ");
        c.log(
          `carga t=${String(s.t + 1).padStart(3)}s  ok=${acumulado.ok}  errores=${acumulado.err}${versiones ? `  ${versiones}` : ""}`,
          acumulado.err > 0 ? "mal" : "tenue",
        );
        acumulado = { ok: 0, err: 0, versiones: {} };
      }
    },
  });
  return { detener: () => ctrl.abort(), resultado, segundos: vistos };
}
