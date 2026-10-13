/**
 * Retorno al sitio principal en dos pasos (check-d05): una persona lo solicita (continuity:failback:request) y otra
 * lo aprueba (continuity:failback:approve, cuatro ojos). Ver POST /continuity/failback/requests y
 * /continuity/failback/requests/{id}/approve en apps/console-api/openapi.yaml.
 */

export interface SolicitudRetorno {
  id?: string;
  status?: string;
  requestedBy?: string;
  decidedBy?: string;
}

export interface PasosRetorno {
  /** Código de POST /continuity/failback/requests. */
  solicitud: number;
  /** Código de POST /continuity/failback/requests/{id}/approve (undefined si no se llegó a aprobar). */
  aprobacion?: number;
  /** Solicitud que devolvió la aprobación (FailbackApproval.request). */
  aprobada?: SolicitudRetorno;
  /** Sitio activo después de esperar el retorno. */
  activo?: string;
  dns?: string;
}

export function evaluarRetorno(p: PasosRetorno): {
  prueba: string;
  esperado: string;
  obtenido: string;
  cumple: boolean;
} {
  const quien = p.aprobada?.requestedBy;
  const aprueba = p.aprobada?.decidedBy;
  const dosPersonas = !!quien && !!aprueba && quien !== aprueba;
  return {
    prueba: "retorno con dos personas (una solicita, otra aprueba)",
    esperado: "201 · 202 · personas distintas · activo vuelve a cpd · DNS 10.80.0.1",
    obtenido: `${p.solicitud} · ${p.aprobacion ?? "-"} · ${quien ?? "?"} → ${aprueba ?? "?"} · activo ${p.activo ?? "?"} · dns ${p.dns ?? "?"}`,
    cumple:
      p.solicitud === 201 &&
      p.aprobacion === 202 &&
      p.aprobada?.status === "aprobada" &&
      dosPersonas &&
      p.activo === "cpd" &&
      p.dns === "10.80.0.1",
  };
}
