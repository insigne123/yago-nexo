-- =============================================================================
-- Mesa de soporte Nexo · 05 · Operaciones (RPC)
--
-- Funciones públicas con prefijo nexo_sd_. Las que usa la aplicación validan el rol de
-- quien llama (agente, supervisor o contraparte); las del backend (funciones Edge) se
-- otorgan solo a service_role en la migración de permisos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Contexto de la sesión y directorio
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_my_context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'email', auth.jwt() ->> 'email',
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'mfa_ok', nexo_private.sd_mfa_ok(),
    'is_staff', nexo_private.sd_is_staff(),
    'is_supervisor', nexo_private.sd_is_supervisor(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'org_id', o.id, 'org_name', o.name, 'org_slug', o.slug, 'is_provider', o.is_provider,
               'role', m.role, 'display_name', m.display_name)
             order by o.is_provider desc, o.name)
      from public.nexo_sd_members m
      join public.nexo_sd_organizations o on o.id = m.org_id
      where m.user_id = auth.uid() and m.active and o.active
    ), '[]'::jsonb)
  )
$$;
comment on function public.nexo_sd_my_context() is
  'Mesa de soporte Nexo: pertenencias y permisos de quien llama (para mostrar u ocultar acciones).';

-- Personas visibles para quien llama: el personal de Yago ve a todos con sus datos de
-- contacto; los demás ven a su organización y a los agentes, solo con nombre y rol.
create or replace function public.nexo_sd_directory()
returns table (
  user_id uuid, display_name text, org_id uuid, org_name text, role text,
  email text, phone_e164 text, is_staff boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, m.display_name, m.org_id, o.name, m.role,
         case when nexo_private.sd_is_staff() then m.email end,
         case when nexo_private.sd_is_staff() then m.phone_e164 end,
         (o.is_provider and m.role in ('agente', 'supervisor'))
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where m.active
    and o.active
    and auth.uid() is not null
    and nexo_private.sd_mfa_ok()
    and (nexo_private.sd_is_staff()
         or m.org_id in (select nexo_private.sd_user_org_ids())
         or (o.is_provider and m.role in ('agente', 'supervisor')))
  order by o.is_provider desc, o.name, m.display_name
$$;

-- -----------------------------------------------------------------------------
-- Pausas
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_pause_ticket(p_ticket_id uuid, p_reason text, p_justification text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago pausan relojes' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('infraestructura_subtel', 'red', 'terceros', 'decision_subtel') then
    raise exception 'nexo_sd: motivo de pausa no tipificado. Use infraestructura_subtel, red, terceros o decision_subtel; la pausa por acceso remoto pendiente se abre sola al solicitar el acceso'
      using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_justification)), 0) < 10 then
    raise exception 'nexo_sd: la justificación debe tener al menos 10 caracteres' using errcode = '22023';
  end if;
  if exists (select 1 from public.nexo_sd_clock_pauses p where p.ticket_id = p_ticket_id and p.ended_at is null) then
    raise exception 'nexo_sd: el ticket ya tiene una pausa abierta' using errcode = '23505';
  end if;
  if not exists (select 1 from public.nexo_sd_sla_clocks k where k.ticket_id = p_ticket_id and k.status = 'en_curso') then
    raise exception 'nexo_sd: el ticket no tiene plazos en curso que pausar' using errcode = '23514';
  end if;

  insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at, created_by)
  values (p_ticket_id, p_reason, btrim(p_justification), now(), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.nexo_sd_resume_ticket(p_ticket_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pause public.nexo_sd_clock_pauses;
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago reanudan relojes' using errcode = '42501';
  end if;
  select p.* into v_pause
  from public.nexo_sd_clock_pauses p
  where p.ticket_id = p_ticket_id and p.ended_at is null
  for update;
  if not found then
    raise exception 'nexo_sd: el ticket no tiene una pausa abierta' using errcode = '23514';
  end if;

  if v_pause.reason = 'acceso_remoto_pendiente' and v_pause.remote_access_request_id is not null then
    -- Reanudar sin esperar a SUBTEL equivale a desistir de la solicitud de acceso.
    update public.nexo_sd_remote_access_requests r
       set status = 'revocado', revoked_by = auth.uid(), revoked_at = now(),
           decision_note = coalesce(nullif(btrim(p_note), ''), 'Solicitud retirada por Yago')
     where r.id = v_pause.remote_access_request_id and r.status = 'pendiente';
  end if;

  update public.nexo_sd_clock_pauses p
     set ended_at = now(), ended_by = auth.uid()
   where p.id = v_pause.id and p.ended_at is null;

  if nullif(btrim(p_note), '') is not null then
    perform nexo_private.sd_add_event(p_ticket_id, 'comment', 'publico', btrim(p_note),
                                      jsonb_build_object('pausa_id', v_pause.id), auth.uid(), now());
  end if;
end;
$$;

-- La contraparte de SUBTEL acusa (acepta u objeta) una pausa.
create or replace function public.nexo_sd_acknowledge_pause(
  p_pause_id uuid, p_accept boolean default true, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pause public.nexo_sd_clock_pauses;
  v_org   uuid;
  v_user  uuid;
begin
  select p.* into v_pause from public.nexo_sd_clock_pauses p where p.id = p_pause_id for update;
  if not found then
    raise exception 'nexo_sd: la pausa no existe' using errcode = '23514';
  end if;
  select t.org_id into v_org from public.nexo_sd_tickets t where t.id = v_pause.ticket_id;
  if not nexo_private.sd_has_org_role(v_org, array['contraparte']) then
    raise exception 'nexo_sd: solo la contraparte de la organización acusa las pausas' using errcode = '42501';
  end if;
  if v_pause.subtel_ack_at is not null then
    raise exception 'nexo_sd: la pausa ya fue acusada' using errcode = '23514';
  end if;
  if not coalesce(p_accept, true) and coalesce(char_length(btrim(p_note)), 0) < 10 then
    raise exception 'nexo_sd: para objetar una pausa indique el motivo (al menos 10 caracteres)' using errcode = '22023';
  end if;

  update public.nexo_sd_clock_pauses p
     set subtel_ack_status = case when coalesce(p_accept, true) then 'aceptada' else 'objetada' end,
         subtel_ack_by = auth.uid(),
         subtel_ack_at = now(),
         subtel_ack_note = nullif(btrim(p_note), '')
   where p.id = p_pause_id;

  if not coalesce(p_accept, true) then
    for v_user in select nexo_private.sd_supervisors() loop
      perform nexo_private.sd_enqueue_user(
        v_user, array['push', 'email'], 'sd_pausa_objetada',
        nexo_private.sd_ticket_payload(v_pause.ticket_id) || jsonb_build_object('pausa_id', p_pause_id, 'nota', p_note),
        v_pause.ticket_id, 'pause:' || p_pause_id::text || ':objetada', 2);
    end loop;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Acceso remoto (BT-065)
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_request_remote_access(p_ticket_id uuid, p_scope text, p_justification text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago solicitan acceso remoto' using errcode = '42501';
  end if;
  if coalesce(char_length(btrim(p_scope)), 0) < 5 then
    raise exception 'nexo_sd: describa el alcance del acceso (equipos, sistemas y duración)' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_justification)), 0) < 10 then
    raise exception 'nexo_sd: la justificación debe tener al menos 10 caracteres' using errcode = '22023';
  end if;
  if exists (select 1 from public.nexo_sd_remote_access_requests r where r.ticket_id = p_ticket_id and r.status = 'pendiente') then
    raise exception 'nexo_sd: ya hay una solicitud de acceso remoto pendiente' using errcode = '23505';
  end if;
  insert into public.nexo_sd_remote_access_requests (ticket_id, scope, justification, requested_by, requested_at)
  values (p_ticket_id, btrim(p_scope), btrim(p_justification), auth.uid(), now())
  returning id into v_id;
  return v_id;
end;
$$;

-- La contraparte habilita o rechaza el acceso; en ambos casos se reanuda el reloj.
create or replace function public.nexo_sd_decide_remote_access(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.nexo_sd_remote_access_requests;
  v_org uuid;
begin
  select r.* into v_req from public.nexo_sd_remote_access_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'nexo_sd: la solicitud no existe' using errcode = '23514';
  end if;
  select t.org_id into v_org from public.nexo_sd_tickets t where t.id = v_req.ticket_id;
  if not nexo_private.sd_has_org_role(v_org, array['contraparte']) then
    raise exception 'nexo_sd: solo la contraparte de la organización habilita el acceso remoto' using errcode = '42501';
  end if;
  if v_req.status <> 'pendiente' then
    raise exception 'nexo_sd: la solicitud ya fue resuelta' using errcode = '23514';
  end if;
  update public.nexo_sd_remote_access_requests r
     set status = case when p_approve then 'habilitado' else 'rechazado' end,
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = nullif(btrim(p_note), '')
   where r.id = p_request_id;
end;
$$;

-- Al cerrar la sesión se revoca el acceso y se registra la referencia de la bitácora.
create or replace function public.nexo_sd_revoke_remote_access(p_request_id uuid, p_session_log_ref text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.nexo_sd_remote_access_requests;
  v_org uuid;
begin
  select r.* into v_req from public.nexo_sd_remote_access_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'nexo_sd: la solicitud no existe' using errcode = '23514';
  end if;
  select t.org_id into v_org from public.nexo_sd_tickets t where t.id = v_req.ticket_id;
  if not (nexo_private.sd_is_staff() or nexo_private.sd_has_org_role(v_org, array['contraparte'])) then
    raise exception 'nexo_sd: no tiene permiso para revocar este acceso' using errcode = '42501';
  end if;
  if v_req.status not in ('pendiente', 'habilitado') then
    raise exception 'nexo_sd: el acceso ya no está vigente' using errcode = '23514';
  end if;
  update public.nexo_sd_remote_access_requests r
     set status = 'revocado',
         revoked_by = auth.uid(),
         revoked_at = now(),
         session_log_ref = coalesce(nullif(btrim(p_session_log_ref), ''), r.session_log_ref)
   where r.id = p_request_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Escalamiento manual y reclasificación
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_escalate_ticket(p_ticket_id uuid, p_level int, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
  v_msgs   int;
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago escalan tickets' using errcode = '42501';
  end if;
  if p_level is null or p_level not between 1 and 3 then
    raise exception 'nexo_sd: el nivel de escalamiento es 1, 2 o 3' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 5 then
    raise exception 'nexo_sd: indique el motivo del escalamiento' using errcode = '22023';
  end if;
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket_id for update;
  if not found or v_ticket.intake_status <> 'aceptado' then
    raise exception 'nexo_sd: el ticket no existe o está en cuarentena' using errcode = '23514';
  end if;

  update public.nexo_sd_tickets t
     set escalation_level = greatest(t.escalation_level, p_level), last_escalated_at = now()
   where t.id = p_ticket_id;
  v_msgs := nexo_private.sd_notify_levels(
    p_ticket_id, array[p_level], 'sd_escalamiento_manual',
    jsonb_build_object('nivel', p_level, 'motivo', btrim(p_reason)),
    'ticket:' || p_ticket_id::text || ':manual:' || p_level::text || ':' || extract(epoch from clock_timestamp())::bigint::text,
    true, now(), 1, true);
  perform nexo_private.sd_add_event(
    p_ticket_id, 'escalation', 'interno', btrim(p_reason),
    jsonb_build_object('nivel', p_level, 'mensajes', v_msgs, 'motivo', 'manual'), auth.uid(), now());
  return v_msgs;
end;
$$;

create or replace function public.nexo_sd_reclassify_ticket(p_ticket_id uuid, p_answers jsonb, p_justification text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago reclasifican tickets' using errcode = '42501';
  end if;
  if coalesce(char_length(btrim(p_justification)), 0) < 10 then
    raise exception 'nexo_sd: la justificación debe tener al menos 10 caracteres' using errcode = '22023';
  end if;
  perform nexo_private.sd_classify_answers(p_answers);

  update public.nexo_sd_tickets t set classification_answers = p_answers
   where t.id = p_ticket_id and t.intake_status = 'aceptado'
  returning t.* into v_ticket;
  if not found then
    raise exception 'nexo_sd: el ticket no existe o está en cuarentena' using errcode = '23514';
  end if;
  perform nexo_private.sd_add_event(p_ticket_id, 'comment', 'publico', 'Reclasificación: ' || btrim(p_justification),
                                    jsonb_build_object('severidad', v_ticket.severity), auth.uid(), now());
  return jsonb_build_object('severity', v_ticket.severity, 'rule', v_ticket.classification_rule);
end;
$$;

-- -----------------------------------------------------------------------------
-- Cuarentena (remitentes no registrados)
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_accept_quarantined_ticket(
  p_ticket_id uuid, p_org_id uuid, p_reporter_id uuid default null, p_answers jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago revisan la cuarentena' using errcode = '42501';
  end if;
  if not exists (select 1 from public.nexo_sd_organizations o where o.id = p_org_id and o.active) then
    raise exception 'nexo_sd: la organización no existe o no está activa' using errcode = '23514';
  end if;
  if p_reporter_id is not null
     and not nexo_private.sd_user_has_org_role(p_reporter_id, p_org_id, array['reportante', 'contraparte']) then
    raise exception 'nexo_sd: el reportante debe pertenecer a la organización' using errcode = '23514';
  end if;
  if p_answers is not null then
    perform nexo_private.sd_classify_answers(p_answers);
  end if;

  update public.nexo_sd_tickets t
     set org_id = p_org_id,
         reporter_id = coalesce(p_reporter_id, t.reporter_id),
         intake_status = 'aceptado',
         classification_answers = coalesce(p_answers, t.classification_answers)
   where t.id = p_ticket_id and t.intake_status = 'cuarentena';
  if not found then
    raise exception 'nexo_sd: el ticket no está en cuarentena' using errcode = '23514';
  end if;
end;
$$;

create or replace function public.nexo_sd_discard_quarantined_ticket(p_ticket_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: solo los agentes y supervisores de Yago revisan la cuarentena' using errcode = '42501';
  end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 5 then
    raise exception 'nexo_sd: indique el motivo del descarte' using errcode = '22023';
  end if;
  update public.nexo_sd_tickets t set intake_status = 'descartado'
   where t.id = p_ticket_id and t.intake_status = 'cuarentena';
  if not found then
    raise exception 'nexo_sd: el ticket no está en cuarentena' using errcode = '23514';
  end if;
  perform nexo_private.sd_add_event(p_ticket_id, 'comment', 'interno', 'Descartado: ' || btrim(p_reason),
                                    '{}'::jsonb, auth.uid(), now());
end;
$$;

-- -----------------------------------------------------------------------------
-- Paquetes de corrección: aprobación de cuatro ojos (quien lo crea no lo aprueba).
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_decide_patch(p_patch_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patch public.nexo_sd_patch_packages;
begin
  select p.* into v_patch from public.nexo_sd_patch_packages p where p.id = p_patch_id for update;
  if not found then
    raise exception 'nexo_sd: el paquete no existe' using errcode = '23514';
  end if;
  if not (nexo_private.sd_has_org_role(v_patch.org_id, array['contraparte']) or nexo_private.sd_is_supervisor()) then
    raise exception 'nexo_sd: aprueba la contraparte de la organización o un supervisor de Yago' using errcode = '42501';
  end if;
  if v_patch.created_by = auth.uid() then
    raise exception 'nexo_sd: quien preparó el paquete no puede aprobarlo (cuatro ojos)' using errcode = '42501';
  end if;
  if v_patch.status <> 'pendiente_aprobacion' then
    raise exception 'nexo_sd: el paquete no está pendiente de aprobación' using errcode = '23514';
  end if;
  if not p_approve and coalesce(char_length(btrim(p_note)), 0) < 5 then
    raise exception 'nexo_sd: indique el motivo del rechazo' using errcode = '22023';
  end if;
  update public.nexo_sd_patch_packages p
     set status = case when p_approve then 'aprobado' else 'rechazado' end,
         approved_by = auth.uid(),
         approved_at = now(),
         approval_note = nullif(btrim(p_note), '')
   where p.id = p_patch_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Avisos dentro de la aplicación
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_mark_notifications_read(p_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if auth.uid() is null or not nexo_private.sd_mfa_ok() then
    raise exception 'nexo_sd: se requiere una sesión con MFA' using errcode = '42501';
  end if;
  update public.nexo_sd_notifications n
     set read_at = now()
   where n.recipient_user_id = auth.uid()
     and n.read_at is null
     and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Bandeja de salida (solo backend: nexo-sd-notify)
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_backoff_seconds(p_attempts int)
returns int
language sql
immutable
set search_path = ''
as $$
  -- 1, 2, 4, 8... minutos, con tope de 30 minutos.
  select least(60 * power(2, greatest(coalesce(p_attempts, 1), 1) - 1)::int, 1800)
$$;

create or replace function public.nexo_sd_claim_notifications(p_limit int default 20, p_lock_seconds int default 120)
returns setof public.nexo_sd_notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select n.id
    from public.nexo_sd_notifications n
    where n.status = 'pendiente'
      and n.next_attempt_at <= now()
      and (n.locked_until is null or n.locked_until < now())
    order by n.priority, n.next_attempt_at, n.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  )
  update public.nexo_sd_notifications n
     set locked_until = now() + make_interval(secs => greatest(coalesce(p_lock_seconds, 120), 30)),
         attempts = n.attempts + 1
    from picked
   where n.id = picked.id
  returning n.*;
end;
$$;

-- p_permanent: el proveedor rechazó el envío de forma definitiva (por ejemplo, dirección
-- inválida); no tiene sentido reintentar.
create or replace function public.nexo_sd_complete_notification(
  p_id uuid, p_ok boolean, p_result jsonb default null, p_error text default null, p_permanent boolean default false)
returns public.nexo_sd_notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.nexo_sd_notifications;
  v_max int := (nexo_private.sd_settings()).notify_max_attempts;
begin
  select n.* into v_row from public.nexo_sd_notifications n where n.id = p_id for update;
  if not found then
    raise exception 'nexo_sd: la notificación no existe' using errcode = '23514';
  end if;
  if v_row.status <> 'pendiente' then
    return v_row;
  end if;

  if p_ok then
    update public.nexo_sd_notifications n
       set status = 'enviada', sent_at = now(), result = p_result, last_error = null, locked_until = null
     where n.id = p_id
    returning n.* into v_row;
  elsif v_row.attempts >= v_max or coalesce(p_permanent, false) then
    update public.nexo_sd_notifications n
       set status = 'fallida', result = p_result, last_error = left(p_error, 2000), locked_until = null
     where n.id = p_id
    returning n.* into v_row;
    if v_row.ticket_id is not null then
      perform nexo_private.sd_add_event(
        v_row.ticket_id, 'notification', 'interno',
        format('Falló el aviso por %s a %s tras %s intentos.', v_row.channel,
               coalesce(v_row.payload ->> 'destinatario', 'un destinatario'), v_row.attempts),
        jsonb_build_object('notificacion_id', v_row.id, 'canal', v_row.channel, 'plantilla', v_row.template,
                           'error', left(p_error, 500)),
        null, now());
    end if;
  else
    update public.nexo_sd_notifications n
       set next_attempt_at = now() + make_interval(secs => nexo_private.sd_backoff_seconds(v_row.attempts)),
           result = p_result, last_error = left(p_error, 2000), locked_until = null
     where n.id = p_id
    returning n.* into v_row;
  end if;
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Canal entrante (solo backend: nexo-sd-inbound). Mapea el remitente a un miembro:
--   * responde a un ticket (SD-AAAA-NNNN en el asunto o el texto) -> comentario
--   * remitente registrado de una organización cliente -> ticket (severidad provisional)
--   * remitente desconocido -> ticket en cuarentena para revisión de un agente
-- Idempotente por identificador del mensaje.
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_inbound_message(
  p_channel text, p_sender text, p_sender_name text, p_subject text, p_body text,
  p_external_id text, p_received_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref     text;
  v_sender  text;
  v_body    text;
  v_title   text;
  v_created timestamptz;
  v_number  text;
  v_member  record;
  v_ticket  public.nexo_sd_tickets;
begin
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'nexo_sd: canal entrante no soportado' using errcode = '22023';
  end if;
  if coalesce(btrim(p_external_id), '') = '' then
    raise exception 'nexo_sd: falta el identificador del mensaje' using errcode = '22023';
  end if;
  v_ref := p_channel || ':' || btrim(p_external_id);

  select t.* into v_ticket from public.nexo_sd_tickets t where t.external_ref = v_ref;
  if found then
    return jsonb_build_object('resultado', 'duplicado', 'ticket_id', v_ticket.id, 'numero', v_ticket.number);
  end if;
  if exists (select 1 from public.nexo_sd_ticket_events e where e.payload ->> 'external_ref' = v_ref) then
    return jsonb_build_object('resultado', 'duplicado');
  end if;

  v_sender := case p_channel
    when 'email' then lower(btrim(coalesce(p_sender, '')))
    else '+' || regexp_replace(coalesce(p_sender, ''), '[^0-9]', '', 'g')
  end;
  v_body := left(coalesce(p_body, ''), 20000);
  v_title := left(coalesce(nullif(btrim(p_subject), ''), nullif(btrim(split_part(v_body, E'\n', 1)), ''),
                           'Mensaje sin asunto'), 200);
  if char_length(btrim(v_title)) < 3 then
    v_title := 'Mensaje por ' || p_channel;
  end if;
  v_created := case
    when p_received_at between now() - interval '1 day' and now() then p_received_at
    else now()
  end;

  select m.user_id, m.org_id, m.role, o.is_provider
    into v_member
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where m.active and o.active
    and ((p_channel = 'email' and lower(m.email) = v_sender)
         or (p_channel = 'whatsapp' and m.phone_e164 = v_sender))
  order by o.is_provider, m.created_at
  limit 1;

  v_number := substring(coalesce(p_subject, '') || ' ' || v_body from 'SD-[0-9]{4}-[0-9]{4,}');
  if v_member.user_id is not null and v_number is not null then
    select t.* into v_ticket from public.nexo_sd_tickets t where t.number = v_number;
    if found and v_ticket.status <> 'cerrado' and v_ticket.intake_status = 'aceptado'
       and (nexo_private.sd_user_is_staff(v_member.user_id)
            or nexo_private.sd_user_has_org_role(v_member.user_id, v_ticket.org_id, array['reportante', 'contraparte'])) then
      perform nexo_private.sd_add_event(
        v_ticket.id, 'comment', 'publico', coalesce(nullif(btrim(v_body), ''), '(mensaje sin texto)'),
        jsonb_build_object('canal', p_channel, 'external_ref', v_ref, 'remitente', v_sender),
        v_member.user_id, v_created);
      return jsonb_build_object('resultado', 'comentario', 'ticket_id', v_ticket.id, 'numero', v_ticket.number);
    end if;
  end if;

  if v_member.user_id is not null and not v_member.is_provider and v_member.role in ('reportante', 'contraparte') then
    insert into public.nexo_sd_tickets
      (org_id, title, description, channel, channel_sender, external_ref, reporter_id, created_by, created_at)
    values
      (v_member.org_id, v_title, v_body, p_channel, v_sender, v_ref, v_member.user_id, v_member.user_id, v_created)
    returning * into v_ticket;
    return jsonb_build_object('resultado', 'ticket', 'ticket_id', v_ticket.id, 'numero', v_ticket.number,
                              'severidad', v_ticket.severity);
  end if;

  insert into public.nexo_sd_tickets
    (org_id, title, description, channel, channel_sender, external_ref, intake_status, created_at)
  values
    (null, v_title,
     case when nullif(btrim(p_sender_name), '') is not null
       then 'Remitente: ' || btrim(p_sender_name) || ' <' || v_sender || '>' || E'\n\n' || v_body
       else v_body end,
     p_channel, v_sender, v_ref, 'cuarentena', v_created)
  returning * into v_ticket;
  return jsonb_build_object('resultado', 'cuarentena', 'ticket_id', v_ticket.id, 'numero', v_ticket.number);
end;
$$;

-- -----------------------------------------------------------------------------
-- Cumplimiento del SLA por severidad y métrica para un mes (AAAA-MM, hora de Santiago).
-- SECURITY INVOKER: cada usuario agrega solo lo que su RLS le deja ver; el backend
-- (service_role) ve todo y filtra por organización.
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_sla_summary(p_period text, p_org_id uuid default null)
returns table (
  severity text, metric text, calendar text, target_minutes int, total int, met_on_time int,
  breached int, pending int, compliance_pct numeric, avg_effective_minutes numeric, max_effective_minutes numeric)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz    text;
  v_month date;
  v_from  timestamptz;
  v_to    timestamptz;
begin
  if p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'nexo_sd: el período debe tener el formato AAAA-MM' using errcode = '22023';
  end if;
  v_tz := (nexo_private.sd_settings()).timezone;
  v_month := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_from := v_month::timestamp at time zone v_tz;
  v_to := (v_month + interval '1 month')::timestamp at time zone v_tz;

  return query
  with grid as (
    select p.severity as g_severity, m.g_metric, m.g_ord, p.calendar as g_calendar,
           nexo_private.sd_policy_target(p, m.g_metric) as g_target
    from public.nexo_sd_sla_policies p
    cross join (values ('acuse', 1), ('diagnostico', 2), ('solucion', 3)) as m(g_metric, g_ord)
  ),
  data as (
    select t.severity as d_severity, k.metric as d_metric, k.status as d_status,
           case when k.met_at is null then null
                else greatest(nexo_private.sd_calendar_seconds(k.calendar, k.started_at, k.met_at) - k.paused_seconds, 0) / 60.0
           end as d_minutes
    from public.nexo_sd_sla_clocks k
    join public.nexo_sd_tickets t on t.id = k.ticket_id
    where t.intake_status = 'aceptado'
      and k.target_minutes is not null
      and k.started_at >= v_from
      and k.started_at < v_to
      and (p_org_id is null or t.org_id = p_org_id)
  )
  select g.g_severity, g.g_metric, g.g_calendar, g.g_target,
         count(d.d_status)::int,
         (count(*) filter (where d.d_status = 'cumplido'))::int,
         (count(*) filter (where d.d_status = 'incumplido'))::int,
         (count(*) filter (where d.d_status in ('en_curso', 'pausado')))::int,
         round(100.0 * count(*) filter (where d.d_status = 'cumplido')
               / nullif(count(*) filter (where d.d_status in ('cumplido', 'incumplido')), 0), 2),
         round(avg(d.d_minutes), 1),
         round(max(d.d_minutes), 1)
  from grid g
  left join data d on d.d_severity = g.g_severity and d.d_metric = g.g_metric
  where g.g_target is not null
  group by g.g_severity, g.g_metric, g.g_ord, g.g_calendar, g.g_target
  order by g.g_severity, g.g_ord;
end;
$$;
comment on function public.nexo_sd_sla_summary(text, uuid) is
  'Mesa de soporte Nexo: cumplimiento del SLA por severidad y métrica del mes indicado (relojes iniciados en el mes).';

-- Datos completos del informe mensual de una organización (solo backend).
create or replace function public.nexo_sd_monthly_report_data(p_period text, p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_month date;
  v_from  timestamptz;
  v_to    timestamptz;
  v_org   public.nexo_sd_organizations;
begin
  select o.* into v_org from public.nexo_sd_organizations o where o.id = p_org_id;
  if not found then
    raise exception 'nexo_sd: la organización no existe' using errcode = '23514';
  end if;
  if p_period is null or p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'nexo_sd: el período debe tener el formato AAAA-MM' using errcode = '22023';
  end if;
  v_tz := (nexo_private.sd_settings()).timezone;
  v_month := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_from := v_month::timestamp at time zone v_tz;
  v_to := (v_month + interval '1 month')::timestamp at time zone v_tz;

  return jsonb_build_object(
    'organizacion', jsonb_build_object('id', v_org.id, 'nombre', v_org.name),
    'periodo', p_period,
    'desde', v_from,
    'hasta', v_to,
    'zona_horaria', v_tz,
    'generado_en', now(),
    'resumen', coalesce((select jsonb_agg(to_jsonb(s)) from public.nexo_sd_sla_summary(p_period, p_org_id) s), '[]'::jsonb),
    'tickets', jsonb_build_object(
      'total', (select count(*) from public.nexo_sd_tickets t
                where t.org_id = p_org_id and t.intake_status = 'aceptado'
                  and t.sla_started_at >= v_from and t.sla_started_at < v_to),
      'por_severidad', coalesce((
        select jsonb_object_agg(x.severity, x.n) from (
          select t.severity, count(*) as n from public.nexo_sd_tickets t
          where t.org_id = p_org_id and t.intake_status = 'aceptado'
            and t.sla_started_at >= v_from and t.sla_started_at < v_to
          group by t.severity) x), '{}'::jsonb),
      'por_estado', coalesce((
        select jsonb_object_agg(x.status, x.n) from (
          select t.status, count(*) as n from public.nexo_sd_tickets t
          where t.org_id = p_org_id and t.intake_status = 'aceptado'
            and t.sla_started_at >= v_from and t.sla_started_at < v_to
          group by t.status) x), '{}'::jsonb)
    ),
    'pausas', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', x.reason, 'cantidad', x.n, 'minutos', x.minutes,
                                          'objetadas', x.objected) order by x.reason)
      from (
        select p.reason, count(*) as n,
               round(sum(extract(epoch from (coalesce(p.ended_at, least(now(), v_to)) - p.started_at))) / 60.0, 1) as minutes,
               count(*) filter (where p.subtel_ack_status = 'objetada') as objected
        from public.nexo_sd_clock_pauses p
        join public.nexo_sd_tickets t on t.id = p.ticket_id
        where t.org_id = p_org_id and p.started_at >= v_from and p.started_at < v_to
        group by p.reason) x), '[]'::jsonb),
    'incumplimientos', coalesce((
      select jsonb_agg(jsonb_build_object('numero', t.number, 'titulo', t.title, 'severidad', t.severity,
                                          'metrica', k.metric, 'vencia', k.due_at, 'cumplido', k.met_at)
                       order by k.due_at)
      from public.nexo_sd_sla_clocks k
      join public.nexo_sd_tickets t on t.id = k.ticket_id
      where t.org_id = p_org_id and k.status = 'incumplido'
        and k.started_at >= v_from and k.started_at < v_to), '[]'::jsonb),
    'incidentes_seguridad', (
      select count(*) from public.nexo_sd_security_incidents i
      where i.org_id = p_org_id and i.detected_at >= v_from and i.detected_at < v_to)
  );
end;
$$;

-- Registra (o reemplaza) el informe generado y avisa a la organización (solo backend).
create or replace function public.nexo_sd_record_monthly_report(
  p_org_id uuid, p_period text, p_summary jsonb, p_pdf_path text, p_generated_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_user uuid;
begin
  insert into public.nexo_sd_monthly_reports (org_id, period, summary, pdf_path, generated_at, generated_by)
  values (p_org_id, p_period, coalesce(p_summary, '{}'::jsonb), p_pdf_path, now(), p_generated_by)
  on conflict (org_id, period) do update
    set summary = excluded.summary, pdf_path = excluded.pdf_path,
        generated_at = excluded.generated_at, generated_by = excluded.generated_by
  returning id into v_id;

  for v_user in
    select distinct m.user_id from public.nexo_sd_members m
    where m.org_id = p_org_id and m.active and m.role in ('contraparte', 'reportante')
  loop
    perform nexo_private.sd_enqueue_user(
      v_user, array['push', 'email'], 'sd_informe_mensual',
      jsonb_build_object('periodo', p_period, 'informe_id', v_id,
                         'url', (select s.app_base_url from public.nexo_sd_settings s where s.id) || '/informes'),
      null, 'report:' || p_org_id::text || ':' || p_period || ':' || extract(epoch from now())::bigint::text, 6);
  end loop;
  return v_id;
end;
$$;
