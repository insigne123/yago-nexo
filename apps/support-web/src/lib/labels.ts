import type {
  Channel,
  ClockStatus,
  Environment,
  EventType,
  IntakeStatus,
  MemberRole,
  Metric,
  PatchStatus,
  PauseReason,
  RemoteAccessStatus,
  Severity,
  TicketStatus,
} from "./types";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  nuevo: "Nuevo",
  acusado: "Acusado",
  en_diagnostico: "En diagnóstico",
  solucion_temporal: "Solución temporal",
  resuelto: "Resuelto",
  cerrado: "Cerrado",
};

export const STATUS_ORDER: TicketStatus[] = [
  "nuevo",
  "acusado",
  "en_diagnostico",
  "solucion_temporal",
  "resuelto",
  "cerrado",
];

/** Transiciones que acepta la base de datos (sd_tickets_before_update). */
export function allowedTransitions(from: TicketStatus): TicketStatus[] {
  switch (from) {
    case "nuevo":
      return ["acusado", "en_diagnostico", "solucion_temporal", "resuelto"];
    case "acusado":
      return ["en_diagnostico", "solucion_temporal", "resuelto"];
    case "en_diagnostico":
      return ["solucion_temporal", "resuelto"];
    case "solucion_temporal":
      return ["en_diagnostico", "resuelto"];
    case "resuelto":
      return ["en_diagnostico", "cerrado"];
    case "cerrado":
      return [];
  }
}

export const INTAKE_LABEL: Record<IntakeStatus, string> = {
  aceptado: "Aceptado",
  cuarentena: "En cuarentena",
  descartado: "Descartado",
};

export const METRIC_LABEL: Record<Metric, string> = {
  acuse: "Acuse",
  diagnostico: "Diagnóstico",
  solucion: "Solución",
};

export const CLOCK_STATUS_LABEL: Record<ClockStatus, string> = {
  en_curso: "En curso",
  pausado: "En pausa",
  cumplido: "Cumplido",
  incumplido: "Incumplido",
  no_aplica: "Sin plazo",
};

export const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  infraestructura_cliente: "Infraestructura del cliente",
  red: "Red",
  terceros: "Terceros",
  decision_cliente: "Decisión del cliente",
  acceso_remoto_pendiente: "Acceso remoto pendiente",
};

/** Motivos que un agente puede elegir (el de acceso remoto lo abre la solicitud de acceso). */
export const MANUAL_PAUSE_REASONS: PauseReason[] = [
  "infraestructura_cliente",
  "red",
  "terceros",
  "decision_cliente",
];

export const ROLE_LABEL: Record<MemberRole, string> = {
  reportante: "Reportante",
  contraparte: "Contraparte técnica",
  agente: "Agente de Yago",
  supervisor: "Supervisor de Yago",
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  web: "Web",
  email: "Correo",
  whatsapp: "WhatsApp",
  telefono: "Teléfono",
};

export const ENVIRONMENT_LABEL: Record<Environment, string> = {
  prod: "Producción",
  qa: "QA",
  dev: "Desarrollo",
};

export const EVENT_LABEL: Record<EventType, string> = {
  comment: "Comentario",
  status_change: "Cambio de estado",
  pause: "Pausa",
  resume: "Reanudación",
  escalation: "Escalamiento",
  notification: "Aviso",
  attachment: "Adjunto",
  assignment: "Asignación",
  reclassification: "Reclasificación",
  remote_access: "Acceso remoto",
  security: "Seguridad",
};

export const REMOTE_STATUS_LABEL: Record<RemoteAccessStatus, string> = {
  pendiente: "Pendiente del cliente",
  habilitado: "Habilitado",
  rechazado: "Rechazado",
  revocado: "Revocado",
};

export const PATCH_STATUS_LABEL: Record<PatchStatus, string> = {
  borrador: "Borrador",
  pendiente_aprobacion: "Pendiente de aprobación",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  aplicado: "Aplicado",
  revertido: "Revertido",
};

export const SEVERITY_NAME: Record<Severity, string> = {
  S1: "Crítica",
  S2: "Alta",
  S3: "Media",
  S4: "Baja",
};

/** Plazos comprometidos (misma tabla que nexo_sd_sla_policies y la oferta). */
export const SLA_POLICY_TEXT: Record<
  Severity,
  { acuse: string; diagnostico: string; solucion: string; cobertura: string }
> = {
  S1: { acuse: "1 hora", diagnostico: "2 horas", solucion: "4 horas corridas", cobertura: "24x7x365" },
  S2: { acuse: "4 horas", diagnostico: "8 horas", solucion: "24 horas corridas", cobertura: "24x7x365" },
  S3: {
    acuse: "8 horas hábiles",
    diagnostico: "3 días hábiles",
    solucion: "10 días hábiles",
    cobertura: "Recepción 24x7; plazos en días hábiles",
  },
  S4: {
    acuse: "1 día hábil",
    diagnostico: "Sin plazo",
    solucion: "Según lo acordado",
    cobertura: "Recepción 24x7; plazos en días hábiles",
  },
};

export const CATEGORY_OPTIONS = [
  "Plataforma",
  "Integración",
  "Portal",
  "Seguridad",
  "Consola",
  "Consulta",
  "Otro",
] as const;
