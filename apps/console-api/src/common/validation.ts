import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

/** Valida la entrada con zod y responde 400 con el detalle en español si no cumple. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new BadRequestException({
      statusCode: 400,
      message: "Datos de entrada inválidos",
      issues: res.error.issues.map((i) => ({ campo: i.path.join("."), detalle: i.message })),
    });
  }
  return res.data;
}
