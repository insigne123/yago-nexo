// Retención de respaldos (BT-058, BT-059): se conservan los N más recientes y, si se fija un
// máximo de días, ningún respaldo vive más que eso. Los respaldos contienen datos personales: el
// máximo de días acota cuánto tiempo sobrevive en ellos un dato que ya se eliminó en producción.
// El respaldo más reciente nunca se borra, aunque supere el máximo (se avisa).

export interface PoliticaRetencion {
  /** Cantidad de respaldos completos que se conservan (1 o más). */
  conservar: number;
  /** Antigüedad máxima en días; null o ausente = sin máximo. */
  maximoDias?: number | null;
}

export interface RespaldoListado {
  id: string;
  fecha: Date;
}

export interface DecisionRetencion {
  conservar: string[];
  borrar: { id: string; motivo: string }[];
  avisos: string[];
}

const DIA_MS = 24 * 60 * 60 * 1000;

export function decidirRetencion(
  respaldos: readonly RespaldoListado[],
  politica: PoliticaRetencion,
  ahora: Date,
): DecisionRetencion {
  if (!Number.isInteger(politica.conservar) || politica.conservar < 1) {
    throw new Error(
      `retención inválida: conservar debe ser un entero mayor o igual a 1 (es ${politica.conservar})`,
    );
  }
  const maximo = politica.maximoDias ?? null;
  if (maximo !== null && (!(maximo > 0) || !Number.isFinite(maximo))) {
    throw new Error(`retención inválida: maximoDias debe ser mayor que 0 (es ${maximo})`);
  }
  const ordenados = [...respaldos].sort(
    (a, b) => b.fecha.getTime() - a.fecha.getTime() || (a.id < b.id ? 1 : -1),
  );
  const decision: DecisionRetencion = { conservar: [], borrar: [], avisos: [] };
  ordenados.forEach((r, i) => {
    const dias = (ahora.getTime() - r.fecha.getTime()) / DIA_MS;
    const vencido = maximo !== null && dias > maximo;
    if (i === 0) {
      decision.conservar.push(r.id);
      if (vencido) {
        decision.avisos.push(
          `el respaldo más reciente (${r.id}) tiene ${Math.floor(dias)} días, más que el máximo de ${maximo}: se conserva, pero no hay respaldos nuevos`,
        );
      }
    } else if (i >= politica.conservar) {
      decision.borrar.push({ id: r.id, motivo: `fuera de los ${politica.conservar} más recientes` });
    } else if (vencido) {
      decision.borrar.push({ id: r.id, motivo: `supera el máximo de ${maximo} días` });
    } else {
      decision.conservar.push(r.id);
    }
  });
  return decision;
}
