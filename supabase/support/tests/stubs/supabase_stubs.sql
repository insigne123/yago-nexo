-- =============================================================================
-- Stubs mínimos de Supabase para probar las migraciones en un PostgreSQL 16 desechable.
-- NO se aplican en Supabase: solo los usa supabase/support/tests/run-local.sh.
-- Emulan: roles de la API, esquema auth (users, uid(), jwt(), role()), storage
-- (buckets, objects, foldername), cron.schedule, net.http_post, vault y la publicación
-- supabase_realtime, además de los privilegios por omisión que Supabase da en public.
-- =============================================================================

set client_min_messages = warning;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin noinherit;
  end if;
end;
$$;

grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase otorga por omisión todo en public a los roles de la API (la RLS protege las filas).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists extensions;

-- auth -------------------------------------------------------------------------
create schema if not exists auth;
create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;

-- storage ----------------------------------------------------------------------
create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null unique,
  owner              uuid,
  public             boolean default false,
  avif_autodetection boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language plpgsql
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end;
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

-- Otro producto del proyecto con una política permisiva amplia (para verificar que las
-- políticas restrictivas de la mesa blindan su bucket).
insert into storage.buckets (id, name, public) values ('otro-producto', 'otro-producto', false)
  on conflict (id) do nothing;
drop policy if exists otro_producto_lectura_amplia on storage.objects;
create policy otro_producto_lectura_amplia on storage.objects
  for select to anon, authenticated using (true);

-- cron -------------------------------------------------------------------------
create schema if not exists cron;
create table if not exists cron.job (
  jobid    bigserial primary key,
  jobname  text unique,
  schedule text not null,
  command  text not null,
  active   boolean not null default true
);
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end;
$$;

-- net (pg_net) -------------------------------------------------------------------
create schema if not exists net;
create table if not exists net.http_request_log (
  id                   bigserial primary key,
  url                  text,
  body                 jsonb,
  params               jsonb,
  headers              jsonb,
  timeout_milliseconds int,
  created_at           timestamptz default now()
);
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000)
returns bigint
language sql
as $$
  insert into net.http_request_log (url, body, params, headers, timeout_milliseconds)
  values (url, body, params, headers, timeout_milliseconds)
  returning id
$$;

-- vault ------------------------------------------------------------------------
create schema if not exists vault;
create table if not exists vault.secrets_stub (
  name             text primary key,
  decrypted_secret text not null
);
create or replace view vault.decrypted_secrets as
  select s.name, s.decrypted_secret from vault.secrets_stub s;

-- realtime ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;
