// Acceso a datos: consultas y acciones sobre las tablas y RPC nexo_sd_*. La RLS de la base
// de datos decide qué filas ve cada persona.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeverityAnswers } from "@nexo/shared/browser";
import { BUCKET } from "./supabase";
import type {
  DirectoryEntry,
  Environment,
  MonthlyReportRow,
  NotificationRow,
  OncallShiftRow,
  OrganizationRow,
  PatchPackageRow,
  PatchStatus,
  PauseReason,
  RcaReportRow,
  SecurityIncidentRow,
  SessionContextRaw,
  TicketDetail,
  TicketEventRow,
  TicketStatus,
  TicketWithClocks,
  Visibility,
} from "./types";

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

const TICKET_LIST_SELECT = "*, clocks:nexo_sd_sla_clocks(*), org:nexo_sd_organizations(id, name)";
const TICKET_DETAIL_SELECT = `${TICKET_LIST_SELECT}, pauses:nexo_sd_clock_pauses(*), remote:nexo_sd_remote_access_requests(*)`;

export async function fetchMyContext(supabase: SupabaseClient): Promise<SessionContextRaw> {
  return unwrap(await supabase.rpc("nexo_sd_my_context"));
}

export async function fetchTickets(
  supabase: SupabaseClient,
  options: { includeClosed: boolean; limit?: number },
): Promise<TicketWithClocks[]> {
  let query = supabase
    .from("nexo_sd_tickets")
    .select(TICKET_LIST_SELECT)
    .order("created_at", { ascending: false });
  if (!options.includeClosed) query = query.neq("status", "cerrado");
  return unwrap(
    await query.neq("intake_status", "descartado").limit(options.limit ?? 300),
  ) as TicketWithClocks[];
}

export async function fetchTicket(supabase: SupabaseClient, id: string): Promise<TicketDetail> {
  return unwrap(
    await supabase.from("nexo_sd_tickets").select(TICKET_DETAIL_SELECT).eq("id", id).single(),
  ) as TicketDetail;
}

export async function fetchTicketEvents(
  supabase: SupabaseClient,
  ticketId: string,
): Promise<TicketEventRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_ticket_events")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })
      .order("seq", { ascending: true }),
  ) as TicketEventRow[];
}

export async function fetchDirectory(supabase: SupabaseClient): Promise<DirectoryEntry[]> {
  return unwrap(await supabase.rpc("nexo_sd_directory")) as DirectoryEntry[];
}

export async function fetchOrganizations(supabase: SupabaseClient): Promise<OrganizationRow[]> {
  return unwrap(await supabase.from("nexo_sd_organizations").select("*").order("name")) as OrganizationRow[];
}

export interface NewTicketInput {
  orgId: string;
  title: string;
  description: string;
  environment: Environment;
  category: string | null;
  component: string | null;
  isSecurityIncident: boolean;
  answers: SeverityAnswers;
  reporterId?: string | null;
}

export async function createTicket(
  supabase: SupabaseClient,
  input: NewTicketInput,
): Promise<{ id: string; number: string }> {
  const row: Record<string, unknown> = {
    org_id: input.orgId,
    title: input.title,
    description: input.description,
    environment: input.environment,
    category: input.category,
    component: input.component,
    is_security_incident: input.isSecurityIncident,
    classification_answers: input.answers,
  };
  if (input.reporterId) row["reporter_id"] = input.reporterId;
  return unwrap(await supabase.from("nexo_sd_tickets").insert(row).select("id, number").single()) as {
    id: string;
    number: string;
  };
}

export async function updateTicket(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<{ status: TicketStatus; assignee_id: string | null; is_security_incident: boolean }>,
): Promise<void> {
  unwrap(await supabase.from("nexo_sd_tickets").update(patch).eq("id", id).select("id").single());
}

export async function addComment(
  supabase: SupabaseClient,
  ticketId: string,
  body: string,
  visibility: Visibility,
): Promise<void> {
  unwrap(
    await supabase
      .from("nexo_sd_ticket_events")
      .insert({ ticket_id: ticketId, type: "comment", visibility, body }),
  );
}

/** Nombre de archivo seguro para la ruta del bucket. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "archivo").slice(0, 120);
}

export async function uploadAttachment(
  supabase: SupabaseClient,
  ticketId: string,
  file: File,
  visibility: Visibility,
): Promise<void> {
  const path = `tickets/${ticketId}/${visibility}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const upload = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upload.error) throw new Error(upload.error.message);
  unwrap(
    await supabase.from("nexo_sd_ticket_events").insert({
      ticket_id: ticketId,
      type: "attachment",
      visibility,
      body: file.name,
      payload: { path, name: file.name, size: file.size, type: file.type },
    }),
  );
}

export async function signedUrl(supabase: SupabaseClient, path: string, download?: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 120, download ? { download } : undefined);
  if (error || !data) throw new Error(error?.message ?? "No se pudo generar el enlace");
  return data.signedUrl;
}

async function rpc<T = unknown>(
  supabase: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  return unwrap(await supabase.rpc(fn, args)) as T;
}

export const actions = {
  pause: (s: SupabaseClient, ticketId: string, reason: PauseReason, justification: string) =>
    rpc<string>(s, "nexo_sd_pause_ticket", {
      p_ticket_id: ticketId,
      p_reason: reason,
      p_justification: justification,
    }),
  resume: (s: SupabaseClient, ticketId: string, note: string | null) =>
    rpc(s, "nexo_sd_resume_ticket", { p_ticket_id: ticketId, p_note: note }),
  acknowledgePause: (s: SupabaseClient, pauseId: string, accept: boolean, note: string | null) =>
    rpc(s, "nexo_sd_acknowledge_pause", { p_pause_id: pauseId, p_accept: accept, p_note: note }),
  requestRemoteAccess: (s: SupabaseClient, ticketId: string, scope: string, justification: string) =>
    rpc<string>(s, "nexo_sd_request_remote_access", {
      p_ticket_id: ticketId,
      p_scope: scope,
      p_justification: justification,
    }),
  decideRemoteAccess: (s: SupabaseClient, requestId: string, approve: boolean, note: string | null) =>
    rpc(s, "nexo_sd_decide_remote_access", { p_request_id: requestId, p_approve: approve, p_note: note }),
  revokeRemoteAccess: (s: SupabaseClient, requestId: string, sessionLogRef: string | null) =>
    rpc(s, "nexo_sd_revoke_remote_access", { p_request_id: requestId, p_session_log_ref: sessionLogRef }),
  escalate: (s: SupabaseClient, ticketId: string, level: number, reason: string) =>
    rpc<number>(s, "nexo_sd_escalate_ticket", { p_ticket_id: ticketId, p_level: level, p_reason: reason }),
  reclassify: (s: SupabaseClient, ticketId: string, answers: SeverityAnswers, justification: string) =>
    rpc<{ severity: string; rule: string }>(s, "nexo_sd_reclassify_ticket", {
      p_ticket_id: ticketId,
      p_answers: answers,
      p_justification: justification,
    }),
  acceptQuarantine: (
    s: SupabaseClient,
    ticketId: string,
    orgId: string,
    reporterId: string | null,
    answers: SeverityAnswers | null,
  ) =>
    rpc(s, "nexo_sd_accept_quarantined_ticket", {
      p_ticket_id: ticketId,
      p_org_id: orgId,
      p_reporter_id: reporterId,
      p_answers: answers,
    }),
  discardQuarantine: (s: SupabaseClient, ticketId: string, reason: string) =>
    rpc(s, "nexo_sd_discard_quarantined_ticket", { p_ticket_id: ticketId, p_reason: reason }),
  decidePatch: (s: SupabaseClient, patchId: string, approve: boolean, note: string | null) =>
    rpc(s, "nexo_sd_decide_patch", { p_patch_id: patchId, p_approve: approve, p_note: note }),
  markNotificationsRead: (s: SupabaseClient, ids: string[] | null) =>
    rpc<number>(s, "nexo_sd_mark_notifications_read", { p_ids: ids }),
};

export async function fetchMyNotifications(
  supabase: SupabaseClient,
  userId: string,
): Promise<NotificationRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_notifications")
      .select("id, channel, recipient_user_id, ticket_id, template, payload, status, created_at, read_at")
      .eq("recipient_user_id", userId)
      .eq("channel", "push")
      .order("created_at", { ascending: false })
      .limit(30),
  ) as NotificationRow[];
}

// Turnos ----------------------------------------------------------------------
export async function fetchShifts(supabase: SupabaseClient, from: Date, to: Date): Promise<OncallShiftRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_oncall_shifts")
      .select("*")
      .lt("starts_at", to.toISOString())
      .gt("ends_at", from.toISOString())
      .order("starts_at"),
  ) as OncallShiftRow[];
}

export interface ShiftInput {
  user_id: string;
  level: number;
  starts_at: string;
  ends_at: string;
  notes: string | null;
}

export async function saveShift(supabase: SupabaseClient, input: ShiftInput, id?: string): Promise<void> {
  if (id)
    unwrap(await supabase.from("nexo_sd_oncall_shifts").update(input).eq("id", id).select("id").single());
  else unwrap(await supabase.from("nexo_sd_oncall_shifts").insert(input));
}

export async function deleteShift(supabase: SupabaseClient, id: string): Promise<void> {
  unwrap(await supabase.from("nexo_sd_oncall_shifts").delete().eq("id", id));
}

export interface SettingsRow {
  timezone: string;
  business_start: string;
  business_end: string;
  security_early_alert_hours: number;
  security_second_report_hours: number;
  security_final_report_days: number;
  s1_ack_escalation_minutes: number;
}

export async function fetchSettings(supabase: SupabaseClient): Promise<SettingsRow> {
  return unwrap(
    await supabase
      .from("nexo_sd_settings")
      .select(
        "timezone, business_start, business_end, security_early_alert_hours, security_second_report_hours, security_final_report_days, s1_ack_escalation_minutes",
      )
      .single(),
  ) as SettingsRow;
}

// Incidentes de seguridad ----------------------------------------------------------
export async function fetchIncidents(supabase: SupabaseClient): Promise<SecurityIncidentRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_security_incidents")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(100),
  ) as SecurityIncidentRow[];
}

export async function createIncident(
  supabase: SupabaseClient,
  input: {
    title: string;
    description: string | null;
    detected_at: string;
    affected_services: string[];
    org_id: string | null;
    ticket_id: string | null;
  },
): Promise<void> {
  unwrap(await supabase.from("nexo_sd_security_incidents").insert(input));
}

export async function updateIncident(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<SecurityIncidentRow>,
): Promise<void> {
  unwrap(await supabase.from("nexo_sd_security_incidents").update(patch).eq("id", id).select("id").single());
}

// Paquetes de corrección y RCA -------------------------------------------------------
export async function fetchPatches(supabase: SupabaseClient): Promise<PatchPackageRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_patch_packages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
  ) as PatchPackageRow[];
}

export async function createPatch(
  supabase: SupabaseClient,
  input: Pick<
    PatchPackageRow,
    | "org_id"
    | "version"
    | "title"
    | "description"
    | "rollback_plan"
    | "artifact_path"
    | "checksum_sha256"
    | "ticket_id"
  > & {
    status: PatchStatus;
  },
): Promise<void> {
  unwrap(await supabase.from("nexo_sd_patch_packages").insert(input));
}

export async function setPatchStatus(
  supabase: SupabaseClient,
  id: string,
  status: PatchStatus,
): Promise<void> {
  unwrap(await supabase.from("nexo_sd_patch_packages").update({ status }).eq("id", id).select("id").single());
}

export async function fetchRcas(supabase: SupabaseClient): Promise<RcaReportRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_rca_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
  ) as RcaReportRow[];
}

// Informes mensuales ---------------------------------------------------------------
export async function fetchReports(supabase: SupabaseClient): Promise<MonthlyReportRow[]> {
  return unwrap(
    await supabase
      .from("nexo_sd_monthly_reports")
      .select("*")
      .order("period", { ascending: false })
      .limit(120),
  ) as MonthlyReportRow[];
}

export async function generateReport(
  supabase: SupabaseClient,
  period: string,
  orgId: string | null,
): Promise<{
  periodo: string;
  informes: Array<{ organizacion: string; pdf_path: string }>;
  errores: unknown[];
}> {
  const { data, error } = await supabase.functions.invoke("nexo-sd-monthly-report", {
    body: orgId ? { period, org_id: orgId } : { period },
  });
  if (error) throw new Error(error.message);
  return data as {
    periodo: string;
    informes: Array<{ organizacion: string; pdf_path: string }>;
    errores: unknown[];
  };
}
