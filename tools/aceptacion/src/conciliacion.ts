/**
 * Conciliación de punta a punta del flujo asíncrono (BT-009, 0-31): cada mensaje enviado al gateway se sigue por
 * su correlación hasta el sistema de destino. Se cuenta con el registro de recepciones del destino, una fila por
 * solicitud HTTP recibida, y no con /_estadisticas, que cuenta registros únicos y por eso no puede mostrar un
 * duplicado.
 */

export interface Enviado {
  /** Número del mensaje dentro de la corrida (1..N). */
  n: number;
  idempotencyKey: string;
  /** Código que devolvió el gateway. */
  status: number;
  /** Correlación que devolvió el flujo (vacía si no fue aceptado). */
  correlacion: string;
}

/** Fila de GET /_recepciones del sistema de destino de ejemplo. */
export interface Recepcion {
  en: string;
  correlacion: string;
  idempotencyKey: string;
  status: number;
  resultado: "creado" | "repeticion" | "rechazado" | "falla-simulada";
}

export interface Fila {
  n: number;
  correlacion: string;
  recepciones: string[];
  creados: number;
}

export interface Conciliacion {
  enviados: number;
  aceptados: number;
  entregados: number;
  /** Registros creados de más en el destino (un mensaje creado 2 veces suma 1). */
  duplicados: number;
  /** Respuestas de falla temporal del destino a mensajes de esta corrida. */
  fallasTemporales: number;
  /** Mensajes que recibieron al menos una falla temporal y luego se entregaron. */
  recuperados: number;
  /** Repeticiones que el destino respondió desde su registro de idempotencia (entregas al menos una vez). */
  repeticiones: number;
  sinEntregar: Fila[];
  noAceptados: Enviado[];
  filas: Fila[];
}

export function conciliar(enviados: Enviado[], recepciones: Recepcion[]): Conciliacion {
  const porCorrelacion = new Map<string, Recepcion[]>();
  for (const r of recepciones) {
    if (!r.correlacion) continue;
    const l = porCorrelacion.get(r.correlacion) ?? [];
    l.push(r);
    porCorrelacion.set(r.correlacion, l);
  }
  const aceptados = enviados.filter((e) => e.status === 202 && e.correlacion);
  const filas: Fila[] = aceptados.map((e) => {
    const propias = porCorrelacion.get(e.correlacion) ?? [];
    return {
      n: e.n,
      correlacion: e.correlacion,
      recepciones: propias.map((r) => `${r.status} ${r.resultado}`),
      creados: propias.filter((r) => r.resultado === "creado").length,
    };
  });
  const propias = aceptados.flatMap((e) => porCorrelacion.get(e.correlacion) ?? []);
  return {
    enviados: enviados.length,
    aceptados: aceptados.length,
    entregados: filas.filter((f) => f.creados >= 1).length,
    duplicados: filas.reduce((n, f) => n + Math.max(0, f.creados - 1), 0),
    fallasTemporales: propias.filter((r) => r.resultado === "falla-simulada").length,
    recuperados: filas.filter(
      (f) => f.creados >= 1 && f.recepciones.some((r) => r.endsWith("falla-simulada")),
    ).length,
    repeticiones: propias.filter((r) => r.resultado === "repeticion").length,
    sinEntregar: filas.filter((f) => f.creados === 0),
    noAceptados: enviados.filter((e) => !(e.status === 202 && e.correlacion)),
    filas,
  };
}

/** Criterio de aceptación: N enviados = N aceptados = N entregados, 0 duplicados y la falla inyectada recuperada. */
export function cumple(
  c: Conciliacion,
  esperados: number,
  fallasInyectadas: number,
): { ok: boolean; motivos: string[] } {
  const motivos: string[] = [];
  if (c.enviados !== esperados) motivos.push(`se enviaron ${c.enviados} de ${esperados}`);
  if (c.aceptados !== c.enviados)
    motivos.push(`${c.enviados - c.aceptados} no fueron aceptados por el gateway`);
  if (c.entregados !== c.enviados) motivos.push(`${c.enviados - c.entregados} no llegaron al destino`);
  if (c.duplicados !== 0) motivos.push(`${c.duplicados} registros duplicados en el destino`);
  if (c.fallasTemporales !== fallasInyectadas)
    motivos.push(
      `se inyectaron ${fallasInyectadas} fallas temporales y el destino respondió ${c.fallasTemporales}`,
    );
  if (c.recuperados !== c.fallasTemporales)
    motivos.push(`${c.fallasTemporales - c.recuperados} mensajes con falla temporal no se recuperaron`);
  return { ok: motivos.length === 0, motivos };
}

export function resumen(c: Conciliacion): string {
  return `${c.enviados} enviados, ${c.aceptados} aceptados (202), ${c.entregados} entregados, ${c.duplicados} duplicados; ${c.fallasTemporales} fallas temporales inyectadas, ${c.recuperados} mensajes recuperados con reintento; ${c.repeticiones} repeticiones respondidas por idempotencia`;
}
