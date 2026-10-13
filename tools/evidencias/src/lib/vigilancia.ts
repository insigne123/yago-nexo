/**
 * Vigilancia de textos prohibidos en pantalla (V10). Ningún video publicado puede mostrar el nombre de la
 * institución compradora, de un cliente ni el identificador del proceso de compra. Como el repositorio es
 * público, la lista no se escribe en claro: se guardan las huellas SHA-256 de cada término normalizado
 * (minúsculas, sin tildes, solo letras y dígitos separados por un espacio) y se comparan con las huellas
 * de todas las secuencias de 1 a 4 palabras del texto visible.
 *
 * Términos adicionales (p. ej. nombres de clientes) se agregan sin escribirlos en el repositorio:
 *   EVIDENCIAS_PROHIBIDOS="término uno,término dos"         (texto; se normaliza y se convierte en huella)
 *   EVIDENCIAS_PROHIBIDOS_HUELLAS="<sha256>,<sha256>"       (huellas ya calculadas con huellaTermino())
 */
import { createHash } from "node:crypto";

/** Huellas incluidas en el motor: institución compradora (sigla y nombre largo) e id del proceso de compra. */
export const HUELLAS_MOTOR: readonly string[] = [
  "042c865e36ad2a6a38aa95665a3cdbb9492f8192739b678c34a29b8915b7688d",
  "1409a83dfda2d0d17ff6ed58e56d567df8f5d3fcc9753a2dd27750bc1aa45980",
  "8f96fa16e7d81b36506c444e192f1d4078809e3a50b1d626c221e3bac6b26a72",
];

const MAX_PALABRAS = 4;

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function huellaTermino(termino: string): string {
  return createHash("sha256").update(normalizar(termino)).digest("hex");
}

export function huellasConfiguradas(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const s = new Set(HUELLAS_MOTOR);
  for (const t of (env.EVIDENCIAS_PROHIBIDOS ?? "").split(",")) if (normalizar(t)) s.add(huellaTermino(t));
  for (const h of (env.EVIDENCIAS_PROHIBIDOS_HUELLAS ?? "").split(",")) if (/^[0-9a-f]{64}$/.test(h.trim())) s.add(h.trim());
  return s;
}

export interface Hallazgo {
  /** Fragmento del texto original alrededor del hallazgo (solo para el mensaje de error local). */
  contexto: string;
  palabras: number;
}

/** Busca términos prohibidos en un texto. Devuelve un hallazgo por aparición. */
export function buscarProhibidos(texto: string, huellas: ReadonlySet<string> = huellasConfiguradas()): Hallazgo[] {
  const palabras = normalizar(texto).split(" ").filter(Boolean);
  const r: Hallazgo[] = [];
  const cache = new Map<string, boolean>();
  for (let i = 0; i < palabras.length; i++) {
    let frase = "";
    for (let n = 1; n <= MAX_PALABRAS && i + n <= palabras.length; n++) {
      frase = n === 1 ? palabras[i]! : `${frase} ${palabras[i + n - 1]}`;
      let prohibida = cache.get(frase);
      if (prohibida === undefined) {
        prohibida = huellas.has(createHash("sha256").update(frase).digest("hex"));
        cache.set(frase, prohibida);
      }
      if (prohibida) r.push({ contexto: palabras.slice(Math.max(0, i - 4), i + n + 4).join(" "), palabras: n });
    }
  }
  return r;
}

/** Acumula las infracciones de una grabación (el video se descarta si hay alguna). */
export class Vigilante {
  readonly infracciones: string[] = [];
  private readonly huellas: ReadonlySet<string>;
  private ultimo = new Map<string, string>();

  constructor(huellas?: ReadonlySet<string>) {
    this.huellas = huellas ?? huellasConfiguradas();
  }

  /**
   * Revisa un texto; `origen` indica dónde apareció (pantalla, panel, terminal, teclado…). Con `repetido`
   * (revisiones periódicas de una pantalla), si el texto no cambió desde la última vez no se recalcula.
   */
  revisar(origen: string, texto: string | undefined | null, repetido = false): boolean {
    if (!texto) return true;
    if (repetido) {
      if (this.ultimo.get(origen) === texto) return true;
      this.ultimo.set(origen, texto);
    }
    const h = buscarProhibidos(texto, this.huellas);
    for (const x of h) this.infracciones.push(`${origen}: «…${x.contexto}…»`);
    return h.length === 0;
  }
}
