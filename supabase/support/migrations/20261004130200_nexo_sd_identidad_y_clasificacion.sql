-- =============================================================================
-- Mesa de soporte Nexo · 03 · Identidad, pertenencia y clasificación de severidad
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ¿Quién ejecuta? Las llamadas desde la API llegan como anon o authenticated; el
-- backend (funciones Edge con la clave de servicio), pg_cron y las migraciones son
-- privilegiados. Es SECURITY INVOKER a propósito: dentro de una función SECURITY
-- DEFINER current_user es el dueño, así que las operaciones internas de la mesa
-- quedan como privilegiadas y las de la API no.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_is_privileged()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select current_user::text in ('postgres', 'service_role', 'supabase_admin')
      or coalesce((select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user), false)
$$;

-- -----------------------------------------------------------------------------
-- MFA obligatorio en la base de datos: sin aal2 en el JWT no se ve nada (además de la
-- exigencia en la interfaz). require_mfa=false existe solo para ambientes de prueba.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select not s.require_mfa from public.nexo_sd_settings s where s.id), false)
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

create or replace function nexo_private.sd_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where m.user_id = auth.uid()
    and m.active
    and o.active
    and nexo_private.sd_mfa_ok()
$$;

create or replace function nexo_private.sd_is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from nexo_private.sd_user_org_ids())
$$;

create or replace function nexo_private.sd_user_is_staff(p_user uuid)
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
      and m.role in ('agente', 'supervisor')
  )
$$;

create or replace function nexo_private.sd_is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and nexo_private.sd_mfa_ok()
     and nexo_private.sd_user_is_staff(auth.uid())
$$;

create or replace function nexo_private.sd_is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and nexo_private.sd_mfa_ok()
     and exists (
       select 1
       from public.nexo_sd_members m
       join public.nexo_sd_organizations o on o.id = m.org_id
       where m.user_id = auth.uid()
         and m.active
         and o.active
         and o.is_provider
         and m.role = 'supervisor'
     )
$$;

create or replace function nexo_private.sd_has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org is not null
     and auth.uid() is not null
     and nexo_private.sd_mfa_ok()
     and exists (
       select 1
       from public.nexo_sd_members m
       join public.nexo_sd_organizations o on o.id = m.org_id
       where m.user_id = auth.uid()
         and m.org_id = p_org
         and m.active
         and o.active
         and m.role = any (p_roles)
     )
$$;

create or replace function nexo_private.sd_user_has_org_role(p_user uuid, p_org uuid, p_roles text[])
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
      and m.org_id = p_org
      and m.active
      and o.active
      and m.role = any (p_roles)
  )
$$;

create or replace function nexo_private.sd_can_see_ticket(p_ticket uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select nexo_private.sd_is_staff()
      or exists (
        select 1
        from public.nexo_sd_tickets t
        where t.id = p_ticket
          and t.intake_status = 'aceptado'
          and t.org_id in (select nexo_private.sd_user_org_ids())
      )
$$;

create or replace function nexo_private.sd_display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.display_name
  from public.nexo_sd_members m
  join public.nexo_sd_organizations o on o.id = m.org_id
  where m.user_id = p_user
  order by m.active desc, o.is_provider desc, m.created_at
  limit 1
$$;

-- -----------------------------------------------------------------------------
-- Clasificación determinista (BT-061). Reproduce exactamente classifySeverity de
-- packages/shared/src/severity.ts; la prueba supabase/support/tests/02_clasificacion.sql
-- y la prueba de Vitest de apps/support-web comparan ambas implementaciones contra la
-- misma matriz de 32 combinaciones (tests/fixtures/severity_matrix.json).
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_classify(
  p_es_consulta_o_cambio       boolean,
  p_servicio_productivo_caido  boolean,
  p_existe_alternativa         boolean,
  p_degradacion_o_seguridad    boolean,
  p_solo_no_productivo_o_menor boolean,
  out severity text,
  out rule text
)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_es_consulta_o_cambio is null or p_servicio_productivo_caido is null or p_existe_alternativa is null
     or p_degradacion_o_seguridad is null or p_solo_no_productivo_o_menor is null then
    raise exception 'nexo_sd: las cinco respuestas del asistente son obligatorias' using errcode = '22023';
  end if;

  if p_es_consulta_o_cambio then
    severity := 'S4';
    rule := 'Consulta o solicitud de cambio sin falla';
  elsif p_servicio_productivo_caido and not p_existe_alternativa then
    severity := 'S1';
    rule := 'Servicio productivo caído y sin alternativa operativa';
  elsif p_servicio_productivo_caido and p_existe_alternativa then
    severity := 'S2';
    rule := 'Servicio productivo caído con alternativa operativa';
  elsif p_degradacion_o_seguridad then
    severity := 'S2';
    rule := 'Degradación medible en producción o riesgo de seguridad activo';
  elsif p_solo_no_productivo_o_menor then
    severity := 'S3';
    rule := 'Falla en no productivo o funcionalidad no crítica';
  else
    severity := 'S3';
    rule := 'Falla sin impacto productivo declarado';
  end if;
end;
$$;

-- Variante con el JSON que guarda el ticket (mismas claves que SeverityAnswers).
create or replace function nexo_private.sd_classify_answers(p_answers jsonb, out severity text, out rule text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys constant text[] := array['esConsultaOCambio', 'servicioProductivoCaido', 'existeAlternativa',
                                  'degradacionOSeguridad', 'soloNoProductivoOMenor'];
  v_key text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'nexo_sd: las respuestas del asistente deben ser un objeto JSON' using errcode = '22023';
  end if;
  foreach v_key in array v_keys loop
    if jsonb_typeof(p_answers -> v_key) is distinct from 'boolean' then
      raise exception 'nexo_sd: falta la respuesta "%" del asistente (sí o no)', v_key using errcode = '22023';
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(p_answers) k where k <> all (v_keys)) then
    raise exception 'nexo_sd: el asistente solo acepta las cinco respuestas definidas' using errcode = '22023';
  end if;

  select c.severity, c.rule
    into severity, rule
  from nexo_private.sd_classify(
    (p_answers ->> 'esConsultaOCambio')::boolean,
    (p_answers ->> 'servicioProductivoCaido')::boolean,
    (p_answers ->> 'existeAlternativa')::boolean,
    (p_answers ->> 'degradacionOSeguridad')::boolean,
    (p_answers ->> 'soloNoProductivoOMenor')::boolean
  ) c;
end;
$$;

-- -----------------------------------------------------------------------------
-- Correlativo SD-AAAA-NNNN (año local de Santiago). Concurrente: la fila del año se
-- bloquea en el upsert.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_next_ticket_number(p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_year int;
  v_n    int;
begin
  v_year := extract(year from (coalesce(p_at, now()) at time zone (nexo_private.sd_settings()).timezone))::int;
  insert into nexo_private.sd_ticket_counters as c (year, last_value)
  values (v_year, 1)
  on conflict (year) do update set last_value = c.last_value + 1
  returning c.last_value into v_n;
  return 'SD-' || v_year::text || '-' || case when v_n < 10000 then lpad(v_n::text, 4, '0') else v_n::text end;
end;
$$;

create or replace function nexo_private.sd_status_rank(p_status text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'nuevo' then 0
    when 'acusado' then 1
    when 'en_diagnostico' then 2
    when 'solucion_temporal' then 3
    when 'resuelto' then 4
    when 'cerrado' then 5
  end
$$;

create or replace function nexo_private.sd_priority_for(p_severity text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_severity when 'S1' then 1 when 'S2' then 2 when 'S3' then 4 else 5 end
$$;

-- -----------------------------------------------------------------------------
-- Validación de miembros: agente y supervisor solo en la organización proveedora.
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_members_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider boolean;
begin
  select o.is_provider into v_provider from public.nexo_sd_organizations o where o.id = new.org_id;
  if new.role in ('agente', 'supervisor') and not coalesce(v_provider, false) then
    raise exception 'nexo_sd: los roles agente y supervisor solo existen en la organización proveedora (Yago)'
      using errcode = '23514';
  end if;
  if new.email is not null then
    new.email := lower(btrim(new.email));
  end if;
  return new;
end;
$$;

create or replace trigger nexo_sd_members_validate
  before insert or update on public.nexo_sd_members
  for each row execute function nexo_private.sd_members_validate();
