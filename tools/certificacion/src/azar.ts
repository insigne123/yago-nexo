import { createHash } from "node:crypto";

/**
 * Generador pseudoaleatorio con semilla (xoshiro128**). La misma semilla produce siempre la misma
 * secuencia, en cualquier equipo: así un examen se puede volver a generar idéntico para revisarlo.
 * No es criptográfico; solo se usa para sortear preguntas y ordenar alternativas.
 */
export type Azar = () => number;

export function azarConSemilla(semilla: string): Azar {
  const h = createHash("sha256").update(`nexo-certificacion|${semilla}`, "utf8").digest();
  const s = [h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)];
  if (!s.some((x) => x !== 0)) s[0] = 1; // el estado no puede ser todo ceros
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const resultado = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1]! << 9) >>> 0;
    s[2] = (s[2]! ^ s[0]!) >>> 0;
    s[3] = (s[3]! ^ s[1]!) >>> 0;
    s[1] = (s[1]! ^ s[2]!) >>> 0;
    s[0] = (s[0]! ^ s[3]!) >>> 0;
    s[2] = (s[2]! ^ t) >>> 0;
    s[3] = rotl(s[3]!, 11);
    return resultado / 2 ** 32;
  };
}

/** Entero uniforme en [0, n). */
export function entero(azar: Azar, n: number): number {
  return Math.floor(azar() * n);
}

/** Copia barajada (Fisher-Yates) sin modificar la lista original. */
export function barajar<T>(azar: Azar, lista: readonly T[]): T[] {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = entero(azar, i + 1);
    [copia[i], copia[j]] = [copia[j]!, copia[i]!];
  }
  return copia;
}
