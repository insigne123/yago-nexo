-- =============================================================================
-- Mesa de soporte Nexo · 06 · Seguridad por filas (RLS) y permisos
--
-- Resumen de reglas:
--   * anon: sin privilegios en ninguna tabla ni función de la mesa.
--   * Miembros (con MFA aal2): ven los tickets de su organización y sus eventos públicos.
--   * Agentes y supervisores (organización proveedora, Yago): ven todo y operan los tickets.
--   * Reportante y contraparte crean tickets, comentarios y adjuntos en su organización.
--   * Solo agentes cambian estado, asignan, pausan y reanudan; la contraparte acusa pausas,
--     habilita accesos remotos y aprueba paquetes de corrección (funciones RPC).
--   * Las funciones auxiliares se envuelven en (select ...) para evaluarse una vez por consulta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Funciones: nadie las ejecuta salvo lo otorgado explícitamente abajo.
-- (Solo afecta funciones del esquema propio nexo_private.)
-- -----------------------------------------------------------------------------
revoke all on all functions in schema nexo_private from public;
revoke all on all functions in schema nexo_private from anon;
revoke all on all functions in schema nexo_private from authenticated;

-- Auxiliares que evalúan las políticas y los triggers BEFORE (SECURITY INVOKER) con el rol
-- de quien llama.
grant execute on function
  nexo_private.sd_is_privileged(),
  nexo_private.sd_mfa_ok(),
  nexo_private.sd_user_org_ids(),
  nexo_private.sd_is_member(),
  nexo_private.sd_user_is_staff(uuid),
  nexo_private.sd_is_staff(),
  nexo_private.sd_is_supervisor(),
  nexo_private.sd_has_org_role(uuid, text[]),
  nexo_private.sd_user_has_org_role(uuid, uuid, text[]),
  nexo_private.sd_can_see_ticket(uuid),
  nexo_private.sd_display_name(uuid),
  nexo_private.sd_classify(boolean, boolean, boolean, boolean, boolean),
  nexo_private.sd_classify_answers(jsonb),
  nexo_private.sd_next_ticket_number(timestamptz),
  nexo_private.sd_settings(),
  nexo_private.sd_status_rank(text),
  nexo_private.sd_policy_target(public.nexo_sd_sla_policies, text),
  nexo_private.sd_calendar_seconds(text, timestamptz, timestamptz)
to authenticated, service_role;

-- Funciones públicas: se revoca lo que PostgreSQL y Supabase otorgan por omisión.
revoke all on function
  public.nexo_sd_my_context(),
  public.nexo_sd_directory(),
  public.nexo_sd_pause_ticket(uuid, text, text),
  public.nexo_sd_resume_ticket(uuid, text),
  public.nexo_sd_acknowledge_pause(uuid, boolean, text),
  public.nexo_sd_request_remote_access(uuid, text, text),
  public.nexo_sd_decide_remote_access(uuid, boolean, text),
  public.nexo_sd_revoke_remote_access(uuid, text),
  public.nexo_sd_escalate_ticket(uuid, int, text),
  public.nexo_sd_reclassify_ticket(uuid, jsonb, text),
  public.nexo_sd_accept_quarantined_ticket(uuid, uuid, uuid, jsonb),
  public.nexo_sd_discard_quarantined_ticket(uuid, text),
  public.nexo_sd_decide_patch(uuid, boolean, text),
  public.nexo_sd_mark_notifications_read(uuid[]),
  public.nexo_sd_sla_summary(text, uuid),
  public.nexo_sd_claim_notifications(int, int),
  public.nexo_sd_complete_notification(uuid, boolean, jsonb, text, boolean),
  public.nexo_sd_inbound_message(text, text, text, text, text, text, timestamptz),
  public.nexo_sd_monthly_report_data(text, uuid),
  public.nexo_sd_record_monthly_report(uuid, text, jsonb, text, uuid)
from public, anon, authenticated;

-- Las que usa la aplicación (cada una valida el rol internamente).
grant execute on function
  public.nexo_sd_my_context(),
  public.nexo_sd_directory(),
  public.nexo_sd_pause_ticket(uuid, text, text),
  public.nexo_sd_resume_ticket(uuid, text),
  public.nexo_sd_acknowledge_pause(uuid, boolean, text),
  public.nexo_sd_request_remote_access(uuid, text, text),
  public.nexo_sd_decide_remote_access(uuid, boolean, text),
  public.nexo_sd_revoke_remote_access(uuid, text),
  public.nexo_sd_escalate_ticket(uuid, int, text),
  public.nexo_sd_reclassify_ticket(uuid, jsonb, text),
  public.nexo_sd_accept_quarantined_ticket(uuid, uuid, uuid, jsonb),
  public.nexo_sd_discard_quarantined_ticket(uuid, text),
  public.nexo_sd_decide_patch(uuid, boolean, text),
  public.nexo_sd_mark_notifications_read(uuid[]),
  public.nexo_sd_sla_summary(text, uuid)
to authenticated;

-- Todas para el backend; las de bandeja de salida, canal entrante e informes solo para él.
grant execute on function
  public.nexo_sd_my_context(),
  public.nexo_sd_directory(),
  public.nexo_sd_sla_summary(text, uuid),
  public.nexo_sd_claim_notifications(int, int),
  public.nexo_sd_complete_notification(uuid, boolean, jsonb, text, boolean),
  public.nexo_sd_inbound_message(text, text, text, text, text, text, timestamptz),
  public.nexo_sd_monthly_report_data(text, uuid),
  public.nexo_sd_record_monthly_report(uuid, text, jsonb, text, uuid)
to service_role;

-- -----------------------------------------------------------------------------
-- Privilegios de tabla para authenticated (la RLS decide las filas). Las columnas que
-- se pueden escribir se limitan donde importa (defensa en profundidad junto a los triggers).
-- -----------------------------------------------------------------------------
grant select on table
  public.nexo_sd_organizations, public.nexo_sd_members, public.nexo_sd_settings, public.nexo_sd_holidays,
  public.nexo_sd_sla_policies, public.nexo_sd_tickets, public.nexo_sd_ticket_events, public.nexo_sd_sla_clocks,
  public.nexo_sd_clock_pauses, public.nexo_sd_remote_access_requests, public.nexo_sd_oncall_shifts,
  public.nexo_sd_notifications, public.nexo_sd_security_incidents, public.nexo_sd_rca_reports,
  public.nexo_sd_patch_packages, public.nexo_sd_monthly_reports
to authenticated;

grant insert, update, delete on table
  public.nexo_sd_organizations, public.nexo_sd_members, public.nexo_sd_holidays, public.nexo_sd_oncall_shifts
to authenticated;

grant update on table public.nexo_sd_settings, public.nexo_sd_sla_policies to authenticated;

grant insert (org_id, title, description, classification_answers, category, component, environment,
              is_security_incident, reporter_id, assignee_id, channel)
  on table public.nexo_sd_tickets to authenticated;
grant update (status, assignee_id, title, description, category, component, environment, is_security_incident)
  on table public.nexo_sd_tickets to authenticated;

grant insert (ticket_id, type, visibility, body, payload) on table public.nexo_sd_ticket_events to authenticated;

grant insert, update on table public.nexo_sd_security_incidents, public.nexo_sd_rca_reports to authenticated;

grant insert (org_id, version, title, description, rollback_plan, ticket_id, artifact_path, checksum_sha256, status)
  on table public.nexo_sd_patch_packages to authenticated;
grant update (org_id, version, title, description, rollback_plan, ticket_id, artifact_path, checksum_sha256, status)
  on table public.nexo_sd_patch_packages to authenticated;

-- -----------------------------------------------------------------------------
-- Políticas. Se recrean para que la migración pueda reaplicarse sin error.
-- -----------------------------------------------------------------------------

-- Organizaciones
drop policy if exists nexo_sd_organizations_select on public.nexo_sd_organizations;
create policy nexo_sd_organizations_select on public.nexo_sd_organizations
  for select to authenticated
  using ((select nexo_private.sd_is_staff()) or id in (select nexo_private.sd_user_org_ids()));
drop policy if exists nexo_sd_organizations_insert on public.nexo_sd_organizations;
create policy nexo_sd_organizations_insert on public.nexo_sd_organizations
  for insert to authenticated with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_organizations_update on public.nexo_sd_organizations;
create policy nexo_sd_organizations_update on public.nexo_sd_organizations
  for update to authenticated
  using ((select nexo_private.sd_is_supervisor())) with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_organizations_delete on public.nexo_sd_organizations;
create policy nexo_sd_organizations_delete on public.nexo_sd_organizations
  for delete to authenticated using ((select nexo_private.sd_is_supervisor()));

-- Miembros: cada uno ve sus propias filas; el personal de Yago ve todas; supervisores administran.
drop policy if exists nexo_sd_members_select on public.nexo_sd_members;
create policy nexo_sd_members_select on public.nexo_sd_members
  for select to authenticated
  using ((select nexo_private.sd_is_staff())
         or (user_id = (select auth.uid()) and (select nexo_private.sd_mfa_ok())));
drop policy if exists nexo_sd_members_insert on public.nexo_sd_members;
create policy nexo_sd_members_insert on public.nexo_sd_members
  for insert to authenticated with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_members_update on public.nexo_sd_members;
create policy nexo_sd_members_update on public.nexo_sd_members
  for update to authenticated
  using ((select nexo_private.sd_is_supervisor())) with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_members_delete on public.nexo_sd_members;
create policy nexo_sd_members_delete on public.nexo_sd_members
  for delete to authenticated using ((select nexo_private.sd_is_supervisor()));

-- Configuración, feriados y políticas SLA: lectura para miembros, escritura para supervisores.
drop policy if exists nexo_sd_settings_select on public.nexo_sd_settings;
create policy nexo_sd_settings_select on public.nexo_sd_settings
  for select to authenticated using ((select nexo_private.sd_is_member()));
drop policy if exists nexo_sd_settings_update on public.nexo_sd_settings;
create policy nexo_sd_settings_update on public.nexo_sd_settings
  for update to authenticated
  using ((select nexo_private.sd_is_supervisor())) with check ((select nexo_private.sd_is_supervisor()));

drop policy if exists nexo_sd_holidays_select on public.nexo_sd_holidays;
create policy nexo_sd_holidays_select on public.nexo_sd_holidays
  for select to authenticated using ((select nexo_private.sd_is_member()));
drop policy if exists nexo_sd_holidays_insert on public.nexo_sd_holidays;
create policy nexo_sd_holidays_insert on public.nexo_sd_holidays
  for insert to authenticated with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_holidays_update on public.nexo_sd_holidays;
create policy nexo_sd_holidays_update on public.nexo_sd_holidays
  for update to authenticated
  using ((select nexo_private.sd_is_supervisor())) with check ((select nexo_private.sd_is_supervisor()));
drop policy if exists nexo_sd_holidays_delete on public.nexo_sd_holidays;
create policy nexo_sd_holidays_delete on public.nexo_sd_holidays
  for delete to authenticated using ((select nexo_private.sd_is_supervisor()));

drop policy if exists nexo_sd_sla_policies_select on public.nexo_sd_sla_policies;
create policy nexo_sd_sla_policies_select on public.nexo_sd_sla_policies
  for select to authenticated using ((select nexo_private.sd_is_member()));
drop policy if exists nexo_sd_sla_policies_update on public.nexo_sd_sla_policies;
create policy nexo_sd_sla_policies_update on public.nexo_sd_sla_policies
  for update to authenticated
  using ((select nexo_private.sd_is_supervisor())) with check ((select nexo_private.sd_is_supervisor()));

-- Tickets
drop policy if exists nexo_sd_tickets_select on public.nexo_sd_tickets;
create policy nexo_sd_tickets_select on public.nexo_sd_tickets
  for select to authenticated
  using ((select nexo_private.sd_is_staff())
         or (intake_status = 'aceptado' and org_id in (select nexo_private.sd_user_org_ids())));
drop policy if exists nexo_sd_tickets_insert on public.nexo_sd_tickets;
create policy nexo_sd_tickets_insert on public.nexo_sd_tickets
  for insert to authenticated
  with check ((select nexo_private.sd_is_staff())
              or nexo_private.sd_has_org_role(org_id, array['reportante', 'contraparte']));
drop policy if exists nexo_sd_tickets_update on public.nexo_sd_tickets;
create policy nexo_sd_tickets_update on public.nexo_sd_tickets
  for update to authenticated
  using ((select nexo_private.sd_is_staff())) with check ((select nexo_private.sd_is_staff()));
-- Sin política de DELETE: los tickets no se borran desde la API.

-- Línea de tiempo: los eventos internos solo los ven agentes y supervisores.
drop policy if exists nexo_sd_ticket_events_select on public.nexo_sd_ticket_events;
create policy nexo_sd_ticket_events_select on public.nexo_sd_ticket_events
  for select to authenticated
  using ((visibility = 'publico' or (select nexo_private.sd_is_staff()))
         and exists (select 1 from public.nexo_sd_tickets t where t.id = ticket_id));
drop policy if exists nexo_sd_ticket_events_insert on public.nexo_sd_ticket_events;
create policy nexo_sd_ticket_events_insert on public.nexo_sd_ticket_events
  for insert to authenticated
  with check (type in ('comment', 'attachment')
              and author_id = (select auth.uid())
              and (visibility = 'publico' or (select nexo_private.sd_is_staff()))
              and exists (select 1 from public.nexo_sd_tickets t where t.id = ticket_id));

-- Relojes, pausas y accesos remotos: visibles si el ticket es visible; se escriben solo con RPC.
drop policy if exists nexo_sd_sla_clocks_select on public.nexo_sd_sla_clocks;
create policy nexo_sd_sla_clocks_select on public.nexo_sd_sla_clocks
  for select to authenticated
  using (exists (select 1 from public.nexo_sd_tickets t where t.id = ticket_id));
drop policy if exists nexo_sd_clock_pauses_select on public.nexo_sd_clock_pauses;
create policy nexo_sd_clock_pauses_select on public.nexo_sd_clock_pauses
  for select to authenticated
  using (exists (select 1 from public.nexo_sd_tickets t where t.id = ticket_id));
drop policy if exists nexo_sd_remote_access_select on public.nexo_sd_remote_access_requests;
create policy nexo_sd_remote_access_select on public.nexo_sd_remote_access_requests
  for select to authenticated
  using (exists (select 1 from public.nexo_sd_tickets t where t.id = ticket_id));

-- Turnos: solo el personal de Yago.
drop policy if exists nexo_sd_oncall_shifts_select on public.nexo_sd_oncall_shifts;
create policy nexo_sd_oncall_shifts_select on public.nexo_sd_oncall_shifts
  for select to authenticated using ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_oncall_shifts_insert on public.nexo_sd_oncall_shifts;
create policy nexo_sd_oncall_shifts_insert on public.nexo_sd_oncall_shifts
  for insert to authenticated with check ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_oncall_shifts_update on public.nexo_sd_oncall_shifts;
create policy nexo_sd_oncall_shifts_update on public.nexo_sd_oncall_shifts
  for update to authenticated
  using ((select nexo_private.sd_is_staff())) with check ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_oncall_shifts_delete on public.nexo_sd_oncall_shifts;
create policy nexo_sd_oncall_shifts_delete on public.nexo_sd_oncall_shifts
  for delete to authenticated using ((select nexo_private.sd_is_staff()));

-- Notificaciones: el personal ve la bandeja; cada usuario ve las propias (avisos en la app).
drop policy if exists nexo_sd_notifications_select on public.nexo_sd_notifications;
create policy nexo_sd_notifications_select on public.nexo_sd_notifications
  for select to authenticated
  using ((select nexo_private.sd_is_staff())
         or (recipient_user_id = (select auth.uid()) and (select nexo_private.sd_mfa_ok())));

-- Incidentes de seguridad: personal de Yago y contraparte de la organización.
drop policy if exists nexo_sd_security_incidents_select on public.nexo_sd_security_incidents;
create policy nexo_sd_security_incidents_select on public.nexo_sd_security_incidents
  for select to authenticated
  using ((select nexo_private.sd_is_staff()) or nexo_private.sd_has_org_role(org_id, array['contraparte']));
drop policy if exists nexo_sd_security_incidents_insert on public.nexo_sd_security_incidents;
create policy nexo_sd_security_incidents_insert on public.nexo_sd_security_incidents
  for insert to authenticated with check ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_security_incidents_update on public.nexo_sd_security_incidents;
create policy nexo_sd_security_incidents_update on public.nexo_sd_security_incidents
  for update to authenticated
  using ((select nexo_private.sd_is_staff())) with check ((select nexo_private.sd_is_staff()));

-- RCA: la organización ve los publicados.
drop policy if exists nexo_sd_rca_reports_select on public.nexo_sd_rca_reports;
create policy nexo_sd_rca_reports_select on public.nexo_sd_rca_reports
  for select to authenticated
  using ((select nexo_private.sd_is_staff())
         or (status = 'publicado' and org_id in (select nexo_private.sd_user_org_ids())));
drop policy if exists nexo_sd_rca_reports_insert on public.nexo_sd_rca_reports;
create policy nexo_sd_rca_reports_insert on public.nexo_sd_rca_reports
  for insert to authenticated with check ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_rca_reports_update on public.nexo_sd_rca_reports;
create policy nexo_sd_rca_reports_update on public.nexo_sd_rca_reports
  for update to authenticated
  using ((select nexo_private.sd_is_staff())) with check ((select nexo_private.sd_is_staff()));

-- Paquetes de corrección: la organización ve los que ya salieron de borrador.
drop policy if exists nexo_sd_patch_packages_select on public.nexo_sd_patch_packages;
create policy nexo_sd_patch_packages_select on public.nexo_sd_patch_packages
  for select to authenticated
  using ((select nexo_private.sd_is_staff())
         or (status <> 'borrador' and org_id in (select nexo_private.sd_user_org_ids())));
drop policy if exists nexo_sd_patch_packages_insert on public.nexo_sd_patch_packages;
create policy nexo_sd_patch_packages_insert on public.nexo_sd_patch_packages
  for insert to authenticated with check ((select nexo_private.sd_is_staff()));
drop policy if exists nexo_sd_patch_packages_update on public.nexo_sd_patch_packages;
create policy nexo_sd_patch_packages_update on public.nexo_sd_patch_packages
  for update to authenticated
  using ((select nexo_private.sd_is_staff())) with check ((select nexo_private.sd_is_staff()));

-- Informes mensuales: los genera el backend; los ve la organización y el personal.
drop policy if exists nexo_sd_monthly_reports_select on public.nexo_sd_monthly_reports;
create policy nexo_sd_monthly_reports_select on public.nexo_sd_monthly_reports
  for select to authenticated
  using ((select nexo_private.sd_is_staff()) or org_id in (select nexo_private.sd_user_org_ids()));
