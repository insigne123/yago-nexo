-- =============================================================================
-- Mesa de soporte Nexo · 08 · Tareas programadas (pg_cron) e invocación de funciones Edge
--
-- Trabajos (todos con prefijo nexo_sd_):
--   nexo_sd_sla_tick          cada minuto   nexo_private.sd_tick()
--   nexo_sd_notify_dispatch   cada minuto   llama a nexo-sd-notify solo si hay avisos pendientes
--   nexo_sd_monthly_report    día 1, 12:20 UTC (09:20 en verano de Chile) informe del mes anterior
--
-- La invocación usa pg_net y dos secretos de Supabase Vault que se crean a mano (no van en
-- el repositorio):
--   select vault.create_secret('https://<ref>.supabase.co', 'nexo_sd_project_url');
--   select vault.create_secret('<mismo valor que NEXO_CRON_SECRET>', 'nexo_sd_cron_secret');
-- Si faltan pg_net o los secretos, la función deja una advertencia y no falla.
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net')
     and not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end;
$$;

create or replace function nexo_private.sd_vault_secret(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into v_value using p_name;
  return v_value;
end;
$$;

create or replace function nexo_private.sd_invoke_function(p_function text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  if p_function is null or p_function !~ '^nexo-sd-[a-z0-9-]+$' then
    raise exception 'nexo_sd: solo se invocan funciones nexo-sd-*' using errcode = '22023';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise warning 'nexo_sd: pg_net no está disponible; no se invoca %', p_function;
    return null;
  end if;
  v_url := nexo_private.sd_vault_secret('nexo_sd_project_url');
  v_secret := nexo_private.sd_vault_secret('nexo_sd_cron_secret');
  if v_url is null or v_secret is null then
    raise warning 'nexo_sd: faltan los secretos nexo_sd_project_url o nexo_sd_cron_secret en Vault; no se invoca %',
      p_function;
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
    into v_id
    using rtrim(v_url, '/') || '/functions/v1/' || p_function,
          coalesce(p_body, '{}'::jsonb),
          '{}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'x-nexo-cron-secret', v_secret),
          10000;
  return v_id;
end;
$$;

create or replace function nexo_private.sd_dispatch_notifications()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.nexo_sd_notifications n
    where n.status = 'pendiente'
      and n.next_attempt_at <= now()
      and (n.locked_until is null or n.locked_until < now())
  ) then
    return null;
  end if;
  return nexo_private.sd_invoke_function('nexo-sd-notify', jsonb_build_object('origen', 'pg_cron'));
end;
$$;

revoke all on function nexo_private.sd_vault_secret(text), nexo_private.sd_invoke_function(text, jsonb),
  nexo_private.sd_dispatch_notifications() from public, anon, authenticated, service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise warning 'nexo_sd: pg_cron no está disponible; programe los trabajos nexo_sd_* manualmente (ver README)';
    return;
  end if;
  perform cron.schedule('nexo_sd_sla_tick', '* * * * *', 'select nexo_private.sd_tick()');
  perform cron.schedule('nexo_sd_notify_dispatch', '* * * * *', 'select nexo_private.sd_dispatch_notifications()');
  perform cron.schedule('nexo_sd_monthly_report', '20 12 1 * *',
    $cmd$select nexo_private.sd_invoke_function('nexo-sd-monthly-report', '{"origen": "pg_cron"}'::jsonb)$cmd$);
end;
$$;
