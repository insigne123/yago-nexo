// Asistente de severidad (BT-061): preguntas cerradas y clasificación determinista con la
// misma función que usa la base de datos (classifySeverity de @nexo/shared).
import {
  classifySeverity,
  SEVERITY_EXAMPLES,
  type Severity,
  type SeverityAnswers,
  type SeverityResult,
} from "@nexo/shared/browser";

export type AnswerKey = keyof SeverityAnswers;
export type PartialAnswers = Partial<Record<AnswerKey, boolean>>;

export interface WizardQuestion {
  key: AnswerKey;
  question: string;
  help: string;
  /** Ejemplos de la matriz de severidades que ayudan a responder. */
  examples: { severity: Severity; items: string[] };
}

export const QUESTIONS: WizardQuestion[] = [
  {
    key: "esConsultaOCambio",
    question: "¿Es una consulta, solicitud de cambio o de información, sin falla?",
    help: "Responda Sí si nada está fallando: necesita información, una configuración nueva o un cambio planificado.",
    examples: { severity: "S4", items: SEVERITY_EXAMPLES.S4 },
  },
  {
    key: "servicioProductivoCaido",
    question:
      "¿Hay APIs o integraciones productivas que no responden o responden con error a todos sus consumidores?",
    help: "Piense en producción: si ningún consumidor logra usar el servicio afectado, responda Sí.",
    examples: { severity: "S1", items: SEVERITY_EXAMPLES.S1 },
  },
  {
    key: "existeAlternativa",
    question:
      "¿Existe una alternativa operativa (otro nodo, otra ruta, procedimiento manual) que mantenga el servicio?",
    help: "Si el servicio sigue funcionando por otro camino, aunque sea más lento o manual, responda Sí.",
    examples: { severity: "S2", items: SEVERITY_EXAMPLES.S2.slice(0, 1) },
  },
  {
    key: "degradacionOSeguridad",
    question:
      "¿Hay degradación medible en producción (latencia o errores sobre el umbral comprometido) o riesgo de seguridad activo?",
    help: "Por ejemplo, errores intermitentes sobre el umbral, latencia fuera de lo comprometido o una vulnerabilidad explotable.",
    examples: { severity: "S2", items: SEVERITY_EXAMPLES.S2 },
  },
  {
    key: "soloNoProductivoOMenor",
    question: "¿La falla afecta solo a ambientes no productivos o a una funcionalidad no crítica?",
    help: "Por ejemplo, QA, desarrollo o la documentación del portal.",
    examples: { severity: "S3", items: SEVERITY_EXAMPLES.S3 },
  },
];

/**
 * Preguntas que aplican según lo ya respondido. La regla de classifySeverity es una cadena:
 * consulta -> caído (y alternativa) -> degradación -> no productivo. Las preguntas que ya no
 * pueden cambiar el resultado no se muestran y se registran como "No".
 */
export function visibleQuestions(answers: PartialAnswers): WizardQuestion[] {
  const byKey = (key: AnswerKey) => QUESTIONS.find((q) => q.key === key) as WizardQuestion;
  const visible: WizardQuestion[] = [byKey("esConsultaOCambio")];
  if (answers.esConsultaOCambio !== false) return visible;
  visible.push(byKey("servicioProductivoCaido"));
  if (answers.servicioProductivoCaido === undefined) return visible;
  if (answers.servicioProductivoCaido) {
    visible.push(byKey("existeAlternativa"));
    return visible;
  }
  visible.push(byKey("degradacionOSeguridad"));
  if (answers.degradacionOSeguridad !== false) return visible;
  visible.push(byKey("soloNoProductivoOMenor"));
  return visible;
}

export function isComplete(answers: PartialAnswers): boolean {
  return visibleQuestions(answers).every((q) => answers[q.key] !== undefined);
}

/** Completa con "No" las preguntas que no aplican (no cambian la clasificación). */
export function toAnswers(answers: PartialAnswers): SeverityAnswers {
  const visible = new Set(visibleQuestions(answers).map((q) => q.key));
  const value = (key: AnswerKey) => (visible.has(key) ? answers[key] === true : false);
  return {
    esConsultaOCambio: value("esConsultaOCambio"),
    servicioProductivoCaido: value("servicioProductivoCaido"),
    existeAlternativa: value("existeAlternativa"),
    degradacionOSeguridad: value("degradacionOSeguridad"),
    soloNoProductivoOMenor: value("soloNoProductivoOMenor"),
  };
}

export function classify(answers: PartialAnswers): SeverityResult | null {
  return isComplete(answers) ? classifySeverity(toAnswers(answers)) : null;
}

/** Al cambiar una respuesta se descartan las posteriores que dejaron de aplicar. */
export function answerQuestion(answers: PartialAnswers, key: AnswerKey, value: boolean): PartialAnswers {
  const next: PartialAnswers = { ...answers, [key]: value };
  const visible = new Set(visibleQuestions(next).map((q) => q.key));
  for (const q of QUESTIONS) {
    if (!visible.has(q.key)) delete next[q.key];
  }
  return next;
}
