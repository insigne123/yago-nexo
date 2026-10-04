-- Utilidades de aserción para las pruebas locales (no se aplican en Supabase).
create schema if not exists nexo_test;
grant usage on schema nexo_test to public;

create or replace function nexo_test.ok(p_cond boolean, p_msg text)
returns text
language plpgsql
as $$
begin
  if p_cond is distinct from true then
    raise exception 'FALLO: %', p_msg;
  end if;
  return 'ok - ' || p_msg;
end;
$$;

create or replace function nexo_test.eq(p_got anycompatible, p_expected anycompatible, p_msg text)
returns text
language plpgsql
as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FALLO: % (obtenido: %, esperado: %)', p_msg, p_got, p_expected;
  end if;
  return 'ok - ' || p_msg;
end;
$$;

-- Ejecuta una sentencia que debe fallar (opcionalmente con un SQLSTATE dado).
create or replace function nexo_test.throws(p_sql text, p_msg text, p_sqlstate text default null)
returns text
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_sqlstate is null or sqlstate = p_sqlstate then
      return 'ok - ' || p_msg;
    end if;
    raise exception 'FALLO: % (SQLSTATE % en lugar de %: %)', p_msg, sqlstate, p_sqlstate, sqlerrm;
  end;
  raise exception 'FALLO: % (la sentencia no falló)', p_msg;
end;
$$;

-- true si la sentencia falla por falta de permisos (SQLSTATE 42501).
create or replace function nexo_test.denied(p_sql text)
returns boolean
language plpgsql
as $$
begin
  execute p_sql;
  return false;
exception
  when insufficient_privilege then
    return true;
end;
$$;

-- Ejecuta una sentencia con el rol actual y devuelve cuántas filas afectó.
create or replace function nexo_test.affected(p_sql text)
returns int
language plpgsql
as $$
declare
  v_n int;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function nexo_test.uid(p_email text)
returns uuid
language sql
stable
security definer
as $$
  select u.id from auth.users u where u.email = p_email
$$;

-- Simula la sesión de PostgREST: claims del JWT (con nivel de MFA) y rol authenticated.
create or replace function nexo_test.login(p_email text, p_aal text default 'aal2')
returns text
language plpgsql
as $$
declare
  v_id uuid;
begin
  v_id := nexo_test.uid(p_email);
  if v_id is null then
    raise exception 'usuario de prueba desconocido: %', p_email;
  end if;
  perform set_config('request.jwt.claim.sub', v_id::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'role', 'authenticated', 'aal', p_aal, 'email', p_email)::text, true);
  perform set_config('role', 'authenticated', true);
  return 'sesión: ' || p_email || ' (' || p_aal || ')';
end;
$$;

create or replace function nexo_test.login_anon()
returns text
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
  return 'sesión: anon';
end;
$$;

create or replace function nexo_test.org(p_slug text)
returns uuid
language sql
stable
security definer
as $$
  select o.id from public.nexo_sd_organizations o where o.slug = p_slug
$$;

-- Instante local de Santiago -> timestamptz (para escribir fechas legibles en las pruebas).
create or replace function nexo_test.cl(p_local text)
returns timestamptz
language sql
immutable
as $$
  select p_local::timestamp at time zone 'America/Santiago'
$$;

grant execute on all functions in schema nexo_test to public;
