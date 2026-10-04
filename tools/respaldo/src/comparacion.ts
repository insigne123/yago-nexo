// Comparación entre lo que dice el manifiesto (contado dentro del snapshot del respaldo) y lo que
// quedó en la base restaurada. Cualquier diferencia hace fallar la prueba de restauración.
import type { ConteoTabla, SondaAuditoria } from "./manifiesto.js";

export interface DiferenciaTabla {
  tabla: string;
  tipo: "falta" | "sobra" | "filas" | "contenido";
  detalle: string;
}

export interface ResultadoComparacion {
  ok: boolean;
  tablasComparadas: number;
  filasEsperadas: number;
  filasObtenidas: number;
  diferencias: DiferenciaTabla[];
}

const clave = (t: ConteoTabla) => `${t.esquema}.${t.tabla}`;

export function compararTablas(
  esperadas: readonly ConteoTabla[],
  obtenidas: readonly ConteoTabla[],
): ResultadoComparacion {
  const restauradas = new Map(obtenidas.map((t) => [clave(t), t]));
  const diferencias: DiferenciaTabla[] = [];
  let filasEsperadas = 0;
  let filasObtenidas = 0;
  let comparadas = 0;
  for (const e of esperadas) {
    filasEsperadas += e.filas;
    const o = restauradas.get(clave(e));
    restauradas.delete(clave(e));
    if (!o) {
      diferencias.push({
        tabla: clave(e),
        tipo: "falta",
        detalle: `no existe en la base restaurada (tenía ${e.filas} filas)`,
      });
      continue;
    }
    comparadas++;
    filasObtenidas += o.filas;
    if (o.filas !== e.filas) {
      diferencias.push({
        tabla: clave(e),
        tipo: "filas",
        detalle: `${e.filas} filas en el respaldo, ${o.filas} restauradas`,
      });
    } else if (e.huella !== undefined && o.huella !== e.huella) {
      diferencias.push({
        tabla: clave(e),
        tipo: "contenido",
        detalle: "mismas filas, pero la huella del contenido no coincide",
      });
    }
  }
  for (const o of restauradas.values()) {
    filasObtenidas += o.filas;
    diferencias.push({
      tabla: clave(o),
      tipo: "sobra",
      detalle: `no está en el manifiesto (${o.filas} filas)`,
    });
  }
  return {
    ok: diferencias.length === 0,
    tablasComparadas: comparadas,
    filasEsperadas,
    filasObtenidas,
    diferencias,
  };
}

/** Resultado de verificar la cadena completa (mismo formato que AuditStore.verify de @nexo/console-db). */
export type VerificacionCadena =
  | { ok: true; count: number; lastSeq: number; lastHash: string }
  | { ok: false; count: number; brokenAt: number; reason: string };

export interface ResultadoSondaAuditoria {
  ok: boolean;
  esperado: SondaAuditoria;
  obtenido: SondaAuditoria;
  cadena: VerificacionCadena | null;
  problemas: string[];
}

/**
 * La cadena de auditoría restaurada debe tener los mismos eventos, el mismo último seq y el mismo
 * último hash que en el snapshot, y además verificarse completa (cada hash recalculado).
 */
export function compararAuditoria(
  esperado: SondaAuditoria,
  obtenido: SondaAuditoria,
  cadena: VerificacionCadena | null,
): ResultadoSondaAuditoria {
  const problemas: string[] = [];
  if (obtenido.eventos !== esperado.eventos)
    problemas.push(`eventos: ${esperado.eventos} en el respaldo, ${obtenido.eventos} restaurados`);
  if (obtenido.ultimoSeq !== esperado.ultimoSeq)
    problemas.push(`último seq: ${esperado.ultimoSeq} en el respaldo, ${obtenido.ultimoSeq} restaurado`);
  if (obtenido.ultimoHash !== esperado.ultimoHash)
    problemas.push("el hash del último evento no coincide con el del respaldo");
  if (cadena) {
    if (!cadena.ok)
      problemas.push(
        `la cadena restaurada no se verifica: se rompe en el seq ${cadena.brokenAt} (${cadena.reason})`,
      );
    else {
      if (cadena.count !== esperado.eventos)
        problemas.push(
          `la verificación recorrió ${cadena.count} eventos y el respaldo tenía ${esperado.eventos}`,
        );
      if (esperado.ultimoHash !== null && cadena.lastHash !== esperado.ultimoHash)
        problemas.push("el ancla de la cadena verificada no coincide con el respaldo");
    }
  }
  return { ok: problemas.length === 0, esperado, obtenido, cadena, problemas };
}
