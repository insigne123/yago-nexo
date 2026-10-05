-- =============================================================================
-- Mesa de soporte Nexo · 04 · Motor SLA
--
-- Relojes: al aceptar un ticket se crean tres relojes (acuse, diagnóstico y solución)
-- según la política de su severidad; si la política no tiene plazo, el reloj queda
-- "no_aplica" (S4). Los hitos se marcan al llegar al estado correspondiente:
--   acusado -> acuse · en_diagnostico -> diagnóstico · solucion_temporal o resuelto -> solución
-- (un salto de estado marca también los hitos anteriores).
-- Pausas: solo con motivo tipificado; el tiempo en pausa no cuenta y el vencimiento se
-- recalcula al reanudar. Una pausa que empieza cuando el plazo ya venció no lo "salva".
-- sd_tick(): marca vencimientos y encola avisos al 50 %, 80 % y 100 % de cada plazo hacia
-- la cadena de turno, y escala los S1 sin acuse cada 10 minutos (nivel 1 -> 2 -> 3).
--
-- Convención de seguridad: los triggers BEFORE son SECURITY INVOKER (validan a quien
-- llama); los AFTER y las funciones internas son SECURITY DEFINER (escriben en tablas a
-- las que la API no tiene acceso). Todas fijan search_path = ''.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Políticas y cálculo de plazos
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_policy(p_severity text)
returns public.nexo_sd_sla_policies
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.nexo_sd_sla_policies;
begin
  select p.* into v_row from public.nexo_sd_sla_policies p where p.severity = p_severity;
  if not found then
    raise exception 'nexo_sd: no hay política SLA para la severidad %', p_severity;
  end if;
  return v_row;
end;
$$;

create or replace function nexo_private.sd_policy_target(p_policy public.nexo_sd_sla_policies, p_metric text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_metric
    when 'acuse' then p_policy.acuse_minutes
    when 'diagnostico' then p_policy.diagnostico_minutes
    when 'solucion' then p_policy.solucion_minutes
  end
$$;

-- Vencimiento = inicio + objetivo + tiempo en pausa ya cerrado, en el calendario del reloj.
create or replace function nexo_private.sd_clock_due(
  p_calendar text, p_started timestamptz, p_target_minutes int, p_paused_seconds numeric)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_target_minutes is null then null
    else nexo_private.sd_calendar_add(p_calendar, p_started, p_target_minutes * 60 + coalesce(p_paused_seconds, 0))
  end
$$;

-- Tiempo efectivo transcurrido (segundos del calendario del reloj, sin pausas).
create or replace function nexo_private.sd_clock_elapsed(p_clock public.nexo_sd_sla_clocks, p_at timestamptz)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_until   timestamptz := least(p_clock.met_at, p_at);
  v_elapsed numeric;
begin
  v_elapsed := nexo_private.sd_calendar_seconds(p_clock.calendar, p_clock.started_at, v_until) - p_clock.paused_seconds;
  if p_clock.status = 'pausado' and p_clock.paused_since is not null then
    v_elapsed := v_elapsed - nexo_private.sd_calendar_seconds(p_clock.calendar, p_clock.paused_since, v_until);
  end if;
  return greatest(v_elapsed, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Línea de tiempo
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_add_event(
  p_ticket uuid, p_type text, p_visibility text, p_body text, p_payload jsonb,
  p_author uuid default null, p_at timestamptz default now())
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body, payload, author_id, author_name, created_at)
  values (
    p_ticket, p_type, p_visibility, p_body, coalesce(p_payload, '{}'::jsonb), p_author,
    coalesce(nexo_private.sd_display_name(p_author), case when p_author is null then 'Sistema' else 'Usuario' end),
    coalesce(p_at, now())
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Notificaciones (bandeja de salida)
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_ticket_payload(p_ticket uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ticket_id', t.id,
    'numero', t.number,
    'titulo', t.title,
    'severidad', t.severity,
    'estado', t.status,
    'organizacion', (select o.name from public.nexo_sd_organizations o where o.id = t.org_id),
    'url', (select s.app_base_url from public.nexo_sd_settings s where s.id) || '/tickets/' || t.id::text
  )
  from public.nexo_sd_tickets t
  where t.id = p_ticket
$$;

-- Encola un aviso por canal para un usuario. Devuelve cuántas filas nuevas quedaron.
-- whatsapp y voz solo si el miembro tiene teléfono y aceptó ese canal; push es el aviso
-- dentro de la aplicación (Realtime).
create or replace function nexo_private.sd_enqueue_user(
  p_user uuid, p_channels text[], p_template text, p_payload jsonb, p_ticket uuid,
  p_dedup text, p_priority int default 5)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member    record;
  v_channel   text;
  v_recipient text;
  v_rows      int;
  v_count     int := 0;
begin
  if p_user is null or p_channels is null then
    return 0;
  end if;

  select m.display_name, m.email, m.phone_e164, m.whatsapp_opt_in, m.voice_opt_in
    into v_member
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where m.user_id = p_user and m.active and o.active
  order by o.is_provider desc, m.created_at
  limit 1;
  if not found then
    return 0;
  end if;

  foreach v_channel in array p_channels loop
    v_recipient := case v_channel
      when 'email' then v_member.email
      when 'whatsapp' then case when v_member.whatsapp_opt_in then v_member.phone_e164 end
      when 'voz' then case when v_member.voice_opt_in then v_member.phone_e164 end
      when 'push' then p_user::text
    end;
    continue when v_recipient is null;

    insert into public.nexo_sd_notifications
      (channel, recipient, recipient_user_id, ticket_id, template, payload, priority, dedup_key)
    values (
      v_channel, v_recipient, p_user, p_ticket, p_template,
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('destinatario', v_member.display_name),
      greatest(1, least(coalesce(p_priority, 5), 9)),
      case when p_dedup is null then null else p_dedup || ':' || p_user::text || ':' || v_channel end
    )
    on conflict (dedup_key) do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;

  return v_count;
end;
$$;

create or replace function nexo_private.sd_supervisors()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where o.is_provider and o.active and m.active and m.role = 'supervisor'
$$;

-- Personas de turno en un nivel. Si nadie cubre ese nivel, avisa a los supervisores
-- (nunca queda un aviso sin destinatario).
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
      and nexo_private.sd_user_is_staff(s.user_id);
  if not found then
    return query select nexo_private.sd_supervisors();
  end if;
end;
$$;

-- Avisa a uno o más niveles del turno (y al responsable del ticket).
create or replace function nexo_private.sd_notify_levels(
  p_ticket uuid, p_levels int[], p_template text, p_extra jsonb, p_dedup text,
  p_with_voice boolean, p_at timestamptz, p_priority int, p_include_assignee boolean default true)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket   public.nexo_sd_tickets;
  v_policy   public.nexo_sd_sla_policies;
  v_channels text[];
  v_users    uuid[] := array[]::uuid[];
  v_level    int;
  v_user     uuid;
  v_payload  jsonb;
  v_count    int := 0;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found then
    return 0;
  end if;
  v_policy := nexo_private.sd_policy(v_ticket.severity);
  v_channels := v_policy.channels;
  if p_with_voice and v_policy.voice_on_escalation and not ('voz' = any (v_channels)) then
    v_channels := v_channels || array['voz'];
  end if;

  foreach v_level in array p_levels loop
    v_users := v_users || array(select nexo_private.sd_oncall_users(v_level, coalesce(p_at, now())));
  end loop;
  if p_include_assignee and v_ticket.assignee_id is not null then
    v_users := v_users || v_ticket.assignee_id;
  end if;

  v_payload := coalesce(nexo_private.sd_ticket_payload(p_ticket), '{}'::jsonb)
            || coalesce(p_extra, '{}'::jsonb)
            || jsonb_build_object('niveles', to_jsonb(p_levels));

  for v_user in select distinct u from unnest(v_users) as u where u is not null loop
    v_count := v_count + nexo_private.sd_enqueue_user(v_user, v_channels, p_template, v_payload, p_ticket, p_dedup, p_priority);
  end loop;
  return v_count;
end;
$$;

-- Avisa a miembros de la organización del ticket con ciertos roles (por ejemplo, la
-- contraparte que debe acusar una pausa o aprobar un acceso remoto).
create or replace function nexo_private.sd_notify_org_roles(
  p_ticket uuid, p_roles text[], p_channels text[], p_template text, p_extra jsonb, p_dedup text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid;
  v_payload jsonb;
  v_count   int := 0;
  v_sev     text;
begin
  select t.severity into v_sev from public.nexo_sd_tickets t where t.id = p_ticket;
  v_payload := coalesce(nexo_private.sd_ticket_payload(p_ticket), '{}'::jsonb) || coalesce(p_extra, '{}'::jsonb);
  for v_user in
    select distinct m.user_id
    from public.nexo_sd_members m
    join public.nexo_sd_tickets t on t.org_id = m.org_id
    where t.id = p_ticket and m.active and m.role = any (p_roles)
  loop
    v_count := v_count + nexo_private.sd_enqueue_user(
      v_user, p_channels, p_template, v_payload, p_ticket, p_dedup, nexo_private.sd_priority_for(v_sev));
  end loop;
  return v_count;
end;
$$;

create or replace function nexo_private.sd_notify_reporter(p_ticket uuid, p_template text, p_dedup text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found or v_ticket.reporter_id is null then
    return 0;
  end if;
  return nexo_private.sd_enqueue_user(
    v_ticket.reporter_id, array['push', 'email'], p_template, nexo_private.sd_ticket_payload(p_ticket),
    p_ticket, p_dedup, nexo_private.sd_priority_for(v_ticket.severity));
end;
$$;

-- -----------------------------------------------------------------------------
-- Relojes
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_create_clocks(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
  v_policy public.nexo_sd_sla_policies;
  v_metric text;
  v_target int;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found or v_ticket.intake_status <> 'aceptado' or v_ticket.sla_started_at is null then
    return;
  end if;
  v_policy := nexo_private.sd_policy(v_ticket.severity);

  foreach v_metric in array array['acuse', 'diagnostico', 'solucion'] loop
    v_target := nexo_private.sd_policy_target(v_policy, v_metric);
    insert into public.nexo_sd_sla_clocks (ticket_id, metric, calendar, target_minutes, started_at, due_at, status)
    values (
      v_ticket.id, v_metric, v_policy.calendar, v_target, v_ticket.sla_started_at,
      nexo_private.sd_clock_due(v_policy.calendar, v_ticket.sla_started_at, v_target, 0),
      case when v_target is null then 'no_aplica' else 'en_curso' end
    )
    on conflict (ticket_id, metric) do nothing;
  end loop;
end;
$$;

-- Marca como cumplidos los hitos que el estado actual del ticket ya alcanzó.
create or replace function nexo_private.sd_mark_clocks_met(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket   public.nexo_sd_tickets;
  c          public.nexo_sd_sla_clocks;
  v_met      timestamptz;
  v_paused   numeric;
  v_due      timestamptz;
  v_status   text;
  v_breached timestamptz;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found then
    return;
  end if;

  for c in
    select k.* from public.nexo_sd_sla_clocks k
    where k.ticket_id = p_ticket and k.met_at is null
    for update
  loop
    v_met := case c.metric
      when 'acuse' then v_ticket.acknowledged_at
      when 'diagnostico' then v_ticket.diagnosed_at
      else coalesce(v_ticket.workaround_at, v_ticket.resolved_at)
    end;
    continue when v_met is null;

    v_paused := c.paused_seconds;
    v_due := c.due_at;
    if c.status = 'pausado' and c.paused_since is not null then
      v_paused := v_paused + nexo_private.sd_calendar_seconds(c.calendar, c.paused_since, v_met);
      v_due := nexo_private.sd_clock_due(c.calendar, c.started_at, c.target_minutes, v_paused);
    end if;

    v_breached := c.breached_at;
    if c.target_minutes is null then
      v_status := 'no_aplica';
    elsif v_breached is not null then
      v_status := 'incumplido';
    elsif v_met <= v_due then
      v_status := 'cumplido';
    else
      v_status := 'incumplido';
      v_breached := v_due;
    end if;

    update public.nexo_sd_sla_clocks k
       set met_at = v_met,
           status = v_status,
           breached_at = v_breached,
           paused_seconds = v_paused,
           paused_since = null,
           remaining_seconds_at_pause = null,
           due_at = v_due
     where k.id = c.id;
  end loop;
end;
$$;

-- Recalcula los relojes cuando cambia la severidad (reclasificación con el asistente).
-- Reconstruye el tiempo en pausa desde el historial en el calendario nuevo; solo cuenta
-- pausas que empezaron antes de un vencimiento ya registrado.
create or replace function nexo_private.sd_rebuild_clocks(p_ticket uuid, p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket    public.nexo_sd_tickets;
  v_policy    public.nexo_sd_sla_policies;
  v_open      public.nexo_sd_clock_pauses;
  c           public.nexo_sd_sla_clocks;
  v_target    int;
  v_calendar  text;
  v_until     timestamptz;
  v_paused    numeric;
  v_due       timestamptz;
  v_status    text;
  v_breached  timestamptz;
  v_since     timestamptz;
  v_remaining numeric;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found or v_ticket.intake_status <> 'aceptado' then
    return;
  end if;
  v_policy := nexo_private.sd_policy(v_ticket.severity);
  select p.* into v_open from public.nexo_sd_clock_pauses p where p.ticket_id = p_ticket and p.ended_at is null;

  for c in select k.* from public.nexo_sd_sla_clocks k where k.ticket_id = p_ticket for update loop
    v_target := nexo_private.sd_policy_target(v_policy, c.metric);
    v_calendar := v_policy.calendar;
    continue when v_target is not distinct from c.target_minutes and v_calendar = c.calendar;

    v_until := coalesce(c.met_at, p_now);
    select coalesce(sum(nexo_private.sd_calendar_seconds(
             v_calendar, greatest(p.started_at, c.started_at), least(p.ended_at, v_until))), 0)
      into v_paused
    from public.nexo_sd_clock_pauses p
    where p.ticket_id = p_ticket
      and p.ended_at is not null
      and p.started_at < v_until
      and p.started_at < coalesce(c.breached_at, 'infinity'::timestamptz);

    v_breached := null;
    v_since := null;
    v_remaining := null;
    if v_target is null then
      v_status := 'no_aplica';
      v_due := null;
    elsif c.met_at is not null then
      if v_open.id is not null and v_open.started_at < c.met_at then
        v_paused := v_paused + nexo_private.sd_calendar_seconds(v_calendar, greatest(v_open.started_at, c.started_at), c.met_at);
      end if;
      v_due := nexo_private.sd_clock_due(v_calendar, c.started_at, v_target, v_paused);
      if c.met_at <= v_due then
        v_status := 'cumplido';
      else
        v_status := 'incumplido';
        v_breached := v_due;
      end if;
    else
      v_due := nexo_private.sd_clock_due(v_calendar, c.started_at, v_target, v_paused);
      v_status := 'en_curso';
      if v_open.id is not null and v_open.started_at < v_due then
        v_status := 'pausado';
        v_since := greatest(v_open.started_at, c.started_at);
        v_remaining := greatest(v_target * 60
          - (nexo_private.sd_calendar_seconds(v_calendar, c.started_at, v_since) - v_paused), 0);
      end if;
    end if;

    update public.nexo_sd_sla_clocks k
       set calendar = v_calendar,
           target_minutes = v_target,
           paused_seconds = v_paused,
           due_at = v_due,
           status = v_status,
           breached_at = v_breached,
           paused_since = v_since,
           remaining_seconds_at_pause = v_remaining,
           notified_50_at = null,
           notified_80_at = null,
           notified_100_at = null
     where k.id = c.id;
  end loop;
end;
$$;

-- Activa el SLA de un ticket aceptado: crea relojes y avisa al nivel 1 del turno.
create or replace function nexo_private.sd_activate_ticket(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.nexo_sd_tickets;
  v_msgs   int;
begin
  select t.* into v_ticket from public.nexo_sd_tickets t where t.id = p_ticket;
  if not found or v_ticket.intake_status <> 'aceptado' then
    return;
  end if;
  perform nexo_private.sd_create_clocks(p_ticket);
  v_msgs := nexo_private.sd_notify_levels(
    p_ticket, array[1], 'sd_ticket_nuevo', '{}'::jsonb, 'ticket:' || p_ticket::text || ':nuevo',
    false, coalesce(v_ticket.sla_started_at, now()), nexo_private.sd_priority_for(v_ticket.severity), true);
  perform nexo_private.sd_add_event(
    p_ticket, 'notification', 'interno',
    format('Aviso de ticket nuevo al turno de nivel 1 (%s mensajes en cola).', v_msgs),
    jsonb_build_object('plantilla', 'sd_ticket_nuevo', 'niveles', jsonb_build_array(1), 'mensajes', v_msgs),
    null, coalesce(v_ticket.sla_started_at, now()));
end;
$$;

create or replace function nexo_private.sd_notify_quarantine(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid;
  v_payload jsonb;
  v_sender  text;
begin
  select t.channel_sender into v_sender from public.nexo_sd_tickets t where t.id = p_ticket;
  v_payload := coalesce(nexo_private.sd_ticket_payload(p_ticket), '{}'::jsonb)
            || jsonb_build_object('remitente', coalesce(v_sender, 'desconocido'));
  for v_user in select distinct u from nexo_private.sd_oncall_users(1, now()) as u loop
    perform nexo_private.sd_enqueue_user(
      v_user, array['push', 'email'], 'sd_ticket_cuarentena', v_payload, p_ticket,
      'ticket:' || p_ticket::text || ':cuarentena', 3);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Incidentes de seguridad
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_ensure_security_incident(p_ticket uuid, p_detected_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.nexo_sd_security_incidents (ticket_id, org_id, title, description, detected_at, created_by)
  select t.id, t.org_id, t.title, nullif(t.description, ''), coalesce(p_detected_at, now()), auth.uid()
  from public.nexo_sd_tickets t
  where t.id = p_ticket
  on conflict (ticket_id) do nothing;
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
        then 'Incidente de seguridad registrado (Ley 21.663): se avisó al nivel 3 y a supervisión.'
        else format('Ley 21.663: %s al %s %% del plazo (vence %s).', v_label, p_level,
                    to_char(p_due at time zone (nexo_private.sd_settings()).timezone, 'DD-MM-YYYY HH24:MI'))
      end,
      jsonb_build_object('incidente_id', v_incident.id, 'hito', p_milestone, 'umbral', p_level, 'mensajes', v_count),
      null, coalesce(p_at, now()));
  end if;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tickets: triggers
-- -----------------------------------------------------------------------------
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
    else
      if not nexo_private.sd_has_org_role(new.org_id, array['reportante', 'contraparte']) then
        raise exception 'nexo_sd: solo los miembros de la organización pueden crear tickets en ella'
          using errcode = '42501';
      end if;
      new.reporter_id := v_uid;
      new.channel := 'web';
      new.assignee_id := null;
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

  if new.intake_status = 'aceptado' then
    new.sla_started_at := coalesce(new.sla_started_at, new.created_at);
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
    case when new.intake_status = 'cuarentena'
      then 'Mensaje de un remitente no registrado: queda en cuarentena hasta que un agente lo revise.'
      else 'Ticket recibido.'
    end,
    jsonb_build_object('de', null, 'a', new.status, 'severidad', new.severity, 'regla', new.classification_rule,
                       'origen_clasificacion', new.classification_source, 'canal', new.channel),
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

create or replace function nexo_private.sd_tickets_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_priv     boolean := nexo_private.sd_is_privileged();
  v_old_rank int;
  v_new_rank int;
  v_sev      text;
  v_rule     text;
begin
  if not v_priv then
    if not nexo_private.sd_is_staff() then
      raise exception 'nexo_sd: solo los agentes y supervisores de Yago modifican tickets' using errcode = '42501';
    end if;
    if new.number is distinct from old.number
       or new.org_id is distinct from old.org_id
       or new.severity is distinct from old.severity
       or new.classification_answers is distinct from old.classification_answers
       or new.classification_rule is distinct from old.classification_rule
       or new.classification_source is distinct from old.classification_source
       or new.intake_status is distinct from old.intake_status
       or new.channel is distinct from old.channel
       or new.channel_sender is distinct from old.channel_sender
       or new.external_ref is distinct from old.external_ref
       or new.reporter_id is distinct from old.reporter_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or new.escalation_level is distinct from old.escalation_level
       or new.last_escalated_at is distinct from old.last_escalated_at
       or new.sla_started_at is distinct from old.sla_started_at
       or new.acknowledged_at is distinct from old.acknowledged_at
       or new.diagnosed_at is distinct from old.diagnosed_at
       or new.workaround_at is distinct from old.workaround_at
       or new.resolved_at is distinct from old.resolved_at
       or new.closed_at is distinct from old.closed_at then
      raise exception 'nexo_sd: ese dato se cambia con las acciones de la mesa (reclasificar, aceptar o escalar)'
        using errcode = '42501';
    end if;
    if new.assignee_id is distinct from old.assignee_id and new.assignee_id is not null
       and not nexo_private.sd_user_is_staff(new.assignee_id) then
      raise exception 'nexo_sd: el responsable debe ser un agente o supervisor de Yago' using errcode = '23514';
    end if;
  end if;

  -- Reclasificación: la severidad siempre sale de las respuestas del asistente.
  if new.classification_answers is distinct from old.classification_answers then
    if new.classification_answers is null then
      raise exception 'nexo_sd: no se pueden borrar las respuestas del asistente' using errcode = '23514';
    end if;
    select c.severity, c.rule into v_sev, v_rule from nexo_private.sd_classify_answers(new.classification_answers) c;
    new.severity := v_sev;
    new.classification_rule := v_rule;
    new.classification_source := case when old.intake_status = 'cuarentena' then 'asistente' else 'reclasificacion' end;
  elsif new.severity is distinct from old.severity then
    raise exception 'nexo_sd: la severidad se calcula desde las respuestas del asistente' using errcode = '23514';
  end if;

  -- Cuarentena: aceptar inicia el SLA en ese momento; descartar cierra el ticket.
  if old.intake_status = 'cuarentena' and new.intake_status = 'aceptado' then
    if new.org_id is null then
      raise exception 'nexo_sd: asigne la organización antes de aceptar el ticket' using errcode = '23514';
    end if;
    new.sla_started_at := now();
    new.escalation_level := 1;
    new.last_escalated_at := new.sla_started_at;
  elsif new.intake_status = 'descartado' and old.intake_status is distinct from 'descartado' then
    if old.intake_status <> 'cuarentena' then
      raise exception 'nexo_sd: solo se descartan mensajes en cuarentena' using errcode = '23514';
    end if;
    new.status := 'cerrado';
  elsif new.intake_status is distinct from old.intake_status then
    raise exception 'nexo_sd: cambio de admisión no permitido (% a %)', old.intake_status, new.intake_status
      using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    if new.intake_status <> 'aceptado' and not (new.intake_status = 'descartado' and new.status = 'cerrado') then
      raise exception 'nexo_sd: acepte el ticket en cuarentena antes de cambiar su estado' using errcode = '23514';
    end if;
    if old.status = 'cerrado' then
      raise exception 'nexo_sd: un ticket cerrado no cambia de estado' using errcode = '23514';
    end if;
    if new.status = 'nuevo' then
      raise exception 'nexo_sd: un ticket no vuelve al estado nuevo' using errcode = '23514';
    end if;
    if new.status = 'cerrado' and old.status <> 'resuelto' and new.intake_status <> 'descartado' then
      raise exception 'nexo_sd: solo se cierra un ticket resuelto' using errcode = '23514';
    end if;
    v_old_rank := nexo_private.sd_status_rank(old.status);
    v_new_rank := nexo_private.sd_status_rank(new.status);
    if v_new_rank < v_old_rank
       and not (new.status = 'en_diagnostico' and old.status in ('solucion_temporal', 'resuelto')) then
      raise exception 'nexo_sd: transición de estado no permitida (% a %)', old.status, new.status
        using errcode = '23514';
    end if;
    if new.intake_status = 'aceptado' then
      if v_new_rank >= 1 and new.acknowledged_at is null then
        new.acknowledged_at := now();
      end if;
      if v_new_rank >= 2 and new.diagnosed_at is null then
        new.diagnosed_at := now();
      end if;
      if new.status = 'solucion_temporal' and new.workaround_at is null then
        new.workaround_at := now();
      end if;
      if v_new_rank >= 4 and new.resolved_at is null then
        new.resolved_at := now();
      end if;
    end if;
    if new.status = 'cerrado' and new.closed_at is null then
      new.closed_at := now();
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function nexo_private.sd_tickets_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if old.intake_status = 'cuarentena' and new.intake_status = 'aceptado' then
    perform nexo_private.sd_add_event(
      new.id, 'status_change', 'publico', 'Ticket aceptado desde la cuarentena: desde ahora corre el SLA.',
      jsonb_build_object('admision', 'aceptado', 'severidad', new.severity), v_actor, now());
    perform nexo_private.sd_activate_ticket(new.id);
  elsif old.intake_status = 'cuarentena' and new.intake_status = 'descartado' then
    perform nexo_private.sd_add_event(
      new.id, 'status_change', 'interno', 'Mensaje en cuarentena descartado.',
      jsonb_build_object('admision', 'descartado'), v_actor, now());
  end if;

  if new.status is distinct from old.status and new.intake_status = 'aceptado' then
    perform nexo_private.sd_add_event(
      new.id, 'status_change', 'publico', null, jsonb_build_object('de', old.status, 'a', new.status), v_actor, now());
    perform nexo_private.sd_mark_clocks_met(new.id);
    if new.status in ('resuelto', 'cerrado') then
      update public.nexo_sd_clock_pauses p
         set ended_at = now(), ended_by = v_actor
       where p.ticket_id = new.id and p.ended_at is null;
    end if;
    if old.acknowledged_at is null and new.acknowledged_at is not null then
      perform nexo_private.sd_notify_reporter(new.id, 'sd_ticket_acusado', 'ticket:' || new.id::text || ':acusado');
    end if;
    if new.status = 'resuelto' then
      perform nexo_private.sd_notify_reporter(
        new.id, 'sd_ticket_resuelto', 'ticket:' || new.id::text || ':resuelto:' || extract(epoch from now())::bigint::text);
    end if;
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    perform nexo_private.sd_add_event(
      new.id, 'assignment', 'publico', null,
      jsonb_build_object('responsable', new.assignee_id, 'nombre', nexo_private.sd_display_name(new.assignee_id)),
      v_actor, now());
    if new.assignee_id is not null and new.assignee_id is distinct from v_actor then
      perform nexo_private.sd_enqueue_user(
        new.assignee_id, array['push', 'email'], 'sd_ticket_asignado', nexo_private.sd_ticket_payload(new.id), new.id,
        'ticket:' || new.id::text || ':asignado:' || extract(epoch from now())::bigint::text,
        nexo_private.sd_priority_for(new.severity));
    end if;
  end if;

  if (new.severity is distinct from old.severity or new.classification_answers is distinct from old.classification_answers)
     and new.intake_status = 'aceptado' and old.intake_status = 'aceptado' then
    perform nexo_private.sd_add_event(
      new.id, 'reclassification', 'publico', null,
      jsonb_build_object('de', old.severity, 'a', new.severity, 'regla', new.classification_rule), v_actor, now());
    perform nexo_private.sd_rebuild_clocks(new.id, now());
  end if;

  if new.is_security_incident and not old.is_security_incident and new.intake_status = 'aceptado' then
    perform nexo_private.sd_ensure_security_incident(new.id, now());
  end if;
  return null;
end;
$$;

create or replace trigger nexo_sd_tickets_before_insert
  before insert on public.nexo_sd_tickets
  for each row execute function nexo_private.sd_tickets_before_insert();
create or replace trigger nexo_sd_tickets_after_insert
  after insert on public.nexo_sd_tickets
  for each row execute function nexo_private.sd_tickets_after_insert();
create or replace trigger nexo_sd_tickets_before_update
  before update on public.nexo_sd_tickets
  for each row execute function nexo_private.sd_tickets_before_update();
create or replace trigger nexo_sd_tickets_after_update
  after update on public.nexo_sd_tickets
  for each row execute function nexo_private.sd_tickets_after_update();

-- -----------------------------------------------------------------------------
-- Línea de tiempo: validación de lo que escribe la API (comentarios y adjuntos).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_events_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_path   text;
begin
  if nexo_private.sd_is_privileged() then
    new.author_name := coalesce(new.author_name, nexo_private.sd_display_name(new.author_id), 'Sistema');
    return new;
  end if;

  if new.type not in ('comment', 'attachment') then
    raise exception 'nexo_sd: desde la aplicación solo se agregan comentarios y adjuntos' using errcode = '42501';
  end if;
  if new.visibility = 'interno' and not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: las notas internas son solo para agentes y supervisores' using errcode = '42501';
  end if;
  select t.status into v_status from public.nexo_sd_tickets t where t.id = new.ticket_id;
  if v_status = 'cerrado' and not nexo_private.sd_is_staff() then
    raise exception 'nexo_sd: el ticket está cerrado' using errcode = '23514';
  end if;
  if new.type = 'comment' and coalesce(btrim(new.body), '') = '' then
    raise exception 'nexo_sd: el comentario está vacío' using errcode = '23514';
  end if;
  if new.type = 'attachment' then
    v_path := new.payload ->> 'path';
    if v_path is null
       or v_path not like 'tickets/' || new.ticket_id::text || '/' || new.visibility || '/%'
       or v_path like '%..%' then
      raise exception 'nexo_sd: la ruta del adjunto no corresponde al ticket' using errcode = '23514';
    end if;
  end if;

  new.author_id := auth.uid();
  new.author_name := coalesce(nexo_private.sd_display_name(new.author_id), 'Usuario');
  new.created_at := now();
  return new;
end;
$$;

create or replace trigger nexo_sd_ticket_events_before_insert
  before insert on public.nexo_sd_ticket_events
  for each row execute function nexo_private.sd_events_before_insert();

-- -----------------------------------------------------------------------------
-- Pausas
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_pauses_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_intake text;
begin
  if not nexo_private.sd_is_privileged() then
    raise exception 'nexo_sd: las pausas se registran con nexo_sd_pause_ticket' using errcode = '42501';
  end if;
  select t.status, t.intake_status into v_status, v_intake from public.nexo_sd_tickets t where t.id = new.ticket_id;
  if not found or v_intake <> 'aceptado' then
    raise exception 'nexo_sd: el ticket no admite pausas' using errcode = '23514';
  end if;
  if v_status in ('resuelto', 'cerrado') then
    raise exception 'nexo_sd: no se pausa un ticket resuelto o cerrado' using errcode = '23514';
  end if;
  if new.ended_at is not null then
    raise exception 'nexo_sd: una pausa se abre y luego se cierra' using errcode = '23514';
  end if;
  new.started_at := coalesce(new.started_at, now());
  new.created_at := now();
  return new;
end;
$$;

create or replace function nexo_private.sd_pauses_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not nexo_private.sd_is_privileged() then
    raise exception 'nexo_sd: las pausas se gestionan con las funciones de la mesa' using errcode = '42501';
  end if;
  if new.ticket_id is distinct from old.ticket_id or new.reason is distinct from old.reason
     or new.started_at is distinct from old.started_at or new.created_by is distinct from old.created_by
     or new.justification is distinct from old.justification
     or new.remote_access_request_id is distinct from old.remote_access_request_id then
    raise exception 'nexo_sd: los datos de una pausa no se modifican' using errcode = '23514';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'nexo_sd: la pausa ya está cerrada' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function nexo_private.sd_pauses_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c         public.nexo_sd_sla_clocks;
  v_elapsed numeric;
  v_labels  jsonb := jsonb_build_object(
    'infraestructura_cliente', 'infraestructura del cliente', 'red', 'red', 'terceros', 'terceros',
    'decision_cliente', 'decisión del cliente', 'acceso_remoto_pendiente', 'acceso remoto pendiente');
begin
  for c in
    select k.* from public.nexo_sd_sla_clocks k
    where k.ticket_id = new.ticket_id and k.status = 'en_curso' and k.target_minutes is not null and k.met_at is null
    for update
  loop
    -- Si el plazo ya venció antes de la pausa, el reloj sigue y sd_tick registra el incumplimiento.
    continue when c.due_at <= new.started_at;
    v_elapsed := nexo_private.sd_calendar_seconds(c.calendar, c.started_at, new.started_at) - c.paused_seconds;
    update public.nexo_sd_sla_clocks k
       set status = 'pausado',
           paused_since = new.started_at,
           remaining_seconds_at_pause = greatest(c.target_minutes * 60 - v_elapsed, 0)
     where k.id = c.id;
  end loop;

  perform nexo_private.sd_add_event(
    new.ticket_id, 'pause', 'publico', new.justification,
    jsonb_build_object('pausa_id', new.id, 'motivo', new.reason, 'motivo_texto', v_labels ->> new.reason,
                       'inicio', new.started_at),
    new.created_by, new.started_at);

  if new.reason <> 'acceso_remoto_pendiente' then
    perform nexo_private.sd_notify_org_roles(
      new.ticket_id, array['contraparte'], array['push', 'email'], 'sd_pausa_iniciada',
      jsonb_build_object('pausa_id', new.id, 'motivo', v_labels ->> new.reason, 'justificacion', new.justification),
      'pause:' || new.id::text);
  end if;
  return null;
end;
$$;

create or replace function nexo_private.sd_pauses_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c        public.nexo_sd_sla_clocks;
  v_paused numeric;
begin
  if old.ended_at is null and new.ended_at is not null then
    for c in
      select k.* from public.nexo_sd_sla_clocks k
      where k.ticket_id = new.ticket_id and k.status = 'pausado'
      for update
    loop
      v_paused := c.paused_seconds
                + nexo_private.sd_calendar_seconds(c.calendar, coalesce(c.paused_since, new.started_at), new.ended_at);
      update public.nexo_sd_sla_clocks k
         set status = 'en_curso',
             paused_seconds = v_paused,
             paused_since = null,
             remaining_seconds_at_pause = null,
             due_at = nexo_private.sd_clock_due(c.calendar, c.started_at, c.target_minutes, v_paused)
       where k.id = c.id;
    end loop;
    perform nexo_private.sd_add_event(
      new.ticket_id, 'resume', 'publico', null,
      jsonb_build_object('pausa_id', new.id, 'motivo', new.reason, 'inicio', new.started_at, 'fin', new.ended_at,
                         'duracion_segundos', round(extract(epoch from (new.ended_at - new.started_at)))),
      new.ended_by, new.ended_at);
  end if;

  if new.client_ack_at is not null and old.client_ack_at is null then
    perform nexo_private.sd_add_event(
      new.ticket_id, 'pause', 'publico', new.client_ack_note,
      jsonb_build_object('pausa_id', new.id, 'acuse_cliente', new.client_ack_status), new.client_ack_by, new.client_ack_at);
  end if;
  return null;
end;
$$;

create or replace trigger nexo_sd_clock_pauses_before_insert
  before insert on public.nexo_sd_clock_pauses
  for each row execute function nexo_private.sd_pauses_before_insert();
create or replace trigger nexo_sd_clock_pauses_before_update
  before update on public.nexo_sd_clock_pauses
  for each row execute function nexo_private.sd_pauses_before_update();
create or replace trigger nexo_sd_clock_pauses_after_insert
  after insert on public.nexo_sd_clock_pauses
  for each row execute function nexo_private.sd_pauses_after_insert();
create or replace trigger nexo_sd_clock_pauses_after_update
  after update on public.nexo_sd_clock_pauses
  for each row execute function nexo_private.sd_pauses_after_update();

-- -----------------------------------------------------------------------------
-- Acceso remoto (BT-065): solicitar pausa el reloj automáticamente; habilitar, rechazar o
-- revocar una solicitud pendiente cierra esa pausa.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_remote_access_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_intake text;
begin
  if not nexo_private.sd_is_privileged() then
    raise exception 'nexo_sd: el acceso remoto se solicita con nexo_sd_request_remote_access' using errcode = '42501';
  end if;
  select t.status, t.intake_status into v_status, v_intake from public.nexo_sd_tickets t where t.id = new.ticket_id;
  if not found or v_intake <> 'aceptado' or v_status in ('resuelto', 'cerrado') then
    raise exception 'nexo_sd: el ticket no admite solicitudes de acceso remoto' using errcode = '23514';
  end if;
  new.status := 'pendiente';
  new.requested_at := coalesce(new.requested_at, now());
  new.decided_at := null;
  new.decided_by := null;
  new.enabled_at := null;
  new.revoked_at := null;
  new.pause_id := null;
  return new;
end;
$$;

create or replace function nexo_private.sd_remote_access_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not nexo_private.sd_is_privileged() then
    raise exception 'nexo_sd: el acceso remoto se gestiona con las funciones de la mesa' using errcode = '42501';
  end if;
  if new.ticket_id is distinct from old.ticket_id or new.scope is distinct from old.scope
     or new.requested_at is distinct from old.requested_at or new.requested_by is distinct from old.requested_by then
    raise exception 'nexo_sd: los datos de la solicitud no se modifican' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pendiente' and new.status in ('habilitado', 'rechazado', 'revocado'))
            or (old.status = 'habilitado' and new.status = 'revocado')) then
      raise exception 'nexo_sd: transición de acceso remoto no permitida (% a %)', old.status, new.status
        using errcode = '23514';
    end if;
    if new.status in ('habilitado', 'rechazado') then
      new.decided_at := coalesce(new.decided_at, now());
    end if;
    if new.status = 'habilitado' then
      new.enabled_at := coalesce(new.enabled_at, new.decided_at);
    end if;
    if new.status = 'revocado' then
      new.revoked_at := coalesce(new.revoked_at, now());
    end if;
  end if;
  return new;
end;
$$;

create or replace function nexo_private.sd_remote_access_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pause uuid;
begin
  -- Si había una pausa abierta, se cierra en este instante y se abre la pausa automática
  -- (las pausas nunca se superponen).
  update public.nexo_sd_clock_pauses p
     set ended_at = new.requested_at, ended_by = new.requested_by
   where p.ticket_id = new.ticket_id and p.ended_at is null;

  insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at, created_by, remote_access_request_id)
  values (new.ticket_id, 'acceso_remoto_pendiente',
          'Acceso remoto solicitado, pendiente de habilitación por el cliente. Alcance: ' || new.scope,
          new.requested_at, new.requested_by, new.id)
  returning id into v_pause;

  update public.nexo_sd_remote_access_requests r set pause_id = v_pause where r.id = new.id;

  perform nexo_private.sd_add_event(
    new.ticket_id, 'remote_access', 'publico', new.justification,
    jsonb_build_object('solicitud_id', new.id, 'estado', 'pendiente', 'alcance', new.scope, 'pausa_id', v_pause),
    new.requested_by, new.requested_at);

  perform nexo_private.sd_notify_org_roles(
    new.ticket_id, array['contraparte'], array['push', 'whatsapp', 'email'], 'sd_acceso_remoto_solicitado',
    jsonb_build_object('solicitud_id', new.id, 'alcance', new.scope), 'remote:' || new.id::text || ':solicitado');
  return null;
end;
$$;

create or replace function nexo_private.sd_remote_access_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_when  timestamptz;
  v_actor uuid;
begin
  if new.status is distinct from old.status then
    v_when := case when new.status = 'revocado' then new.revoked_at else new.decided_at end;
    v_actor := case when new.status = 'revocado' then new.revoked_by else new.decided_by end;
    if old.status = 'pendiente' and new.pause_id is not null then
      update public.nexo_sd_clock_pauses p
         set ended_at = greatest(coalesce(v_when, now()), p.started_at), ended_by = v_actor
       where p.id = new.pause_id and p.ended_at is null;
    end if;
    perform nexo_private.sd_add_event(
      new.ticket_id, 'remote_access', 'publico', coalesce(new.decision_note, new.session_log_ref),
      jsonb_build_object('solicitud_id', new.id, 'estado', new.status, 'registro_sesion', new.session_log_ref),
      v_actor, coalesce(v_when, now()));
    if new.requested_by is not null then
      perform nexo_private.sd_enqueue_user(
        new.requested_by, array['push', 'email'], 'sd_acceso_remoto_resuelto',
        nexo_private.sd_ticket_payload(new.ticket_id)
          || jsonb_build_object('solicitud_id', new.id, 'estado', new.status),
        new.ticket_id, 'remote:' || new.id::text || ':' || new.status, 2);
    end if;
  end if;
  return null;
end;
$$;

create or replace trigger nexo_sd_remote_access_before_insert
  before insert on public.nexo_sd_remote_access_requests
  for each row execute function nexo_private.sd_remote_access_before_insert();
create or replace trigger nexo_sd_remote_access_before_update
  before update on public.nexo_sd_remote_access_requests
  for each row execute function nexo_private.sd_remote_access_before_update();
create or replace trigger nexo_sd_remote_access_after_insert
  after insert on public.nexo_sd_remote_access_requests
  for each row execute function nexo_private.sd_remote_access_after_insert();
create or replace trigger nexo_sd_remote_access_after_update
  after update on public.nexo_sd_remote_access_requests
  for each row execute function nexo_private.sd_remote_access_after_update();

-- -----------------------------------------------------------------------------
-- Incidentes de seguridad: plazos desde la configuración (copiados en la fila).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_incidents_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_priv boolean := nexo_private.sd_is_privileged();
  v_cfg  public.nexo_sd_settings;
begin
  if tg_op = 'INSERT' then
    v_cfg := nexo_private.sd_settings();
    if not v_priv then
      if not nexo_private.sd_is_staff() then
        raise exception 'nexo_sd: solo agentes y supervisores registran incidentes' using errcode = '42501';
      end if;
      new.created_by := auth.uid();
      new.created_at := now();
      new.status := 'abierto';
      new.closed_at := null;
      new.early_alert_hours := null;
      new.second_report_hours := null;
      new.final_report_days := null;
    end if;
    new.early_alert_hours := coalesce(new.early_alert_hours, v_cfg.security_early_alert_hours);
    new.second_report_hours := coalesce(new.second_report_hours, v_cfg.security_second_report_hours);
    new.final_report_days := coalesce(new.final_report_days, v_cfg.security_final_report_days);
    if new.ticket_id is not null and new.org_id is null then
      select t.org_id into new.org_id from public.nexo_sd_tickets t where t.id = new.ticket_id;
    end if;
  else
    if not v_priv and (new.early_alert_hours is distinct from old.early_alert_hours
                       or new.second_report_hours is distinct from old.second_report_hours
                       or new.final_report_days is distinct from old.final_report_days
                       or new.ticket_id is distinct from old.ticket_id
                       or new.created_by is distinct from old.created_by) then
      raise exception 'nexo_sd: los plazos del incidente se fijan al crearlo' using errcode = '42501';
    end if;
    if new.status = 'cerrado' and old.status <> 'cerrado' then
      new.closed_at := now();
    elsif new.status = 'abierto' then
      new.closed_at := null;
    end if;
  end if;

  new.early_alert_due_at := new.detected_at + make_interval(secs => (new.early_alert_hours * 3600)::double precision);
  new.second_report_due_at := new.detected_at + make_interval(secs => (new.second_report_hours * 3600)::double precision);
  -- El informe final se cuenta desde el envío de la alerta temprana (art. 9 Ley 21.663).
  new.final_report_due_at := coalesce(new.early_alert_sent_at, new.detected_at)
                             + make_interval(secs => (new.final_report_days * 86400)::double precision);
  return new;
end;
$$;

create or replace function nexo_private.sd_incidents_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.ticket_id is not null then
    update public.nexo_sd_tickets t set is_security_incident = true
     where t.id = new.ticket_id and not t.is_security_incident;
  end if;
  perform nexo_private.sd_notify_incident(new.id, 'deteccion', 0, new.early_alert_due_at, now());
  return null;
end;
$$;

create or replace trigger nexo_sd_security_incidents_before_write
  before insert or update on public.nexo_sd_security_incidents
  for each row execute function nexo_private.sd_incidents_before_write();
create or replace trigger nexo_sd_security_incidents_after_insert
  after insert on public.nexo_sd_security_incidents
  for each row execute function nexo_private.sd_incidents_after_insert();

-- -----------------------------------------------------------------------------
-- Turnos, RCA y paquetes de corrección
-- -----------------------------------------------------------------------------
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
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

create or replace trigger nexo_sd_oncall_shifts_validate
  before insert or update on public.nexo_sd_oncall_shifts
  for each row execute function nexo_private.sd_oncall_validate();

create or replace function nexo_private.sd_rca_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select t.org_id into new.org_id from public.nexo_sd_tickets t where t.id = new.ticket_id;
    if new.org_id is null then
      raise exception 'nexo_sd: el ticket del RCA no existe o no tiene organización' using errcode = '23514';
    end if;
    if not nexo_private.sd_is_privileged() then
      new.author_id := auth.uid();
    end if;
  elsif new.ticket_id is distinct from old.ticket_id or new.org_id is distinct from old.org_id then
    raise exception 'nexo_sd: el RCA no cambia de ticket' using errcode = '23514';
  end if;
  if new.status = 'publicado' and (tg_op = 'INSERT' or old.status <> 'publicado') then
    new.published_at := now();
  elsif new.status = 'borrador' then
    new.published_at := null;
  end if;
  return new;
end;
$$;

create or replace trigger nexo_sd_rca_reports_before_write
  before insert or update on public.nexo_sd_rca_reports
  for each row execute function nexo_private.sd_rca_before_write();

create or replace function nexo_private.sd_patches_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_priv boolean := nexo_private.sd_is_privileged();
begin
  if tg_op = 'INSERT' then
    if not v_priv then
      new.created_by := auth.uid();
      if new.status not in ('borrador', 'pendiente_aprobacion') then
        new.status := 'borrador';
      end if;
      new.approved_by := null;
      new.approved_at := null;
      new.approval_note := null;
      new.applied_by := null;
      new.applied_at := null;
      new.rolled_back_at := null;
    end if;
    return new;
  end if;

  if not v_priv then
    if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
       or new.approval_note is distinct from old.approval_note or new.created_by is distinct from old.created_by then
      raise exception 'nexo_sd: la aprobación se registra con nexo_sd_decide_patch' using errcode = '42501';
    end if;
    if old.status <> 'borrador' and (new.org_id is distinct from old.org_id or new.version is distinct from old.version
                                     or new.rollback_plan is distinct from old.rollback_plan) then
      raise exception 'nexo_sd: versión, organización y plan de reversa se fijan antes de pedir aprobación'
        using errcode = '23514';
    end if;
    if new.status is distinct from old.status
       and not ((old.status = 'borrador' and new.status = 'pendiente_aprobacion')
                or (old.status = 'pendiente_aprobacion' and new.status = 'borrador')
                or (old.status = 'rechazado' and new.status = 'borrador')
                or (old.status = 'aprobado' and new.status = 'aplicado')
                or (old.status = 'aplicado' and new.status = 'revertido')) then
      raise exception 'nexo_sd: transición del paquete no permitida (% a %)', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  if new.status = 'aplicado' and old.status <> 'aplicado' then
    new.applied_at := coalesce(new.applied_at, now());
    new.applied_by := coalesce(new.applied_by, auth.uid());
  end if;
  if new.status = 'revertido' and old.status <> 'revertido' then
    new.rolled_back_at := now();
  end if;
  return new;
end;
$$;

create or replace trigger nexo_sd_patch_packages_before_write
  before insert or update on public.nexo_sd_patch_packages
  for each row execute function nexo_private.sd_patches_before_write();

-- -----------------------------------------------------------------------------
-- sd_tick(): se ejecuta cada minuto (pg_cron). Recibe el instante para poder probarlo.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c             public.nexo_sd_sla_clocks;
  v_ticket      public.nexo_sd_tickets;
  v_cfg         public.nexo_sd_settings;
  r             record;
  v_elapsed     numeric;
  v_pct         numeric;
  v_level       int;
  v_msgs        int;
  v_label       text;
  v_checked     int := 0;
  v_breached    int := 0;
  v_thresholds  int := 0;
  v_escalations int := 0;
  v_incidents   int := 0;
begin
  v_cfg := nexo_private.sd_settings();

  -- 1) Umbrales 50 / 80 / 100 % de cada reloj en curso. Si se saltó un umbral (por ejemplo,
  --    el cron estuvo detenido), solo se avisa el más alto alcanzado.
  for c in
    select k.* from public.nexo_sd_sla_clocks k
    where k.status = 'en_curso' and k.target_minutes is not null and k.met_at is null
    order by k.due_at
    for update skip locked
  loop
    v_checked := v_checked + 1;
    v_elapsed := nexo_private.sd_clock_elapsed(c, p_now);
    v_pct := v_elapsed / (c.target_minutes * 60.0);
    v_level := case
      when p_now >= c.due_at then 100
      when v_pct >= 0.8 then 80
      when v_pct >= 0.5 then 50
      else 0
    end;
    continue when v_level = 0
      or (v_level = 80 and c.notified_80_at is not null)
      or (v_level = 50 and c.notified_50_at is not null);

    select t.* into v_ticket from public.nexo_sd_tickets t where t.id = c.ticket_id;
    v_label := case c.metric when 'acuse' then 'acuse' when 'diagnostico' then 'diagnóstico' else 'solución' end;

    if v_level = 100 then
      update public.nexo_sd_sla_clocks k
         set status = 'incumplido',
             breached_at = c.due_at,
             notified_100_at = p_now,
             notified_80_at = coalesce(k.notified_80_at, p_now),
             notified_50_at = coalesce(k.notified_50_at, p_now)
       where k.id = c.id;
      v_breached := v_breached + 1;
      v_msgs := nexo_private.sd_notify_levels(
        c.ticket_id, array[1, 2, 3], 'sd_sla_vencido',
        jsonb_build_object('metrica', c.metric, 'metrica_texto', v_label, 'umbral', 100, 'vence', c.due_at),
        'clock:' || c.id::text || ':100', true, p_now, 1, true);
      perform nexo_private.sd_add_event(
        c.ticket_id, 'escalation', 'interno',
        format('Venció el plazo de %s (%s). Aviso a los niveles 1, 2 y 3 del turno.', v_label, v_ticket.severity),
        jsonb_build_object('metrica', c.metric, 'umbral', 100, 'vencia', c.due_at, 'mensajes', v_msgs),
        null, p_now);
    else
      update public.nexo_sd_sla_clocks k
         set notified_80_at = case when v_level = 80 then p_now else k.notified_80_at end,
             notified_50_at = coalesce(k.notified_50_at, p_now)
       where k.id = c.id;
      v_thresholds := v_thresholds + 1;
      v_msgs := nexo_private.sd_notify_levels(
        c.ticket_id, case when v_level = 80 then array[1, 2] else array[1] end, 'sd_sla_umbral',
        jsonb_build_object('metrica', c.metric, 'metrica_texto', v_label, 'umbral', v_level, 'vence', c.due_at),
        'clock:' || c.id::text || ':' || v_level::text, false, p_now,
        nexo_private.sd_priority_for(v_ticket.severity), true);
      perform nexo_private.sd_add_event(
        c.ticket_id, 'escalation', 'interno',
        format('Se alcanzó el %s %% del plazo de %s (%s).', v_level, v_label, v_ticket.severity),
        jsonb_build_object('metrica', c.metric, 'umbral', v_level, 'vence', c.due_at, 'mensajes', v_msgs),
        null, p_now);
    end if;
  end loop;

  -- 2) S1 sin acuse: cada s1_ack_escalation_minutes se sube un nivel (1 -> 2 -> 3), con voz.
  for v_ticket in
    select t.* from public.nexo_sd_tickets t
    where t.severity = 'S1'
      and t.intake_status = 'aceptado'
      and t.status = 'nuevo'
      and t.acknowledged_at is null
      and t.escalation_level between 1 and 2
      and t.last_escalated_at <= p_now - make_interval(mins => v_cfg.s1_ack_escalation_minutes)
      and not exists (
        select 1 from public.nexo_sd_sla_clocks k
        where k.ticket_id = t.id and k.metric = 'acuse' and k.status = 'pausado')
    for update of t skip locked
  loop
    update public.nexo_sd_tickets t
       set escalation_level = v_ticket.escalation_level + 1, last_escalated_at = p_now
     where t.id = v_ticket.id;
    v_msgs := nexo_private.sd_notify_levels(
      v_ticket.id, array[v_ticket.escalation_level + 1], 'sd_escalamiento_acuse',
      jsonb_build_object('nivel', v_ticket.escalation_level + 1,
                         'minutos', round(extract(epoch from (p_now - v_ticket.sla_started_at)) / 60)),
      'ticket:' || v_ticket.id::text || ':acuse_nivel_' || (v_ticket.escalation_level + 1)::text,
      true, p_now, 1, false);
    perform nexo_private.sd_add_event(
      v_ticket.id, 'escalation', 'interno',
      format('S1 sin acuse: se escala al nivel %s del turno.', v_ticket.escalation_level + 1),
      jsonb_build_object('nivel', v_ticket.escalation_level + 1, 'mensajes', v_msgs, 'motivo', 'sin_acuse'),
      null, p_now);
    v_escalations := v_escalations + 1;
  end loop;

  -- 3) Hitos de la Ley 21.663 de incidentes abiertos (los avisos no se repiten: dedup_key).
  for r in
    select i.id, m.milestone, m.due_at, m.window_start
    from public.nexo_sd_security_incidents i
    cross join lateral (values
      ('alerta_temprana', i.early_alert_due_at, i.detected_at, i.early_alert_sent_at),
      ('segundo_reporte', i.second_report_due_at, i.detected_at, i.second_report_at),
      ('informe_final', i.final_report_due_at, coalesce(i.early_alert_sent_at, i.detected_at), i.final_report_at)
    ) as m(milestone, due_at, window_start, done_at)
    where i.status = 'abierto'
      and i.classification <> 'no_significativo'
      and m.done_at is null
      and m.due_at is not null
  loop
    v_pct := extract(epoch from (p_now - r.window_start)) / nullif(extract(epoch from (r.due_at - r.window_start)), 0);
    v_level := case
      when p_now >= r.due_at then 100
      when v_pct >= 0.8 then 80
      when v_pct >= 0.5 then 50
      else 0
    end;
    continue when v_level = 0;
    if nexo_private.sd_notify_incident(r.id, r.milestone, v_level, r.due_at, p_now) > 0 then
      v_incidents := v_incidents + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'instante', p_now, 'relojes_revisados', v_checked, 'umbrales', v_thresholds, 'vencidos', v_breached,
    'escalamientos_s1', v_escalations, 'avisos_incidentes', v_incidents);
end;
$$;
comment on function nexo_private.sd_tick(timestamptz) is
  'Mesa de soporte Nexo: vencimientos, avisos al 50/80/100 %, escalamiento S1 sin acuse y plazos de la Ley 21.663. pg_cron: nexo_sd_sla_tick.';
