-- Mesa de soporte Nexo · nombres neutros para el cliente.
--
-- La mesa atiende a cualquier organización cliente: el acuse de pausas pasa a client_ack_* y los motivos
-- tipificados a infraestructura_cliente y decision_cliente. Las migraciones base ya usan estos nombres; esta
-- migración lleva a los mismos nombres una base creada con la versión anterior. Es idempotente.

do $do$
declare
  v_viejo text := 'subtel';  -- prefijo de la versión anterior
  c text;
begin
  foreach c in array array['status', 'by', 'at', 'note'] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'nexo_sd_clock_pauses'
                  and column_name = v_viejo || '_ack_' || c) then
      execute format('alter table public.nexo_sd_clock_pauses rename column %I to %I',
                     v_viejo || '_ack_' || c, 'client_ack_' || c);
    end if;
  end loop;
  for c in select conname from pg_catalog.pg_constraint
            where conrelid = 'public.nexo_sd_clock_pauses'::regclass and conname like '%\_' || v_viejo || '\_ack\_%' loop
    execute format('alter table public.nexo_sd_clock_pauses rename constraint %I to %I',
                   c, replace(c, '_' || v_viejo || '_ack_', '_client_ack_'));
  end loop;

  alter table public.nexo_sd_clock_pauses drop constraint if exists nexo_sd_clock_pauses_reason_check;
  -- Las pausas son inmutables (sd_pauses_before_update); solo el renombre del motivo pasa, sin disparar efectos.
  if exists (select 1 from public.nexo_sd_clock_pauses where reason in ('infraestructura_' || v_viejo, 'decision_' || v_viejo)) then
    alter table public.nexo_sd_clock_pauses disable trigger nexo_sd_clock_pauses_before_update;
    alter table public.nexo_sd_clock_pauses disable trigger nexo_sd_clock_pauses_after_update;
    update public.nexo_sd_clock_pauses set reason = 'infraestructura_cliente' where reason = 'infraestructura_' || v_viejo;
    update public.nexo_sd_clock_pauses set reason = 'decision_cliente' where reason = 'decision_' || v_viejo;
    alter table public.nexo_sd_clock_pauses enable trigger nexo_sd_clock_pauses_before_update;
    alter table public.nexo_sd_clock_pauses enable trigger nexo_sd_clock_pauses_after_update;
  end if;
  update public.nexo_sd_ticket_events
     set payload = jsonb_set(payload - ('acuse_' || v_viejo), '{acuse_cliente}', payload -> ('acuse_' || v_viejo))
   where payload ? ('acuse_' || v_viejo);
  update public.nexo_sd_ticket_events
     set payload = jsonb_set(payload, '{motivo}', to_jsonb(replace(payload ->> 'motivo', '_' || v_viejo, '_cliente')))
   where payload ->> 'motivo' like '%\_' || v_viejo;
  alter table public.nexo_sd_clock_pauses add constraint nexo_sd_clock_pauses_reason_check
    check (reason in ('infraestructura_cliente', 'red', 'terceros', 'decision_cliente', 'acceso_remoto_pendiente'));
end;
$do$;

-- Funciones que nombran esas columnas o motivos (mismo cuerpo que en las migraciones base).

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
  if p_reason is null or p_reason not in ('infraestructura_cliente', 'red', 'terceros', 'decision_cliente') then
    raise exception 'nexo_sd: motivo de pausa no tipificado. Use infraestructura_cliente, red, terceros o decision_cliente; la pausa por acceso remoto pendiente se abre sola al solicitar el acceso'
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
  if v_pause.client_ack_at is not null then
    raise exception 'nexo_sd: la pausa ya fue acusada' using errcode = '23514';
  end if;
  if not coalesce(p_accept, true) and coalesce(char_length(btrim(p_note)), 0) < 10 then
    raise exception 'nexo_sd: para objetar una pausa indique el motivo (al menos 10 caracteres)' using errcode = '22023';
  end if;

  update public.nexo_sd_clock_pauses p
     set client_ack_status = case when coalesce(p_accept, true) then 'aceptada' else 'objetada' end,
         client_ack_by = auth.uid(),
         client_ack_at = now(),
         client_ack_note = nullif(btrim(p_note), '')
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
               count(*) filter (where p.client_ack_status = 'objetada') as objected
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
    -- Reanudar sin esperar al cliente equivale a desistir de la solicitud de acceso.
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
