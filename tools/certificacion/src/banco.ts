import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

/** Carpeta del paquete (tools/certificacion) y raíz del repositorio. */
export const DIR_PAQUETE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RAIZ_REPO = resolve(DIR_PAQUETE, "../..");
export const BANCO_POR_OMISION = resolve(DIR_PAQUETE, "banco.yaml");
export const PRACTICO_POR_OMISION = resolve(DIR_PAQUETE, "practico.yaml");

/** Módulos que entran al examen teórico. M7 es el módulo de repaso y evaluación: no tiene preguntas propias. */
export const MODULOS_EXAMEN = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"] as const;
export type ModuloExamen = (typeof MODULOS_EXAMEN)[number];
export const DIFICULTADES = ["baja", "media", "alta"] as const;
export type Dificultad = (typeof DIFICULTADES)[number];
export const LETRAS = ["a", "b", "c", "d"] as const;
export type Letra = (typeof LETRAS)[number];

const texto = z.string().trim().min(1);

export const PreguntaSchema = z
  .object({
    id: z.string().regex(/^M[0-6]-\d{2}$/, "el id debe tener la forma M3-07"),
    modulo: z.enum(MODULOS_EXAMEN),
    dificultad: z.enum(DIFICULTADES),
    enunciado: texto,
    opciones: z.object({ a: texto, b: texto, c: texto, d: texto }).strict(),
    correcta: z.enum(LETRAS),
    justificacion: texto,
    referencia: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (!p.id.startsWith(`${p.modulo}-`))
      ctx.addIssue({ code: "custom", message: `el id ${p.id} no corresponde al módulo ${p.modulo}` });
    const textos = LETRAS.map((l) => p.opciones[l].toLowerCase());
    if (new Set(textos).size !== textos.length)
      ctx.addIssue({ code: "custom", message: `la pregunta ${p.id} tiene alternativas repetidas` });
  });
export type Pregunta = z.infer<typeof PreguntaSchema>;

export const BancoSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    producto: texto,
    preguntas: z.array(PreguntaSchema).min(1),
  })
  .strict()
  .superRefine((b, ctx) => {
    const vistos = new Set<string>();
    for (const p of b.preguntas) {
      if (vistos.has(p.id)) ctx.addIssue({ code: "custom", message: `id de pregunta duplicado: ${p.id}` });
      vistos.add(p.id);
    }
  });
export type Banco = z.infer<typeof BancoSchema>;

const VerificacionSchema = z
  .object({
    descripcion: texto,
    /** Script de tools/lab-bootstrap (pnpm --filter @nexo/lab-bootstrap <check>). */
    check: z.string().trim().min(1).optional(),
    /** Objetivo de deploy/compose/Makefile (make -C deploy/compose <make>). */
    make: z.string().trim().min(1).optional(),
    /** Comando o consulta de comprobación cuando no hay un script dedicado. */
    comando: z.string().trim().min(1).optional(),
    esperado: texto,
  })
  .strict()
  .refine((v) => v.check || v.make || v.comando, {
    message: "cada verificación necesita check, make o comando",
  });

export const TareaSchema = z
  .object({
    id: z.string().regex(/^P\d$/),
    titulo: texto,
    modulos: z.array(z.enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"])).min(1),
    puntos: z.number().int().positive(),
    tiempo_minutos: z.number().int().positive(),
    obligatoria: z.boolean(),
    preparacion: z.array(texto).default([]),
    enunciado: texto,
    entregables: z.array(texto).min(1),
    criterios: z.array(texto).min(1),
    verificacion: z.array(VerificacionSchema).min(1),
  })
  .strict();
export type Tarea = z.infer<typeof TareaSchema>;

export const PracticoSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    duracion_minutos: z.number().int().positive(),
    aprobacion: z
      .object({
        porcentaje_minimo: z.number().min(0).max(100),
        obligatorias: z.array(z.string()),
      })
      .strict(),
    reglas: z.array(texto).default([]),
    tareas: z.array(TareaSchema).min(4).max(6),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = p.tareas.map((t) => t.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "hay tareas con el mismo id" });
    for (const o of p.aprobacion.obligatorias)
      if (!ids.includes(o)) ctx.addIssue({ code: "custom", message: `la tarea obligatoria ${o} no existe` });
    for (const t of p.tareas)
      if (t.obligatoria !== p.aprobacion.obligatorias.includes(t.id))
        ctx.addIssue({
          code: "custom",
          message: `la tarea ${t.id} no coincide con la lista de obligatorias`,
        });
  });
export type Practico = z.infer<typeof PracticoSchema>;

function validar<T>(schema: z.ZodType<T>, datos: unknown, origen: string): T {
  const r = schema.safeParse(datos);
  if (!r.success) throw new Error(`${origen} no es válido:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export function sha256(texto: string | Uint8Array): string {
  return createHash("sha256").update(texto).digest("hex");
}

export interface BancoCargado extends Banco {
  /** SHA-256 del archivo tal como se leyó: identifica el banco con que se sorteó un examen. */
  sha256: string;
}

export function leerBanco(ruta = BANCO_POR_OMISION): BancoCargado {
  const contenido = readFileSync(ruta, "utf8");
  return { ...validar(BancoSchema, parse(contenido), ruta), sha256: sha256(contenido) };
}

export function leerPractico(ruta = PRACTICO_POR_OMISION): Practico {
  return validar(PracticoSchema, parse(readFileSync(ruta, "utf8")), ruta);
}

/** Conteo de preguntas por módulo y dificultad (para el resumen del banco). */
export function resumenBanco(
  banco: Banco,
): Record<ModuloExamen, Record<Dificultad, number> & { total: number }> {
  const out = {} as Record<ModuloExamen, Record<Dificultad, number> & { total: number }>;
  for (const m of MODULOS_EXAMEN) out[m] = { baja: 0, media: 0, alta: 0, total: 0 };
  for (const p of banco.preguntas) {
    out[p.modulo][p.dificultad]++;
    out[p.modulo].total++;
  }
  return out;
}
