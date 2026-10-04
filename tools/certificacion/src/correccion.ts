import { z } from "zod";
import { MODULOS_EXAMEN, type ModuloExamen, type Practico } from "./banco.js";
import type { Examen } from "./sorteo.js";

/** Porcentaje mínimo de respuestas correctas en el examen teórico. */
export const APROBACION_TEORICO = 70;

const EstadoTarea = z.enum(["aprobada", "reprobada", "pendiente"]);

export const HojaSchema = z
  .object({
    examen: z.string().trim().min(1),
    participante: z.object({
      nombre: z.string().trim().min(1, "falta el nombre del participante"),
      documento: z.string().trim().min(1, "falta el documento de identidad del participante"),
    }),
    respuestas: z.record(z.string(), z.union([z.string(), z.null()])).default({}),
    practico: z
      .object({
        evaluador: z.string().trim().default(""),
        tareas: z.record(z.string(), EstadoTarea).default({}),
      })
      .default({ evaluador: "", tareas: {} }),
  })
  .strict();
export type Hoja = z.infer<typeof HojaSchema>;

export function validarHoja(datos: unknown, origen = "la hoja de respuestas"): Hoja {
  const r = HojaSchema.safeParse(datos);
  if (!r.success) throw new Error(`${origen} no es válida:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export interface ResultadoTeorico {
  correctas: number;
  total: number;
  porcentaje: number;
  aprobado: boolean;
  porModulo: Record<ModuloExamen, { correctas: number; total: number }>;
  detalle: Array<{
    n: number;
    id: string;
    modulo: ModuloExamen;
    respuesta: string | null;
    correcta: string;
    ok: boolean;
  }>;
}

export interface ResultadoPractico {
  puntos: number;
  maximo: number;
  porcentaje: number;
  aprobado: boolean;
  evaluador: string;
  tareas: Array<{
    id: string;
    titulo: string;
    estado: "aprobada" | "reprobada" | "pendiente";
    puntos: number;
    obligatoria: boolean;
  }>;
  motivos: string[];
}

export interface Resultado {
  examen: string;
  participante: { nombre: string; documento: string };
  teorico: ResultadoTeorico;
  practico: ResultadoPractico;
  aprobado: boolean;
}

const redondear = (x: number) => Math.round(x * 10) / 10;

export function corregirTeorico(examen: Examen, respuestas: Hoja["respuestas"]): ResultadoTeorico {
  const porModulo = {} as ResultadoTeorico["porModulo"];
  for (const m of MODULOS_EXAMEN) porModulo[m] = { correctas: 0, total: 0 };
  const detalle = examen.preguntas.map((p) => {
    const bruta = respuestas[String(p.n)];
    const respuesta = typeof bruta === "string" && bruta.trim() !== "" ? bruta.trim().toLowerCase() : null;
    const ok = respuesta === p.correcta;
    porModulo[p.modulo].total++;
    if (ok) porModulo[p.modulo].correctas++;
    return { n: p.n, id: p.id, modulo: p.modulo, respuesta, correcta: p.correcta, ok };
  });
  const correctas = detalle.filter((d) => d.ok).length;
  const total = examen.preguntas.length;
  return {
    correctas,
    total,
    porcentaje: redondear((100 * correctas) / total),
    // Comparación entera: 28 de 40 es exactamente 70 % y aprueba.
    aprobado: correctas * 100 >= APROBACION_TEORICO * total,
    porModulo,
    detalle,
  };
}

export function corregirPractico(practico: Practico, hoja: Hoja["practico"]): ResultadoPractico {
  const desconocidas = Object.keys(hoja.tareas).filter((id) => !practico.tareas.some((t) => t.id === id));
  if (desconocidas.length)
    throw new Error(`la hoja informa tareas que no existen en el práctico: ${desconocidas.join(", ")}`);
  const tareas = practico.tareas.map((t) => {
    const estado = hoja.tareas[t.id] ?? "pendiente";
    return {
      id: t.id,
      titulo: t.titulo,
      estado,
      puntos: estado === "aprobada" ? t.puntos : 0,
      obligatoria: t.obligatoria,
    };
  });
  const maximo = practico.tareas.reduce((s, t) => s + t.puntos, 0);
  const puntos = tareas.reduce((s, t) => s + t.puntos, 0);
  const motivos: string[] = [];
  const pendientes = tareas.filter((t) => t.estado === "pendiente").map((t) => t.id);
  if (pendientes.length) motivos.push(`tareas sin evaluar: ${pendientes.join(", ")}`);
  const obligatoriasReprobadas = tareas
    .filter((t) => t.obligatoria && t.estado !== "aprobada")
    .map((t) => t.id);
  if (obligatoriasReprobadas.length)
    motivos.push(`tareas obligatorias no aprobadas: ${obligatoriasReprobadas.join(", ")}`);
  if (puntos * 100 < practico.aprobacion.porcentaje_minimo * maximo)
    motivos.push(
      `puntaje ${puntos} de ${maximo}, bajo el mínimo de ${practico.aprobacion.porcentaje_minimo} %`,
    );
  if (!hoja.evaluador) motivos.push("falta el nombre del evaluador del práctico");
  return {
    puntos,
    maximo,
    porcentaje: redondear((100 * puntos) / maximo),
    aprobado: motivos.length === 0,
    evaluador: hoja.evaluador,
    tareas,
    motivos,
  };
}

/** Corrige una hoja: aprueba quien tiene al menos 70 % en el teórico Y el práctico aprobado. */
export function corregir(examen: Examen, practico: Practico, hoja: Hoja): Resultado {
  if (hoja.examen !== examen.id)
    throw new Error(`la hoja corresponde al examen "${hoja.examen}" y se entregó el examen "${examen.id}"`);
  const fuera = Object.keys(hoja.respuestas).filter(
    (k) => !/^\d+$/.test(k) || Number(k) < 1 || Number(k) > examen.total,
  );
  if (fuera.length)
    throw new Error(`la hoja tiene respuestas para preguntas que no existen: ${fuera.join(", ")}`);
  const invalidas = Object.entries(hoja.respuestas)
    .filter(([, v]) => typeof v === "string" && v.trim() !== "" && !/^[abcd]$/i.test(v.trim()))
    .map(([k, v]) => `${k}: ${v}`);
  if (invalidas.length) throw new Error(`respuestas que no son a, b, c ni d: ${invalidas.join(", ")}`);
  const teorico = corregirTeorico(examen, hoja.respuestas);
  const pr = corregirPractico(practico, hoja.practico);
  return {
    examen: examen.id,
    participante: hoja.participante,
    teorico,
    practico: pr,
    aprobado: teorico.aprobado && pr.aprobado,
  };
}

/** Informe legible del resultado. */
export function informe(r: Resultado): string {
  const l: string[] = [];
  l.push(`Examen ${r.examen} · ${r.participante.nombre} (${r.participante.documento})`);
  l.push("");
  l.push(
    `Teórico: ${r.teorico.correctas} de ${r.teorico.total} (${r.teorico.porcentaje} %) → ${r.teorico.aprobado ? "APROBADO" : "REPROBADO"} (mínimo ${APROBACION_TEORICO} %)`,
  );
  for (const m of MODULOS_EXAMEN) {
    const x = r.teorico.porModulo[m];
    if (x.total) l.push(`  ${m}: ${x.correctas} de ${x.total}`);
  }
  l.push("");
  l.push(
    `Práctico: ${r.practico.puntos} de ${r.practico.maximo} puntos (${r.practico.porcentaje} %) → ${r.practico.aprobado ? "APROBADO" : "REPROBADO"}`,
  );
  for (const t of r.practico.tareas)
    l.push(`  ${t.id} ${t.obligatoria ? "(obligatoria) " : ""}${t.titulo}: ${t.estado} · ${t.puntos} puntos`);
  for (const m of r.practico.motivos) l.push(`  · ${m}`);
  l.push("");
  l.push(`Resultado final: ${r.aprobado ? "APROBADO" : "REPROBADO"}`);
  return l.join("\n");
}
