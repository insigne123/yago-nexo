import { azarConSemilla, barajar, type Azar } from "./azar.js";
import {
  DIFICULTADES,
  LETRAS,
  MODULOS_EXAMEN,
  type BancoCargado,
  type Dificultad,
  type Letra,
  type ModuloExamen,
  type Pregunta,
} from "./banco.js";

export const PREGUNTAS_POR_EXAMEN = 40;
export const MINUTOS_EXAMEN_TEORICO = 60;

export interface PreguntaExamen {
  /** Número de la pregunta en el examen (1..N). */
  n: number;
  id: string;
  modulo: ModuloExamen;
  dificultad: Dificultad;
  enunciado: string;
  /** Alternativas en el orden en que se presentan, ya con su letra en el examen. */
  opciones: Array<{ letra: Letra; texto: string }>;
  /** Letra correcta en este examen (no la del banco: las alternativas se barajan). */
  correcta: Letra;
  justificacion: string;
}

export interface Examen {
  formato: "nexo-examen/1";
  id: string;
  semilla: string;
  banco: { version: string; producto: string; sha256: string };
  total: number;
  distribucion: Record<ModuloExamen, number>;
  preguntas: PreguntaExamen[];
}

/**
 * Cuántas preguntas van de cada módulo: el reparto es parejo (diferencia máxima de una pregunta entre
 * módulos) y los módulos que reciben una pregunta extra se eligen con la semilla.
 */
export function repartir(azar: Azar, total: number): Record<ModuloExamen, number> {
  const base = Math.floor(total / MODULOS_EXAMEN.length);
  const resto = total % MODULOS_EXAMEN.length;
  const conExtra = new Set(barajar(azar, MODULOS_EXAMEN).slice(0, resto));
  const out = {} as Record<ModuloExamen, number>;
  for (const m of MODULOS_EXAMEN) out[m] = base + (conExtra.has(m) ? 1 : 0);
  return out;
}

/** Elige n preguntas de un módulo alternando dificultades (baja, media, alta), cada grupo barajado. */
function elegirDelModulo(azar: Azar, preguntas: readonly Pregunta[], n: number): Pregunta[] {
  const grupos = DIFICULTADES.map((d) =>
    barajar(
      azar,
      preguntas.filter((p) => p.dificultad === d),
    ),
  );
  const elegidas: Pregunta[] = [];
  const inicio = Math.floor(azar() * grupos.length);
  for (let vuelta = 0; elegidas.length < n; vuelta++) {
    let agrego = false;
    for (let k = 0; k < grupos.length && elegidas.length < n; k++) {
      const g = grupos[(inicio + k) % grupos.length]!;
      const p = g[vuelta];
      if (p) {
        elegidas.push(p);
        agrego = true;
      }
    }
    if (!agrego) break;
  }
  return elegidas;
}

/** Sortea un examen reproducible: la misma semilla y el mismo banco producen exactamente el mismo examen. */
export function sortearExamen(banco: BancoCargado, semilla: string, total = PREGUNTAS_POR_EXAMEN): Examen {
  if (!semilla.trim()) throw new Error("la semilla del examen no puede estar vacía");
  const azar = azarConSemilla(semilla);
  const distribucion = repartir(azar, total);
  const elegidas: Pregunta[] = [];
  for (const m of MODULOS_EXAMEN) {
    const delModulo = banco.preguntas.filter((p) => p.modulo === m);
    if (delModulo.length < distribucion[m])
      throw new Error(
        `el banco tiene ${delModulo.length} preguntas de ${m} y el examen necesita ${distribucion[m]}`,
      );
    elegidas.push(...elegirDelModulo(azar, delModulo, distribucion[m]));
  }
  const preguntas = barajar(azar, elegidas).map((p, i): PreguntaExamen => {
    const orden = barajar(azar, LETRAS);
    const opciones = orden.map((original, j) => ({ letra: LETRAS[j]!, texto: p.opciones[original] }));
    return {
      n: i + 1,
      id: p.id,
      modulo: p.modulo,
      dificultad: p.dificultad,
      enunciado: p.enunciado,
      opciones,
      correcta: LETRAS[orden.indexOf(p.correcta)]!,
      justificacion: p.justificacion,
    };
  });
  return {
    formato: "nexo-examen/1",
    id: semilla,
    semilla,
    banco: { version: banco.version, producto: banco.producto, sha256: banco.sha256 },
    total,
    distribucion,
    preguntas,
  };
}

/** Enunciado para el participante, sin respuestas (Markdown). */
export function examenMarkdown(ex: Examen): string {
  const lineas = [
    `# Examen teórico · Certificación Yago Nexo`,
    "",
    `Examen \`${ex.id}\` · ${ex.total} preguntas · ${MINUTOS_EXAMEN_TEORICO} minutos · ${ex.banco.producto}`,
    "",
    "Cada pregunta tiene una sola alternativa correcta. Anote la letra elegida en su hoja de respuestas.",
    "Se aprueba con al menos 70 % de respuestas correctas. Una pregunta sin respuesta cuenta como incorrecta.",
    "",
  ];
  for (const p of ex.preguntas) {
    lineas.push(`## ${p.n}. ${p.enunciado}`, "");
    for (const o of p.opciones) lineas.push(`- **${o.letra})** ${o.texto}`);
    lineas.push("");
  }
  return `${lineas.join("\n")}`;
}

/** Plantilla de la hoja de respuestas (YAML) que completa el participante y el evaluador del práctico. */
export function plantillaHoja(ex: Examen, tareas: readonly string[]): string {
  const respuestas = ex.preguntas.map((p) => `  ${p.n}: ""`).join("\n");
  const practico = tareas.map((t) => `    ${t}: pendiente   # aprobada | reprobada`).join("\n");
  return [
    "# Hoja de respuestas · Certificación Yago Nexo",
    `examen: ${JSON.stringify(ex.id)}`,
    "participante:",
    '  nombre: ""',
    '  documento: ""   # RUT (12.345.678-5) u otro documento de identidad',
    "respuestas:   # letra a, b, c o d",
    respuestas,
    "practico:   # lo completa el evaluador",
    '  evaluador: ""',
    "  tareas:",
    practico,
    "",
  ].join("\n");
}
