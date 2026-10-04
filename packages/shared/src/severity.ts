/**
 * Clasificación de severidad sin apreciación discrecional (BT-061).
 *
 * El asistente de la mesa de soporte hace estas preguntas cerradas y la severidad se
 * calcula de forma determinista. La misma tabla va en la oferta como "matriz de
 * severidades con ejemplos".
 */

export type Severity = "S1" | "S2" | "S3" | "S4";

export interface SeverityAnswers {
  /** ¿Es una consulta, solicitud de cambio o de información, sin falla? */
  esConsultaOCambio: boolean;
  /** ¿Hay APIs o integraciones productivas que no responden o responden con error a todos sus consumidores? */
  servicioProductivoCaido: boolean;
  /** ¿Existe una alternativa operativa (otro nodo, otra ruta, procedimiento manual) que mantenga el servicio? */
  existeAlternativa: boolean;
  /** ¿Hay degradación medible en producción (latencia o errores sobre el umbral comprometido) o riesgo de seguridad activo? */
  degradacionOSeguridad: boolean;
  /** ¿La falla afecta solo a ambientes no productivos o a una funcionalidad no crítica? */
  soloNoProductivoOMenor: boolean;
}

export interface SeverityResult {
  severity: Severity;
  rule: string;
}

export function classifySeverity(a: SeverityAnswers): SeverityResult {
  if (a.esConsultaOCambio) return { severity: "S4", rule: "Consulta o solicitud de cambio sin falla" };
  if (a.servicioProductivoCaido && !a.existeAlternativa)
    return { severity: "S1", rule: "Servicio productivo caído y sin alternativa operativa" };
  if (a.servicioProductivoCaido && a.existeAlternativa)
    return { severity: "S2", rule: "Servicio productivo caído con alternativa operativa" };
  if (a.degradacionOSeguridad)
    return { severity: "S2", rule: "Degradación medible en producción o riesgo de seguridad activo" };
  if (a.soloNoProductivoOMenor) return { severity: "S3", rule: "Falla en no productivo o funcionalidad no crítica" };
  return { severity: "S3", rule: "Falla sin impacto productivo declarado" };
}

/** Ejemplos de clasificación que acompañan la matriz en la oferta. */
export const SEVERITY_EXAMPLES: Record<Severity, string[]> = {
  S1: [
    "Todos los gateways de producción responden 5xx o no responden.",
    "El Key Manager no emite ni valida tokens y ninguna API protegida puede consumirse.",
    "La base de datos de la plataforma no está disponible y no hay conmutación posible.",
  ],
  S2: [
    "Un nodo de gateway cayó y el otro sostiene el servicio con latencia sobre lo comprometido.",
    "Una de las APIs migradas devuelve errores intermitentes sobre el umbral.",
    "Se detecta una vulnerabilidad explotable activamente en un componente expuesto.",
  ],
  S3: [
    "El portal de desarrolladores muestra mal la documentación de una API.",
    "Falla un pipeline de promoción en el ambiente de QA.",
  ],
  S4: ["Solicitud de nueva política de cuota.", "Consulta sobre cómo exportar un contrato OpenAPI."],
};

/** Tiempos comprometidos (minutos corridos) para cobertura 24x7. Fuente: tabla SLA de la oferta. */
export const SLA_TARGETS_MINUTES: Record<Severity, { acuse: number; diagnostico?: number; solucion?: number }> = {
  S1: { acuse: 60, diagnostico: 120, solucion: 240 },
  S2: { acuse: 240, diagnostico: 480, solucion: 1440 },
  S3: { acuse: 480 },
  S4: { acuse: 540 },
};
