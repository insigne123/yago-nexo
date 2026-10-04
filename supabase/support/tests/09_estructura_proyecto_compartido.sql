-- Reglas del proyecto compartido verificadas en el catálogo: prefijos, RLS y políticas en
-- todas las tablas, nada legible ni ejecutable por anon, search_path fijo, sin triggers en
-- auth.users y sin referencias a objetos de ANTON.IA (anton2_*).
begin;

create temp view tablas_mesa as
  select c.oid, n.nspname, c.relname, c.relrowsecurity
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and ((n.nspname = 'public' and c.relname like 'nexo\_sd\_%') or n.nspname = 'nexo_private');

create temp view funciones_mesa as
  select p.oid, n.nspname, p.proname, p.proconfig, p.prosrc, p.oid::regprocedure::text as firma
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname like 'nexo\_sd\_%') or n.nspname = 'nexo_private';

select nexo_test.eq((select count(*)::int from tablas_mesa where nspname = 'public'), 16, 'la mesa crea 16 tablas nexo_sd_* en public');
select nexo_test.eq(
  (select string_agg(relname, ', ') from tablas_mesa where not relrowsecurity), null::text,
  'todas las tablas de la mesa tienen RLS habilitada');
select nexo_test.eq(
  (select string_agg(t.relname, ', ') from tablas_mesa t
   where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = t.oid)),
  null::text, 'todas las tablas de la mesa tienen políticas explícitas');
select nexo_test.eq(
  (select string_agg(relname, ', ') from tablas_mesa
   where has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('anon', oid, 'INSERT')
      or has_table_privilege('anon', oid, 'UPDATE') or has_table_privilege('anon', oid, 'DELETE')),
  null::text, 'anon no tiene ningún privilegio sobre las tablas de la mesa');
select nexo_test.eq(
  (select string_agg(firma, ', ') from funciones_mesa where has_function_privilege('anon', oid, 'EXECUTE')),
  null::text, 'anon no puede ejecutar ninguna función de la mesa');
select nexo_test.ok(not has_schema_privilege('anon', 'nexo_private', 'USAGE'), 'anon no tiene USAGE en nexo_private');
select nexo_test.eq(
  (select string_agg(firma, ', ') from funciones_mesa
   where firma in ('nexo_sd_claim_notifications(integer,integer)',
                   'nexo_sd_complete_notification(uuid,boolean,jsonb,text,boolean)',
                   'nexo_sd_monthly_report_data(text,uuid)',
                   'nexo_sd_record_monthly_report(uuid,text,jsonb,text,uuid)')
     and has_function_privilege('authenticated', oid, 'EXECUTE')),
  null::text, 'las RPC del backend no son ejecutables por usuarios autenticados');
select nexo_test.ok(
  not has_function_privilege('authenticated',
    'public.nexo_sd_inbound_message(text,text,text,text,text,text,timestamp with time zone)', 'EXECUTE'),
  'el canal entrante solo lo usa el backend');
select nexo_test.eq(
  (select string_agg(firma, ', ') from funciones_mesa
   where not exists (select 1 from unnest(coalesce(proconfig, '{}'::text[])) cfg where cfg = 'search_path=""')),
  null::text, 'todas las funciones de la mesa fijan search_path vacío');
select nexo_test.eq(
  (select count(*)::int from pg_catalog.pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal), 0,
  'la mesa no agrega triggers en auth.users');
select nexo_test.eq(
  (select string_agg(firma, ', ') from funciones_mesa where prosrc ilike '%anton2%'), null::text,
  'ninguna función de la mesa referencia objetos anton2_*');
select nexo_test.eq(
  (select string_agg(polname, ', ') from pg_catalog.pg_policy
   where polrelid = 'storage.objects'::regclass and polname not like 'nexo\_sd\_%' and polname <> 'otro_producto_lectura_amplia'),
  null::text, 'las políticas de storage de la mesa usan el prefijo nexo_sd_');
select nexo_test.eq(
  (select string_agg(jobname, ', ') from cron.job where jobname not like 'nexo\_sd\_%'), null::text,
  'los trabajos de pg_cron usan el prefijo nexo_sd_');
select nexo_test.eq(
  (select string_agg(tgname, ', ') from pg_catalog.pg_trigger tg join tablas_mesa t on t.oid = tg.tgrelid
   where not tg.tgisinternal and tg.tgname not like 'nexo\_sd\_%'),
  null::text, 'los triggers de la mesa usan el prefijo nexo_sd_');
select nexo_test.eq(
  (select string_agg(i.relname, ', ') from pg_catalog.pg_index x
   join pg_catalog.pg_class i on i.oid = x.indexrelid
   join tablas_mesa t on t.oid = x.indrelid
   where t.nspname = 'public' and i.relname not like 'nexo\_sd\_%'),
  null::text, 'los índices de la mesa usan el prefijo nexo_sd_');
select nexo_test.eq(
  (select string_agg(pt.tablename, ', ' order by pt.tablename) from pg_catalog.pg_publication_tables pt
   where pt.pubname = 'supabase_realtime'),
  'nexo_sd_clock_pauses, nexo_sd_notifications, nexo_sd_remote_access_requests, nexo_sd_security_incidents, nexo_sd_sla_clocks, nexo_sd_ticket_events, nexo_sd_tickets',
  'Realtime publica solo las tablas de la mesa que la interfaz escucha');

rollback;
