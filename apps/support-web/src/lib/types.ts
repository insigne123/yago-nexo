// Tipos de las filas de la base de datos de la mesa (supabase/support/migrations).
import type { SeverityAnswers } from "@nexo/shared/browser";

export type Severity = "S1" | "S2" | "S3" | "S4";
export type TicketStatus =
  "nuevo" | "acusado" | "en_diagnostico" | "solucion_temporal" | "resuelto" | "cerrado";
export type IntakeStatus = "aceptado" | "cuarentena" | "descartado";
export type Environment = "prod" | "qa" | "dev";
export type Channel = "web" | "email" | "whatsapp" | "telefono";
export type Metric = "acuse" | "diagnostico" | "solucion";
export type Calendar = "24x7" | "habil";
export type ClockStatus = "en_curso" | "pausado" | "cumplido" | "incumplido" | "no_aplica";
export type PauseReason =
  "infraestructura_cliente" | "red" | "terceros" | "decision_cliente" | "acceso_remoto_pendiente";
export type MemberRole = "reportante" | "contraparte" | "agente" | "supervisor";
export type Visibility = "publico" | "interno";
export type EventType =
  | "comment"
  | "status_change"
  | "pause"
  | "resume"
  | "escalation"
  | "notification"
  | "attachment"
  | "assignment"
  | "reclassification"
  | "remote_access"
  | "security";
export type RemoteAccessStatus = "pendiente" | "habilitado" | "rechazado" | "revocado";
export type PatchStatus =
  "borrador" | "pendiente_aprobacion" | "aprobado" | "rechazado" | "aplicado" | "revertido";

export interface SlaClockRow {
  id: string;
  ticket_id: string;
  metric: Metric;
  calendar: Calendar;
  target_minutes: number | null;
  started_at: string;
  due_at: string | null;
  met_at: string | null;
  breached_at: string | null;
  paused_seconds: number;
  paused_since: string | null;
  remaining_seconds_at_pause: number | null;
  status: ClockStatus;
  notified_50_at: string | null;
  notified_80_at: string | null;
  notified_100_at: string | null;
}

export interface TicketRow {
  id: string;
  number: string;
  org_id: string | null;
  title: string;
  description: string;
  severity: Severity;
  classification_answers: SeverityAnswers | null;
  classification_rule: string;
  classification_source: "asistente" | "provisional" | "reclasificacion";
  category: string | null;
  component: string | null;
  environment: Environment;
  status: TicketStatus;
  intake_status: IntakeStatus;
  channel: Channel;
  channel_sender: string | null;
  reporter_id: string | null;
  assignee_id: string | null;
  created_by: string | null;
  is_security_incident: boolean;
  escalation_level: number;
  sla_started_at: string | null;
  acknowledged_at: string | null;
  diagnosed_at: string | null;
  workaround_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketWithClocks extends TicketRow {
  clocks: SlaClockRow[];
  org: { id: string; name: string } | null;
}

export interface PauseRow {
  id: string;
  ticket_id: string;
  reason: PauseReason;
  justification: string;
  started_at: string;
  ended_at: string | null;
  created_by: string | null;
  ended_by: string | null;
  remote_access_request_id: string | null;
  client_ack_status: "aceptada" | "objetada" | null;
  client_ack_by: string | null;
  client_ack_at: string | null;
  client_ack_note: string | null;
}

export interface RemoteAccessRow {
  id: string;
  ticket_id: string;
  scope: string;
  justification: string;
  status: RemoteAccessStatus;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  enabled_at: string | null;
  revoked_at: string | null;
  session_log_ref: string | null;
}

export interface TicketDetail extends TicketWithClocks {
  pauses: PauseRow[];
  remote: RemoteAccessRow[];
}

export interface TicketEventRow {
  id: string;
  ticket_id: string;
  type: EventType;
  visibility: Visibility;
  body: string | null;
  payload: Record<string, unknown>;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  seq: number;
}

export interface OncallShiftRow {
  id: string;
  user_id: string;
  level: 1 | 2 | 3;
  starts_at: string;
  ends_at: string;
  notes: string | null;
}

export interface NotificationRow {
  id: string;
  channel: "email" | "whatsapp" | "push" | "voz";
  recipient_user_id: string | null;
  ticket_id: string | null;
  template: string;
  payload: Record<string, unknown>;
  status: "pendiente" | "enviada" | "fallida";
  created_at: string;
  read_at: string | null;
}

export interface SecurityIncidentRow {
  id: string;
  ticket_id: string | null;
  org_id: string | null;
  title: string;
  description: string | null;
  detected_at: string;
  classification: "por_clasificar" | "significativo" | "no_significativo";
  affected_services: string[];
  early_alert_hours: number;
  second_report_hours: number;
  final_report_days: number;
  early_alert_due_at: string;
  early_alert_sent_at: string | null;
  second_report_due_at: string;
  second_report_at: string | null;
  final_report_due_at: string;
  final_report_at: string | null;
  csirt_reference: string | null;
  status: "abierto" | "cerrado";
  notes: string | null;
  created_at: string;
}

export interface RcaReportRow {
  id: string;
  ticket_id: string;
  org_id: string;
  title: string;
  summary: string;
  timeline: string | null;
  root_cause: string;
  corrective_actions: string | null;
  preventive_actions: string | null;
  status: "borrador" | "publicado";
  document_path: string | null;
  published_at: string | null;
  created_at: string;
}

export interface PatchPackageRow {
  id: string;
  org_id: string;
  version: string;
  title: string;
  description: string;
  rollback_plan: string;
  ticket_id: string | null;
  artifact_path: string | null;
  checksum_sha256: string | null;
  status: PatchStatus;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  created_at: string;
}

export interface MonthlyReportRow {
  id: string;
  org_id: string;
  period: string;
  summary: { resumen?: SlaSummaryRow[]; tickets?: { total: number } } & Record<string, unknown>;
  pdf_path: string | null;
  generated_at: string;
  generated_by: string | null;
}

export interface SlaSummaryRow {
  severity: Severity;
  metric: Metric;
  calendar: Calendar;
  target_minutes: number | null;
  total: number;
  met_on_time: number;
  breached: number;
  pending: number;
  compliance_pct: number | null;
  avg_effective_minutes: number | null;
  max_effective_minutes: number | null;
}

export interface DirectoryEntry {
  user_id: string;
  display_name: string;
  org_id: string;
  org_name: string;
  role: MemberRole;
  email: string | null;
  phone_e164: string | null;
  is_staff: boolean;
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  is_provider: boolean;
  active: boolean;
}

/** Respuesta de public.nexo_sd_my_context(). */
export interface SessionContextRaw {
  user_id: string | null;
  email: string | null;
  aal: string;
  mfa_ok: boolean;
  is_staff: boolean;
  is_supervisor: boolean;
  memberships: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    is_provider: boolean;
    role: MemberRole;
    display_name: string;
  }>;
}
