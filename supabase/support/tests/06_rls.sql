-- Seguridad por filas y permisos: anon sin acceso, aislamiento entre organizaciones, MFA
-- obligatorio, reportante sin cambios de estado, agente con operación completa y adjuntos
-- con la misma visibilidad que los tickets.
begin;

\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'

-- Otra organización cliente con su propio reportante.
insert into public.nexo_sd_organizations (name, slug) values ('Otra organización (prueba)', 'otra-org');
insert into public.nexo_sd_members (user_id, org_id, role, display_name, email)
values (nexo_test.uid('reportante@otra-org.invalid'), nexo_test.org('otra-org'), 'reportante', 'Reportante de otra org', 'reportante@otra-org.invalid');

insert into public.nexo_sd_tickets (org_id, title, classification_answers, reporter_id, external_ref) values
  (nexo_test.org('cliente-demo'), 'Ticket del cliente', :'s3', nexo_test.uid('reportante.demo@cliente.invalid'), 'test:rls-cliente'),
  (nexo_test.org('otra-org'), 'Ticket de otra organización', :'s3', nexo_test.uid('reportante@otra-org.invalid'), 'test:rls-otra');
select id as t_cliente from public.nexo_sd_tickets where external_ref = 'test:rls-cliente' \gset
select id as t_otra from public.nexo_sd_tickets where external_ref = 'test:rls-otra' \gset
select nexo_test.org('cliente-demo') as org_cliente \gset

insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body) values
  (:'t_cliente', 'comment', 'interno', 'Nota interna: revisar el balanceador antes de responder.'),
  (:'t_cliente', 'comment', 'publico', 'Estamos revisando el caso.');

insert into storage.objects (bucket_id, name) values
  ('nexo-sd-adjuntos', 'tickets/' || :'t_cliente' || '/publico/captura.png'),
  ('nexo-sd-adjuntos', 'tickets/' || :'t_cliente' || '/interno/volcado.log'),
  ('nexo-sd-adjuntos', 'tickets/' || :'t_otra' || '/publico/otra.png'),
  ('nexo-sd-adjuntos', 'informes/' || :'org_cliente' || '/2026-09.pdf'),
  ('otro-producto', 'carpeta/archivo-de-otro-producto.txt');

-- ---------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------
select nexo_test.login_anon();
select nexo_test.eq(
  (select count(*)::int from pg_catalog.pg_tables t
   where t.schemaname = 'public' and t.tablename like 'nexo\_sd\_%'
     and nexo_test.denied(format('select 1 from public.%I limit 1', t.tablename))),
  16, 'anon no puede leer ninguna de las 16 tablas nexo_sd_*');
select nexo_test.ok(nexo_test.denied('select public.nexo_sd_my_context()'), 'anon no puede llamar las RPC de la mesa');
select nexo_test.ok(nexo_test.denied($$select * from public.nexo_sd_sla_summary('2026-09')$$), 'anon no puede pedir el resumen SLA');
select nexo_test.ok(nexo_test.denied('select nexo_private.sd_is_staff()'), 'anon no tiene acceso al esquema nexo_private');
select nexo_test.eq((select count(*)::int from storage.objects where bucket_id = 'nexo-sd-adjuntos'), 0,
  'anon no ve objetos del bucket aunque otro producto tenga una política amplia');
select nexo_test.eq((select count(*)::int from storage.objects where bucket_id = 'otro-producto'), 1,
  'el bucket del otro producto mantiene su comportamiento');
reset role;

-- ---------------------------------------------------------------------------
-- Persona autenticada sin membresía
-- ---------------------------------------------------------------------------
select nexo_test.login('sin.membresia@ejemplo.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets), 0, 'sin membresía no ve tickets');
select nexo_test.eq((select count(*)::int from public.nexo_sd_organizations), 0, 'sin membresía no ve organizaciones');
select nexo_test.eq((select count(*)::int from public.nexo_sd_sla_policies), 0, 'sin membresía no ve las políticas');
select nexo_test.eq((public.nexo_sd_my_context() ->> 'memberships'), '[]', 'su contexto no tiene membresías');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers) values (nexo_test.org('cliente-demo'), 'Intruso', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}')$$,
  'sin membresía no puede crear tickets', '42501');
reset role;

-- ---------------------------------------------------------------------------
-- MFA: sin aal2 no se ve nada
-- ---------------------------------------------------------------------------
select nexo_test.login('reportante.demo@cliente.invalid', 'aal1');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets), 0, 'un reportante sin MFA (aal1) no ve tickets');
select nexo_test.eq((public.nexo_sd_my_context() ->> 'mfa_ok'), 'false', 'el contexto informa que falta MFA');
select nexo_test.login('agente1.demo@yago.invalid', 'aal1');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets), 0, 'un agente sin MFA (aal1) tampoco ve tickets');
select nexo_test.ok(nexo_test.affected($$update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:rls-cliente'$$) = 0,
  'un agente sin MFA no cambia estados');
reset role;

-- ---------------------------------------------------------------------------
-- Reportante del cliente (organización A)
-- ---------------------------------------------------------------------------
select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.ok((select count(*) = 1 from public.nexo_sd_tickets where external_ref = 'test:rls-cliente'),
  'el reportante ve los tickets de su organización');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets where org_id is distinct from nexo_test.org('cliente-demo')), 0,
  'el reportante de A no ve tickets de B ni en cuarentena');
select nexo_test.eq((select count(*)::int from public.nexo_sd_sla_clocks where ticket_id = :'t_otra'), 0,
  'tampoco ve los relojes de B');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events where ticket_id = :'t_cliente' and visibility = 'interno'), 0,
  'el reportante no ve notas internas');
select nexo_test.ok(
  (select count(*) >= 2 from public.nexo_sd_ticket_events where ticket_id = :'t_cliente' and visibility = 'publico'),
  'el reportante ve la línea de tiempo pública');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:rls-cliente'$$), 0,
  'el reportante no puede cambiar el estado (0 filas)');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_tickets set assignee_id = auth.uid() where external_ref = 'test:rls-cliente'$$), 0,
  'el reportante no puede asignar');
select nexo_test.ok(nexo_test.denied($$select public.nexo_sd_pause_ticket('$$ || :'t_cliente' || $$', 'red', 'Intento de pausa del reportante.')$$),
  'el reportante no puede pausar');
select nexo_test.ok(nexo_test.denied($$select public.nexo_sd_escalate_ticket('$$ || :'t_cliente' || $$', 2, 'Intento de escalamiento')$$),
  'el reportante no puede escalar');
select nexo_test.ok(nexo_test.denied($$select * from public.nexo_sd_claim_notifications(5)$$),
  'las RPC del backend no están disponibles para usuarios');

insert into public.nexo_sd_tickets (org_id, title, description, classification_answers, environment)
values (nexo_test.org('cliente-demo'), 'Ticket creado por el reportante', 'Detalle', :'s3', 'qa');
select nexo_test.ok(
  (select reporter_id = nexo_test.uid('reportante.demo@cliente.invalid') and channel = 'web' and status = 'nuevo'
   from public.nexo_sd_tickets where title = 'Ticket creado por el reportante'),
  'el reportante crea tickets en su organización (queda como reportante, canal web)');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers) values (nexo_test.org('otra-org'), 'En otra org', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}')$$,
  'el reportante no crea tickets en otra organización', '42501');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at) values (nexo_test.org('cliente-demo'), 'Antedatado', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', now() - interval '1 day')$$,
  'el reportante no puede antedatar un ticket', '42501');

insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body)
values (:'t_cliente', 'comment', 'publico', 'Adjunto la captura del error.');
select nexo_test.ok(
  (select author_id = nexo_test.uid('reportante.demo@cliente.invalid') from public.nexo_sd_ticket_events
   where body = 'Adjunto la captura del error.'),
  'el reportante comenta su ticket y queda como autor');
select nexo_test.throws(
  $$insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body) values ('$$ || :'t_cliente' || $$', 'comment', 'interno', 'Intento de nota interna')$$,
  'el reportante no escribe notas internas', '42501');
select nexo_test.throws(
  $$insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body) values ('$$ || :'t_cliente' || $$', 'status_change', 'publico', 'Intento de evento de sistema')$$,
  'el reportante no escribe eventos de sistema', '42501');
select nexo_test.throws(
  $$insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body) values ('$$ || :'t_otra' || $$', 'comment', 'publico', 'Comentario en otra organización')$$,
  'el reportante no comenta tickets de otra organización', '42501');

select nexo_test.eq((select count(*)::int from public.nexo_sd_members), 1, 'el reportante solo ve su propia membresía');
select nexo_test.ok(
  (select bool_and(email is null) and bool_or(is_staff) from public.nexo_sd_directory()),
  'el directorio le muestra a los agentes, sin datos de contacto');
select nexo_test.ok(
  (select bool_and(recipient_user_id = nexo_test.uid('reportante.demo@cliente.invalid')) from public.nexo_sd_notifications),
  'el reportante solo ve sus propios avisos');
select nexo_test.eq((select count(*)::int from public.nexo_sd_oncall_shifts), 0, 'el reportante no ve los turnos');
select nexo_test.eq((select count(*)::int from public.nexo_sd_security_incidents), 0, 'el reportante no ve incidentes de seguridad');

-- Adjuntos
select nexo_test.eq(
  (select string_agg(split_part(name, '/', 4), ',' order by name) from storage.objects
   where bucket_id = 'nexo-sd-adjuntos' and name like 'tickets/%'),
  'captura.png', 'el reportante ve solo los adjuntos públicos de su organización');
select nexo_test.eq(
  (select count(*)::int from storage.objects where bucket_id = 'nexo-sd-adjuntos' and name like 'informes/%'), 1,
  'el reportante ve los informes de su organización');
insert into storage.objects (bucket_id, name) values ('nexo-sd-adjuntos', 'tickets/' || :'t_cliente' || '/publico/nuevo.txt');
select nexo_test.ok(true, 'el reportante sube un adjunto público a su ticket');
select nexo_test.ok(nexo_test.denied($$insert into storage.objects (bucket_id, name) values ('nexo-sd-adjuntos', 'tickets/$$ || :'t_cliente' || $$/interno/x.txt')$$),
  'el reportante no sube adjuntos internos');
select nexo_test.ok(nexo_test.denied($$insert into storage.objects (bucket_id, name) values ('nexo-sd-adjuntos', 'tickets/$$ || :'t_otra' || $$/publico/x.txt')$$),
  'el reportante no sube adjuntos a tickets de otra organización');
select nexo_test.ok(nexo_test.denied($$insert into storage.objects (bucket_id, name) values ('nexo-sd-adjuntos', 'informes/$$ || :'org_cliente' || $$/falso.pdf')$$),
  'el reportante no sube informes');
select nexo_test.eq(
  nexo_test.affected($$delete from storage.objects where bucket_id = 'nexo-sd-adjuntos' and name like '%captura.png'$$), 0,
  'el reportante no borra adjuntos');
reset role;

-- Reportante de la otra organización (B)
select nexo_test.login('reportante@otra-org.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets where org_id = nexo_test.org('cliente-demo')), 0,
  'el reportante de B no ve tickets del cliente');
select nexo_test.eq((select count(*)::int from public.nexo_sd_tickets where external_ref = 'test:rls-otra'), 1,
  'el reportante de B ve su ticket');
select nexo_test.eq(
  (select coalesce(sum(total), 0)::int from public.nexo_sd_sla_summary(to_char(now() at time zone 'America/Santiago', 'YYYY-MM'))),
  3, 'el resumen SLA del reportante de B solo cuenta sus propios relojes');
reset role;

-- Contraparte del cliente
select nexo_test.login('contraparte.demo@cliente.invalid');
select nexo_test.ok((select count(*) >= 1 from public.nexo_sd_security_incidents), 'la contraparte ve los incidentes de su organización');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:rls-cliente'$$), 0,
  'la contraparte tampoco cambia estados');
reset role;

-- ---------------------------------------------------------------------------
-- Agente de Yago
-- ---------------------------------------------------------------------------
select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.ok(
  (select count(distinct coalesce(org_id::text, 'cuarentena')) >= 3 from public.nexo_sd_tickets),
  'el agente ve todas las organizaciones y la cuarentena');
select nexo_test.ok(
  (select bool_and(email is not null) and count(*) >= 6 from public.nexo_sd_directory()),
  'el directorio le muestra al agente todas las personas con sus datos de contacto');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events
   where ticket_id = :'t_cliente' and visibility = 'interno' and type = 'comment'), 1,
  'el agente ve las notas internas');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:rls-cliente'$$), 1,
  'el agente cambia el estado');
select nexo_test.eq(
  (select status from public.nexo_sd_sla_clocks where ticket_id = :'t_cliente' and metric = 'acuse'), 'cumplido',
  'el cambio de estado del agente cumple el acuse');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_tickets set assignee_id = auth.uid() where external_ref = 'test:rls-cliente'$$), 1,
  'el agente se asigna el ticket');
select nexo_test.throws(
  $$update public.nexo_sd_tickets set assignee_id = nexo_test.uid('reportante.demo@cliente.invalid') where external_ref = 'test:rls-cliente'$$,
  'solo se asigna a personal de Yago', '23514');
select nexo_test.ok(nexo_test.denied($$update public.nexo_sd_tickets set severity = 'S1' where external_ref = 'test:rls-cliente'$$),
  'ni el agente escribe la severidad directamente');
select nexo_test.ok(nexo_test.denied($$update public.nexo_sd_tickets set number = 'SD-0000-0000' where external_ref = 'test:rls-cliente'$$),
  'el número del ticket no se modifica');
select nexo_test.eq(
  (public.nexo_sd_reclassify_ticket(:'t_cliente',
     '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}',
     'El reportante confirmó por teléfono que hay un nodo caído.') ->> 'severity'),
  'S2', 'el agente reclasifica con el asistente (S3 a S2)');
insert into public.nexo_sd_ticket_events (ticket_id, type, visibility, body)
values (:'t_cliente', 'comment', 'interno', 'Nota interna del agente.');
select nexo_test.ok(true, 'el agente escribe notas internas');
select nexo_test.ok(public.nexo_sd_pause_ticket(:'t_cliente', 'red', 'Corte de red del proveedor de enlace.') is not null,
  'el agente pausa');
select public.nexo_sd_resume_ticket(:'t_cliente', 'Enlace restablecido.');
select nexo_test.eq((select count(*)::int from public.nexo_sd_clock_pauses where ticket_id = :'t_cliente' and ended_at is null), 0,
  'el agente reanuda');
select nexo_test.ok(public.nexo_sd_escalate_ticket(:'t_cliente', 2, 'Requiere al técnico de turno') >= 1,
  'el agente escala manualmente al nivel 2');
select nexo_test.eq(
  (select count(*)::int from storage.objects where bucket_id = 'nexo-sd-adjuntos'), 5,
  'el agente ve todos los adjuntos e informes');
select nexo_test.eq(
  nexo_test.affected($$delete from storage.objects where bucket_id = 'nexo-sd-adjuntos' and name like '%nuevo.txt'$$), 1,
  'el agente puede retirar un adjunto');
insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at)
values (nexo_test.uid('agente2.demo@yago.invalid'), 2, now() + interval '40 days', now() + interval '41 days');
select nexo_test.ok(true, 'el agente agenda turnos');
select nexo_test.throws(
  $$insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at) values (nexo_test.uid('reportante.demo@cliente.invalid'), 1, now(), now() + interval '1 day')$$,
  'un turno solo se asigna a personal de Yago', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_organizations (name, slug) values ('Nueva', 'nueva-org')$$,
  'un agente no crea organizaciones (solo supervisores)', '42501');
reset role;

select nexo_test.login('supervisor.demo@yago.invalid');
insert into public.nexo_sd_organizations (name, slug) values ('Nueva organización', 'nueva-org');
select nexo_test.ok(true, 'un supervisor crea organizaciones');
reset role;

rollback;
