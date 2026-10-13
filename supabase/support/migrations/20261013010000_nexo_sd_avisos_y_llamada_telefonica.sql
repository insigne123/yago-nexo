-- =============================================================================
-- Mesa de soporte Nexo · 1.2.0 · Avisos de vencimiento, llamada telefónica y nivel 3
--
--   1) Ticket telefónico: el agente ingresa la hora real de la llamada (call_received_at). Esa
--      hora fija el inicio del reloj, no puede ser posterior al registro del ticket ni anterior
--      a él en más de phone_call_max_backdate_minutes (24 horas por omisión), no se puede
--      cambiar desde la API y queda en la línea de tiempo con el nombre de quien la ingresó.
--   2) Al vencer un plazo (acuse, diagnóstico o solución) se avisa también a la contraparte de
--      la organización del ticket. Un solo aviso por vencimiento (dedup_key por reloj).
--   3) Un aviso que no se pudo enviar porque falta el proveedor del canal queda «fallida», no
--      «enviada», y se registra en la línea de tiempo interna del ticket.
--   4) Nivel 3 = supervisión: los turnos de nivel 3 solo se asignan a supervisores, y el aviso
--      al nivel 3 llega solo a supervisores.
--
-- Solo crea o modifica objetos propios (tablas nexo_sd_* y funciones de nexo_private). Se puede
-- reaplicar sin error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Hora real de la llamada
-- -----------------------------------------------------------------------------
alter table public.nexo_sd_settings
  add column if not exists phone_call_max_backdate_minutes int not null default 1440
    constraint nexo_sd_settings_phone_call_backdate check (phone_call_max_backdate_minutes between 1 and 10080);
comment on column public.nexo_sd_settings.phone_call_max_backdate_minutes is
  'Ticket telefónico: cuántos minutos antes del registro puede estar la hora real de la llamada (por omisión 1.440 = 24 horas).';

alter table public.nexo_sd_tickets add column if not exists call_received_at timestamptz;
comment on column public.nexo_sd_tickets.call_received_at is
  'Ticket telefónico: hora real de la llamada que ingresa el agente al registrarlo. Fija el inicio del reloj (sla_started_at). No es posterior a created_at (registro) y la API no la puede cambiar.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'nexo_sd_tickets_call_received_at'
      and conrelid = 'public.nexo_sd_tickets'::regclass
  ) then
    alter table public.nexo_sd_tickets
      add constraint nexo_sd_tickets_call_received_at
      check (call_received_at is null or (channel = 'telefono' and call_received_at <= created_at));
  end if;
end;
$$;

-- La API la escribe solo al crear el ticket (no hay permiso de UPDATE sobre la columna).
grant insert (call_received_at) on table public.nexo_sd_tickets to authenticated;

create or replace function nexo_private.sd_tickets_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_priv boolean := nexo_private.sd_is_privileged();
  v_uid  uuid := auth.uid();
  v_cfg  public.nexo_sd_settings;
  v_sev  text;
  v_rule text;
  v_max  int;
begin
  v_cfg := nexo_private.sd_settings();

  if not v_priv then
    -- Llamada desde la API: se imponen los valores que el usuario no elige.
    if v_uid is null then
      raise exception 'nexo_sd: se requiere una sesión' using errcode = '42501';
    end if;
    new.created_at := now();
    new.created_by := v_uid;
    new.status := 'nuevo';
    new.intake_status := 'aceptado';
    new.external_ref := null;
    new.channel_sender := null;
    new.sla_started_at := null;
    new.acknowledged_at := null;
    new.diagnosed_at := null;
    new.workaround_at := null;
    new.resolved_at := null;
    new.closed_at := null;
    if nexo_private.sd_is_staff() then
      -- Un agente registra un ticket recibido por teléfono a nombre de un miembro.
      if new.channel not in ('web', 'telefono') then
        new.channel := 'telefono';
      end if;
      if new.reporter_id is not null
         and not nexo_private.sd_user_has_org_role(new.reporter_id, new.org_id, array['reportante', 'contraparte']) then
        raise exception 'nexo_sd: el reportante debe pertenecer a la organización del ticket' using errcode = '23514';
      end if;
      if new.assignee_id is not null and not nexo_private.sd_user_is_staff(new.assignee_id) then
        raise exception 'nexo_sd: el responsable debe ser un agente o supervisor de Yago' using errcode = '23514';
      end if;
      if new.channel = 'telefono' and new.call_received_at is null then
        raise exception 'nexo_sd: indique la hora real de la llamada' using errcode = '23514';
      end if;
    else
      if not nexo_private.sd_has_org_role(new.org_id, array['reportante', 'contraparte']) then
        raise exception 'nexo_sd: solo los miembros de la organización pueden crear tickets en ella'
          using errcode = '42501';
      end if;
      new.reporter_id := v_uid;
      new.channel := 'web';
      new.assignee_id := null;
      new.call_received_at := null;
    end if;
  end if;

  -- Severidad determinista desde las respuestas del asistente (BT-061).
  if new.classification_answers is not null then
    select c.severity, c.rule into v_sev, v_rule from nexo_private.sd_classify_answers(new.classification_answers) c;
    new.severity := v_sev;
    new.classification_rule := v_rule;
    new.classification_source := 'asistente';
  else
    if new.channel = 'web' then
      raise exception 'nexo_sd: responda las cinco preguntas del asistente de severidad' using errcode = '23514';
    end if;
    new.severity := v_cfg.inbound_provisional_severity;
    new.classification_rule := 'Clasificación provisional (canal ' || new.channel
                               || '): se confirma con el asistente al acusar recibo';
    new.classification_source := 'provisional';
  end if;

  new.created_at := coalesce(new.created_at, now());
  new.number := nexo_private.sd_next_ticket_number(new.created_at);
  new.updated_at := new.created_at;

  -- Ticket telefónico: el reloj parte con la hora real de la llamada, que no puede ser
  -- posterior al registro ni anterior a él en más del margen configurado.
  if new.channel = 'telefono' then
    new.call_received_at := coalesce(new.call_received_at, new.created_at);
    v_max := v_cfg.phone_call_max_backdate_minutes;
    if new.call_received_at > new.created_at then
      raise exception 'nexo_sd: la hora de la llamada no puede ser posterior al registro del ticket'
        using errcode = '23514';
    end if;
    if new.call_received_at < new.created_at - make_interval(mins => v_max) then
      raise exception 'nexo_sd: la hora de la llamada no puede ser anterior en más de % al registro del ticket',
        case when v_max = 60 then '1 hora'
             when v_max % 60 = 0 then (v_max / 60)::text || ' horas'
             else v_max::text || ' minutos' end
        using errcode = '23514';
    end if;
  elsif new.call_received_at is not null then
    raise exception 'nexo_sd: la hora de la llamada solo se registra en tickets telefónicos' using errcode = '23514';
  end if;

  if new.intake_status = 'aceptado' then
    new.sla_started_at := coalesce(new.sla_started_at, new.call_received_at, new.created_at);
    new.escalation_level := 1;
    new.last_escalated_at := new.sla_started_at;
  else
    new.sla_started_at := null;
    new.escalation_level := 0;
    new.last_escalated_at := null;
    new.status := 'nuevo';
  end if;
  return new;
end;
$$;

create or replace function nexo_private.sd_tickets_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform nexo_private.sd_add_event(
    new.id, 'status_change', case when new.intake_status = 'aceptado' then 'publico' else 'interno' end,
    case
      when new.intake_status = 'cuarentena'
        then 'Mensaje de un remitente no registrado: queda en cuarentena hasta que un agente lo revise.'
      when new.call_received_at is not null
        then format('Ticket telefónico recibido. Hora real de la llamada: %s; el reloj del SLA parte a esa hora.',
                    to_char(new.call_received_at at time zone (nexo_private.sd_settings()).timezone, 'DD-MM-YYYY HH24:MI'))
      else 'Ticket recibido.'
    end,
    jsonb_build_object('de', null, 'a', new.status, 'severidad', new.severity, 'regla', new.classification_rule,
                       'origen_clasificacion', new.classification_source, 'canal', new.channel)
      || case when new.call_received_at is null then '{}'::jsonb
              else jsonb_build_object('hora_llamada', new.call_received_at, 'registrado', new.created_at,
                                      'registrado_por', new.created_by) end,
    new.created_by, new.created_at);

  if new.intake_status = 'aceptado' then
    perform nexo_private.sd_activate_ticket(new.id);
    if new.is_security_incident then
      perform nexo_private.sd_ensure_security_incident(new.id, new.created_at);
    end if;
  elsif new.intake_status = 'cuarentena' then
    perform nexo_private.sd_notify_quarantine(new.id);
  end if;
  return null;
end;
$$;

-- El aviso de ticket nuevo sale cuando el ticket se registra: en un ticket telefónico el reloj
-- parte antes (la llamada), pero el turno que se avisa es el del registro.
create or replace function nexo_private.sd_activate_ticket(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
  v_msgs   int;
  v_at     timestamptz;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found or v_ticket.intake_status <> 'aceptado' then
    return;
  end if;
  v_at := greatest(coalesce(v_ticket.sla_started_at, now()), v_ticket.created_at);
  perform nexo_private.sd_create_clocks(p_ticket);
  v_msgs := nexo_private.sd_notify_levels(
    p_ticket, array[1], 'sd_ticket_nuevo', '{}'::jsonb, 'ticket:' || p_ticket::text || ':nuevo',
    false, v_at, nexo_private.sd_priority_for(v_ticket.severity), true);
  perform nexo_private.sd_add_event(
    p_ticket, 'notification', 'interno',
    format('Aviso de ticket nuevo al turno de nivel 1 (%s mensajes en cola).', v_msgs),
    jsonb_build_object('plantilla', 'sd_ticket_nuevo', 'niveles', jsonb_build_array(1), 'mensajes', v_msgs),
    null, v_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2) Vencimiento de un plazo: aviso a la contraparte de la organización del ticket
--    (los niveles 1, 2 y 3 los avisa sd_tick). Cubre todo paso a «incumplido»: el tick, un
--    hito cumplido tarde y la reclasificación. Un solo aviso por reloj vencido.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_clocks_after_breach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket   public.nexo_sd_tickets;
  v_channels text[];
  v_label    text;
  v_msgs     int;
  v_due      timestamptz := coalesce(new.breached_at, new.due_at);
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = new.ticket_id;
  if not found or v_ticket.intake_status <> 'aceptado' then
    return null;
  end if;
  -- Ya se avisó este vencimiento (por ejemplo, el reloj volvió a vencer tras reclasificar).
  if exists (
    select 1 from public.nexo_sd_ticket_events e
    where e.ticket_id = new.ticket_id and e.type = 'notification'
      and e.payload ->> 'reloj_vencido' = new.id::text
  ) then
    return null;
  end if;

  v_label := case new.metric when 'acuse' then 'acuse' when 'diagnostico' then 'diagnóstico' else 'solución' end;
  v_channels := array(
    select c from unnest((nexo_private.sd_policy(v_ticket.severity)).channels) as c where c <> 'voz');
  v_msgs := nexo_private.sd_notify_org_roles(
    new.ticket_id, array['contraparte'], v_channels, 'sd_sla_vencido_contraparte',
    jsonb_build_object('metrica', new.metric, 'metrica_texto', v_label, 'umbral', 100, 'vence', v_due),
    'clock:' || new.id::text || ':vencido:contraparte');
  perform nexo_private.sd_add_event(
    new.ticket_id, 'notification', 'interno',
    case when v_msgs > 0
      then format('Venció el plazo de %s: aviso a la contraparte del cliente (%s mensajes en cola).', v_label, v_msgs)
      else format('Venció el plazo de %s: la organización no tiene una contraparte activa registrada; no hubo a quién avisar.', v_label)
    end,
    jsonb_build_object('plantilla', 'sd_sla_vencido_contraparte', 'metrica', new.metric, 'roles', jsonb_build_array('contraparte'),
                       'mensajes', v_msgs, 'reloj_vencido', new.id),
    null, coalesce(new.notified_100_at, now()));
  return null;
end;
$$;

drop trigger if exists nexo_sd_sla_clocks_after_breach on public.nexo_sd_sla_clocks;
create trigger nexo_sd_sla_clocks_after_breach
  after update of status on public.nexo_sd_sla_clocks
  for each row
  when (new.status = 'incumplido' and old.status is distinct from 'incumplido')
  execute function nexo_private.sd_clocks_after_breach();

-- -----------------------------------------------------------------------------
-- 3) Bandeja de salida: sin proveedor configurado el aviso queda «fallida» (sin reintentos).
--    nexo-sd-notify lo informa con p_ok = false y result.sin_proveedor = true; una versión
--    anterior de la función lo informaba como enviado con result.simulado = true, y también se
--    trata como fallido.
-- -----------------------------------------------------------------------------
create or replace function public.nexo_sd_complete_notification(
  p_id uuid, p_ok boolean, p_result jsonb default null, p_error text default null, p_permanent boolean default false)
returns public.nexo_sd_notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row         public.nexo_sd_notifications;
  v_max         int := (nexo_private.sd_settings()).notify_max_attempts;
  v_no_provider boolean := coalesce((p_result ->> 'sin_proveedor') = 'true' or (p_result ->> 'simulado') = 'true', false);
  v_error       text;
begin
  select n.* into v_row from public.nexo_sd_notifications n where n.id = p_id for update;
  if not found then
    raise exception 'nexo_sd: la notificación no existe' using errcode = '23514';
  end if;
  if v_row.status <> 'pendiente' then
    return v_row;
  end if;

  if p_ok and not v_no_provider then
    update public.nexo_sd_notifications n
       set status = 'enviada', sent_at = now(), result = p_result, last_error = null, locked_until = null
     where n.id = p_id
    returning n.* into v_row;
  elsif v_no_provider or v_row.attempts >= v_max or coalesce(p_permanent, false) then
    v_error := case when v_no_provider then coalesce(p_error, 'Proveedor del canal no configurado') else p_error end;
    update public.nexo_sd_notifications n
       set status = 'fallida', result = p_result, last_error = left(v_error, 2000), locked_until = null
     where n.id = p_id
    returning n.* into v_row;
    if v_row.ticket_id is not null then
      perform nexo_private.sd_add_event(
        v_row.ticket_id, 'notification', 'interno',
        case when v_no_provider
          then format('No se envió el aviso por %s a %s: el proveedor del canal no está configurado.', v_row.channel,
                      coalesce(v_row.payload ->> 'destinatario', 'un destinatario'))
          else format('Falló el aviso por %s a %s tras %s intentos.', v_row.channel,
                      coalesce(v_row.payload ->> 'destinatario', 'un destinatario'), v_row.attempts)
        end,
        jsonb_build_object('notificacion_id', v_row.id, 'canal', v_row.channel, 'plantilla', v_row.template,
                           'error', left(v_error, 500), 'sin_proveedor', v_no_provider),
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
-- 4) Nivel 3 = supervisión
-- -----------------------------------------------------------------------------
comment on table public.nexo_sd_oncall_shifts is
  'Mesa de soporte Nexo: turnos. Nivel 1 (primer contacto) -> 2 (técnico) -> 3 (supervisión, que incluye seguridad: solo supervisores).';

create or replace function nexo_private.sd_user_is_supervisor(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.nexo_sd_members m
    join public.nexo_sd_organizations o on o.id = m.org_id
    where m.user_id = p_user
      and m.active
      and o.active
      and o.is_provider
      and m.role = 'supervisor'
  )
$$;
revoke all on function nexo_private.sd_user_is_supervisor(uuid) from public, anon, authenticated;
revoke all on function nexo_private.sd_clocks_after_breach() from public, anon, authenticated;

-- Personas de turno en un nivel; en el nivel 3 solo cuentan los supervisores. Si nadie cubre
-- ese nivel, avisa a los supervisores (nunca queda un aviso sin destinatario).
create or replace function nexo_private.sd_oncall_users(p_level int, p_at timestamptz)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select distinct s.user_id
    from public.nexo_sd_oncall_shifts s
    where s.level = p_level
      and s.starts_at <= p_at
      and s.ends_at > p_at
      and nexo_private.sd_user_is_staff(s.user_id)
      and (p_level < 3 or nexo_private.sd_user_is_supervisor(s.user_id));
  if not found then
    return query select nexo_private.sd_supervisors();
  end if;
end;
$$;

create or replace function nexo_private.sd_oncall_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not nexo_private.sd_user_is_staff(new.user_id) then
    raise exception 'nexo_sd: el turno debe asignarse a un agente o supervisor de Yago' using errcode = '23514';
  end if;
  if new.level = 3 and not nexo_private.sd_user_is_supervisor(new.user_id) then
    raise exception 'nexo_sd: el nivel 3 es la supervisión: asígnelo a un supervisor de Yago' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

create or replace function nexo_private.sd_notify_incident(
  p_incident uuid, p_milestone text, p_level int, p_due timestamptz, p_at timestamptz)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incident public.nexo_sd_security_incidents;
  v_user     uuid;
  v_count    int := 0;
  v_channels text[];
  v_payload  jsonb;
  v_label    text;
begin
  select i.* into v_incident from public.nexo_sd_security_incidents i where i.id = p_incident;
  if not found then
    return 0;
  end if;
  v_label := case p_milestone
    when 'deteccion' then 'detección'
    when 'alerta_temprana' then 'alerta temprana'
    when 'segundo_reporte' then 'segundo reporte'
    else 'informe final'
  end;
  v_channels := case
    when p_milestone = 'deteccion' or p_level >= 80 then array['push', 'whatsapp', 'email']
    else array['push', 'email']
  end;
  if p_level >= 100 then
    v_channels := v_channels || array['voz'];
  end if;
  v_payload := coalesce(nexo_private.sd_ticket_payload(v_incident.ticket_id), '{}'::jsonb) || jsonb_build_object(
    'incidente_id', v_incident.id, 'incidente', v_incident.title, 'hito', p_milestone, 'hito_texto', v_label,
    'umbral', p_level, 'vence', p_due);

  -- Supervisión (nivel 3): quien está de turno en el nivel 3 y todos los supervisores.
  for v_user in
    select distinct u
    from (
      select nexo_private.sd_oncall_users(3, coalesce(p_at, now())) as u
      union
      select nexo_private.sd_supervisors()
    ) recipients
    where u is not null
  loop
    v_count := v_count + nexo_private.sd_enqueue_user(
      v_user, v_channels,
      case when p_milestone = 'deteccion' then 'sd_incidente_seguridad' else 'sd_incidente_plazo' end,
      v_payload, v_incident.ticket_id,
      'incident:' || v_incident.id::text || ':' || p_milestone || ':' || p_level::text, 1);
  end loop;

  if v_count > 0 and v_incident.ticket_id is not null then
    perform nexo_private.sd_add_event(
      v_incident.ticket_id, 'security', 'interno',
      case when p_milestone = 'deteccion'
        then 'Incidente de seguridad registrado (Ley 21.663): se avisó a supervisión (nivel 3).'
        else format('Ley 21.663: %s al %s %% del plazo (vence %s).', v_label, p_level,
                    to_char(p_due at time zone (nexo_private.sd_settings()).timezone, 'DD-MM-YYYY HH24:MI'))
      end,
      jsonb_build_object('incidente_id', v_incident.id, 'hito', p_milestone, 'umbral', p_level, 'mensajes', v_count),
      null, coalesce(p_at, now()));
  end if;
  return v_count;
end;
$$;
