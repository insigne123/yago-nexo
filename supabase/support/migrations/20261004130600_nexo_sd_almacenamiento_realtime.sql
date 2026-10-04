-- =============================================================================
-- Mesa de soporte Nexo · 07 · Almacenamiento (bucket nexo-sd-adjuntos) y Realtime
--
-- Rutas dentro del bucket (privado):
--   tickets/<ticket_id>/publico/<archivo>   adjuntos visibles para la organización
--   tickets/<ticket_id>/interno/<archivo>   adjuntos solo para agentes y supervisores
--   informes/<org_id>/<AAAA-MM>.pdf          informes mensuales (los sube el backend)
--   documentos/<org_id>/<archivo>            RCA y paquetes de corrección
-- Las políticas replican la visibilidad de los tickets. Además se agregan políticas
-- RESTRICTIVE acotadas a este bucket: aunque otro producto del proyecto tenga políticas
-- permisivas amplias en storage.objects, no pueden abrir este bucket. Para los demás
-- buckets la condición es siempre verdadera (no cambia su comportamiento).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nexo-sd-adjuntos', 'nexo-sd-adjuntos', false, 26214400,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv',
    'application/json', 'application/xml', 'text/xml', 'application/zip', 'application/gzip',
    'application/x-gzip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do nothing;

create or replace function nexo_private.sd_is_uuid(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
$$;

create or replace function nexo_private.sd_can_read_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_n     int := coalesce(array_length(string_to_array(coalesce(p_name, ''), '/'), 1), 0);
begin
  if v_n < 3 or p_name like '%..%' or not nexo_private.sd_is_uuid(v_parts[2]) then
    return false;
  end if;
  if v_parts[1] = 'tickets' then
    if v_n < 4 or v_parts[3] not in ('publico', 'interno') then
      return false;
    end if;
    if nexo_private.sd_is_staff() then
      return true;
    end if;
    return v_parts[3] = 'publico'
       and exists (
         select 1 from public.nexo_sd_tickets t
         where t.id = v_parts[2]::uuid
           and t.intake_status = 'aceptado'
           and t.org_id in (select nexo_private.sd_user_org_ids()));
  elsif v_parts[1] in ('informes', 'documentos') then
    return nexo_private.sd_is_staff() or v_parts[2]::uuid in (select nexo_private.sd_user_org_ids());
  end if;
  return false;
end;
$$;

create or replace function nexo_private.sd_can_write_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_n     int := coalesce(array_length(string_to_array(coalesce(p_name, ''), '/'), 1), 0);
  v_org   uuid;
  v_status text;
begin
  if v_n < 3 or p_name like '%..%' or not nexo_private.sd_is_uuid(v_parts[2]) then
    return false;
  end if;
  if v_parts[1] = 'tickets' then
    if v_n < 4 or v_parts[3] not in ('publico', 'interno') or coalesce(v_parts[4], '') = '' then
      return false;
    end if;
    select t.org_id, t.status into v_org, v_status
    from public.nexo_sd_tickets t
    where t.id = v_parts[2]::uuid and t.intake_status = 'aceptado';
    if not found then
      return nexo_private.sd_is_staff();
    end if;
    if nexo_private.sd_is_staff() then
      return true;
    end if;
    return v_parts[3] = 'publico'
       and v_status <> 'cerrado'
       and nexo_private.sd_has_org_role(v_org, array['reportante', 'contraparte']);
  elsif v_parts[1] in ('informes', 'documentos') then
    return nexo_private.sd_is_staff();
  end if;
  return false;
end;
$$;

revoke all on function nexo_private.sd_is_uuid(text), nexo_private.sd_can_read_object(text),
  nexo_private.sd_can_write_object(text) from public, anon, authenticated;
grant execute on function nexo_private.sd_is_uuid(text), nexo_private.sd_can_read_object(text),
  nexo_private.sd_can_write_object(text) to authenticated, service_role;

-- Políticas permisivas del bucket.
drop policy if exists nexo_sd_adjuntos_select on storage.objects;
create policy nexo_sd_adjuntos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'nexo-sd-adjuntos' and nexo_private.sd_can_read_object(name));

drop policy if exists nexo_sd_adjuntos_insert on storage.objects;
create policy nexo_sd_adjuntos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'nexo-sd-adjuntos' and nexo_private.sd_can_write_object(name));

drop policy if exists nexo_sd_adjuntos_update on storage.objects;
create policy nexo_sd_adjuntos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'nexo-sd-adjuntos' and (select nexo_private.sd_is_staff()))
  with check (bucket_id = 'nexo-sd-adjuntos' and (select nexo_private.sd_is_staff())
              and nexo_private.sd_can_write_object(name));

drop policy if exists nexo_sd_adjuntos_delete on storage.objects;
create policy nexo_sd_adjuntos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'nexo-sd-adjuntos' and (select nexo_private.sd_is_staff()));

-- Políticas restrictivas: blindan el bucket frente a políticas permisivas de terceros.
drop policy if exists nexo_sd_adjuntos_guard_anon on storage.objects;
create policy nexo_sd_adjuntos_guard_anon on storage.objects
  as restrictive for all to anon
  using (bucket_id is distinct from 'nexo-sd-adjuntos')
  with check (bucket_id is distinct from 'nexo-sd-adjuntos');

drop policy if exists nexo_sd_adjuntos_guard_select on storage.objects;
create policy nexo_sd_adjuntos_guard_select on storage.objects
  as restrictive for select to authenticated
  using (case when bucket_id = 'nexo-sd-adjuntos' then nexo_private.sd_can_read_object(name) else true end);

drop policy if exists nexo_sd_adjuntos_guard_insert on storage.objects;
create policy nexo_sd_adjuntos_guard_insert on storage.objects
  as restrictive for insert to authenticated
  with check (case when bucket_id = 'nexo-sd-adjuntos' then nexo_private.sd_can_write_object(name) else true end);

drop policy if exists nexo_sd_adjuntos_guard_update on storage.objects;
create policy nexo_sd_adjuntos_guard_update on storage.objects
  as restrictive for update to authenticated
  using (case when bucket_id = 'nexo-sd-adjuntos' then nexo_private.sd_is_staff() else true end)
  with check (case when bucket_id = 'nexo-sd-adjuntos' then nexo_private.sd_is_staff() else true end);

drop policy if exists nexo_sd_adjuntos_guard_delete on storage.objects;
create policy nexo_sd_adjuntos_guard_delete on storage.objects
  as restrictive for delete to authenticated
  using (case when bucket_id = 'nexo-sd-adjuntos' then nexo_private.sd_is_staff() else true end);

-- -----------------------------------------------------------------------------
-- Realtime: se agregan solo las tablas de la mesa a la publicación de Supabase (las
-- suscripciones respetan la RLS de cada usuario). Si la publicación no existe o es
-- FOR ALL TABLES, no se toca.
-- -----------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_catalog.pg_publication p where p.pubname = 'supabase_realtime' and not p.puballtables) then
    raise notice 'nexo_sd: publicación supabase_realtime ausente o FOR ALL TABLES; no se modifica';
    return;
  end if;
  foreach v_table in array array[
    'nexo_sd_tickets', 'nexo_sd_ticket_events', 'nexo_sd_sla_clocks', 'nexo_sd_clock_pauses',
    'nexo_sd_remote_access_requests', 'nexo_sd_notifications', 'nexo_sd_security_incidents'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables pt
      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and pt.tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;
