-- Versión 1.2.0: hora real de la llamada en los tickets telefónicos, aviso a la contraparte al
-- vencer un plazo (uno solo por vencimiento), avisos sin proveedor como fallidos y nivel 3 =
-- supervisión.
begin;

\set s1 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s2 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'

-- ---------------------------------------------------------------------------
-- A) Ticket telefónico: el agente ingresa la hora real de la llamada
-- ---------------------------------------------------------------------------
select nexo_test.login('agente1.demo@yago.invalid');
insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at, reporter_id)
values (nexo_test.org('cliente-demo'), 'Llamada: gateway caído', :'s1', 'telefono', now() - interval '25 minutes',
        nexo_test.uid('reportante.demo@cliente.invalid'));
select nexo_test.ok(true, 'el agente registra un ticket telefónico con la hora real de la llamada');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at)
    values (nexo_test.org('cliente-demo'), 'Llamada futura', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', 'telefono', now() + interval '1 minute')$$,
  'la hora de la llamada no puede ser posterior al registro del ticket', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at)
    values (nexo_test.org('cliente-demo'), 'Llamada antigua', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', 'telefono', now() - interval '24 hours 1 minute')$$,
  'ni anterior al registro en más de 24 horas (margen por omisión)', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel)
    values (nexo_test.org('cliente-demo'), 'Llamada sin hora', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', 'telefono')$$,
  'un ticket telefónico exige la hora real de la llamada', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at)
    values (nexo_test.org('cliente-demo'), 'Web con hora', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', 'web', now())$$,
  'la hora de la llamada solo se registra en tickets telefónicos', '23514');
select nexo_test.ok(
  nexo_test.denied($$update public.nexo_sd_tickets set call_received_at = now() where title = 'Llamada: gateway caído'$$),
  'la API no puede cambiar la hora de la llamada después de registrarla');
reset role;

select id as t_tel from public.nexo_sd_tickets where title = 'Llamada: gateway caído' \gset
select nexo_test.ok(
  (select channel = 'telefono' and call_received_at = now() - interval '25 minutes' and created_at = now()
          and sla_started_at = call_received_at and created_by = nexo_test.uid('agente1.demo@yago.invalid')
   from public.nexo_sd_tickets where id = :'t_tel'),
  'el ticket guarda la hora de la llamada, la hora de registro y quién lo registró; el SLA parte con la llamada');
select nexo_test.ok(
  (select bool_and(started_at = now() - interval '25 minutes') from public.nexo_sd_sla_clocks where ticket_id = :'t_tel'),
  'los tres relojes parten a la hora de la llamada');
select nexo_test.eq(
  (select due_at from public.nexo_sd_sla_clocks where ticket_id = :'t_tel' and metric = 'acuse'),
  now() + interval '35 minutes', 'S1: el acuse vence 60 minutos después de la llamada, no del registro');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events e
          where e.ticket_id = :'t_tel' and e.type = 'status_change' and e.visibility = 'publico'
            and e.body like 'Ticket telefónico recibido. Hora real de la llamada: %; el reloj del SLA parte a esa hora.'
            and e.author_id = nexo_test.uid('agente1.demo@yago.invalid')
            and (e.payload ->> 'hora_llamada')::timestamptz = now() - interval '25 minutes'
            and (e.payload ->> 'registrado')::timestamptz = now()
            and (e.payload ->> 'registrado_por')::uuid = nexo_test.uid('agente1.demo@yago.invalid')),
  'la hora de la llamada queda en la línea de tiempo con quién la ingresó y cuándo');
select nexo_test.eq(
  (select e.created_at from public.nexo_sd_ticket_events e
   where e.ticket_id = :'t_tel' and e.type = 'notification' and e.payload ->> 'plantilla' = 'sd_ticket_nuevo'),
  now(), 'el aviso de ticket nuevo al turno queda con la hora del registro (cuando sale)');

update public.nexo_sd_settings set phone_call_max_backdate_minutes = 60;
select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.throws(
  $$insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at)
    values (nexo_test.org('cliente-demo'), 'Llamada de hace 2 horas', '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}', 'telefono', now() - interval '2 hours')$$,
  'el margen se configura (phone_call_max_backdate_minutes)', '23514');
reset role;
update public.nexo_sd_settings set phone_call_max_backdate_minutes = 1440;

select nexo_test.login('reportante.demo@cliente.invalid');
insert into public.nexo_sd_tickets (org_id, title, classification_answers, channel, call_received_at)
values (nexo_test.org('cliente-demo'), 'Reportante intenta fijar la hora', :'s3', 'telefono', now() - interval '3 hours');
reset role;
select nexo_test.ok(
  (select channel = 'web' and call_received_at is null and sla_started_at = created_at
   from public.nexo_sd_tickets where title = 'Reportante intenta fijar la hora'),
  'el cliente no puede fijar la hora de la llamada (su ticket es web y parte al registrarse)');

-- ---------------------------------------------------------------------------
-- B) Vencimiento de un plazo: aviso a la contraparte, uno solo por vencimiento
-- ---------------------------------------------------------------------------
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('cliente-demo'), 'Vence S2', :'s2', now(), 'test:vence');
select id as t_v from public.nexo_sd_tickets where external_ref = 'test:vence' \gset

select nexo_private.sd_tick(now() + interval '239 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte'),
  0, 'antes del vencimiento no se avisa a la contraparte');
select nexo_private.sd_tick(now() + interval '241 minutes') is not null as tick;
select nexo_test.eq(
  (select string_agg(channel, ',' order by channel) from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte' and payload ->> 'metrica' = 'acuse'
     and recipient_user_id = nexo_test.uid('contraparte.demo@cliente.invalid')),
  'email,push', 'al vencer el acuse se avisa a la contraparte (en la aplicación y por correo; sin teléfono no hay WhatsApp)');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte'
     and recipient_user_id is distinct from nexo_test.uid('contraparte.demo@cliente.invalid')),
  0, 'el aviso de vencimiento del cliente va solo a la contraparte (no al reportante)');
select nexo_test.eq(
  (select count(distinct recipient_user_id)::int from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido' and payload ->> 'metrica' = 'acuse'),
  3, 'los niveles 1, 2 y 3 (supervisión) siguen recibiendo el vencimiento');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events e
          where e.ticket_id = :'t_v' and e.type = 'notification' and e.visibility = 'interno'
            and e.body = 'Venció el plazo de acuse: aviso a la contraparte del cliente (2 mensajes en cola).'
            and e.created_at = now() + interval '241 minutes'),
  'el aviso a la contraparte queda en la línea de tiempo interna');

select nexo_private.sd_tick(now() + interval '242 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte' and payload ->> 'metrica' = 'acuse'),
  2, 'repetir el tick no repite el aviso a la contraparte');

-- Reclasificar devuelve el reloj a «en curso»; si vuelve a vencer, no se avisa de nuevo.
update public.nexo_sd_tickets set classification_answers = :'s3' where id = :'t_v';
select nexo_test.eq((select status from public.nexo_sd_sla_clocks where ticket_id = :'t_v' and metric = 'acuse'),
  'en_curso', 'al reclasificar a S3 el acuse vuelve a correr en horario hábil');
select nexo_private.sd_tick(now() + interval '30 days') is not null as tick;
select nexo_test.eq((select status from public.nexo_sd_sla_clocks where ticket_id = :'t_v' and metric = 'acuse'),
  'incumplido', 'el acuse vuelve a vencer');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte' and payload ->> 'metrica' = 'acuse'),
  2, 'un solo aviso a la contraparte por vencimiento de cada plazo');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events
   where ticket_id = :'t_v' and payload ->> 'plantilla' = 'sd_sla_vencido_contraparte' and payload ->> 'metrica' = 'acuse'),
  1, 'y un solo registro en la línea de tiempo');
select nexo_test.ok(
  (select bool_and(n.status = 'pendiente') from public.nexo_sd_notifications n
   where n.ticket_id = :'t_v' and n.template = 'sd_sla_vencido_contraparte'),
  'los avisos a la contraparte quedan en la bandeja de salida para nexo-sd-notify');
select nexo_test.eq(
  (select count(distinct payload ->> 'metrica')::int from public.nexo_sd_notifications
   where ticket_id = :'t_v' and template = 'sd_sla_vencido_contraparte'),
  3, 'también se avisa el vencimiento del diagnóstico y de la solución');

-- Un hito cumplido después del vencimiento, antes de que corra el tick, también avisa.
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('cliente-demo'), 'Acuse tardío S1', :'s1', now() - interval '2 hours', 'test:tarde');
select id as t_tarde from public.nexo_sd_tickets where external_ref = 'test:tarde' \gset
update public.nexo_sd_tickets set status = 'acusado' where id = :'t_tarde';
select nexo_test.eq((select status from public.nexo_sd_sla_clocks where ticket_id = :'t_tarde' and metric = 'acuse'),
  'incumplido', 'un acuse fuera de plazo deja el reloj incumplido');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications
   where ticket_id = :'t_tarde' and template = 'sd_sla_vencido_contraparte' and payload ->> 'metrica' = 'acuse'),
  2, 'y avisa a la contraparte aunque el tick no lo haya marcado');

-- ---------------------------------------------------------------------------
-- C) Aviso sin proveedor configurado: «fallida», no «enviada»
-- ---------------------------------------------------------------------------
insert into public.nexo_sd_notifications (channel, recipient, ticket_id, template, payload, dedup_key) values
  ('email', 'a@ejemplo.invalid', :'t_v', 'sd_prueba', '{"destinatario": "Persona de prueba"}', 'prueba10:1'),
  ('whatsapp', '+56900000001', :'t_v', 'sd_prueba', '{}', 'prueba10:2');
update public.nexo_sd_notifications set attempts = 1 where dedup_key like 'prueba10:%';
select id as n1 from public.nexo_sd_notifications where dedup_key = 'prueba10:1' \gset
select id as n2 from public.nexo_sd_notifications where dedup_key = 'prueba10:2' \gset
select nexo_test.ok(
  (select status = 'fallida' and sent_at is null and last_error like 'resend: proveedor no configurado%'
   from public.nexo_sd_complete_notification(:'n1', false,
     '{"sin_proveedor": true, "proveedor": "resend", "motivo": "falta RESEND_API_KEY"}'::jsonb,
     'resend: proveedor no configurado (falta RESEND_API_KEY)', true)),
  'sin proveedor el aviso queda fallido al primer intento, sin fecha de envío');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events e
          where e.ticket_id = :'t_v' and e.type = 'notification' and e.visibility = 'interno'
            and e.body = 'No se envió el aviso por email a Persona de prueba: el proveedor del canal no está configurado.'
            and e.payload ->> 'sin_proveedor' = 'true'),
  'el aviso sin proveedor queda en la línea de tiempo interna del ticket');
select nexo_test.ok(
  (select status = 'fallida' and sent_at is null and last_error = 'Proveedor del canal no configurado'
   from public.nexo_sd_complete_notification(:'n2', true, '{"simulado": true}'::jsonb, null)),
  'un envío simulado informado como correcto (versión anterior de nexo-sd-notify) también queda fallido');

-- ---------------------------------------------------------------------------
-- D) Nivel 3 = supervisión
-- ---------------------------------------------------------------------------
select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.throws(
  $$insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at)
    values (nexo_test.uid('agente2.demo@yago.invalid'), 3, now() + interval '40 days', now() + interval '41 days')$$,
  'el nivel 3 es supervisión: no se asigna a un agente', '23514');
insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at)
values (nexo_test.uid('supervisor.demo@yago.invalid'), 3, now() + interval '40 days', now() + interval '41 days');
select nexo_test.ok(true, 'un turno de nivel 3 se asigna a un supervisor');
reset role;

-- Un turno de nivel 3 de un agente creado antes de esta versión no cuenta como supervisión.
alter table public.nexo_sd_oncall_shifts disable trigger nexo_sd_oncall_shifts_validate;
insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at)
values (nexo_test.uid('agente2.demo@yago.invalid'), 3, now() - interval '1 hour', now() + interval '1 day');
alter table public.nexo_sd_oncall_shifts enable trigger nexo_sd_oncall_shifts_validate;
select nexo_test.eq(
  (select string_agg(u::text, ',') from nexo_private.sd_oncall_users(3, now()) as u),
  nexo_test.uid('supervisor.demo@yago.invalid')::text,
  'el aviso al nivel 3 llega solo a supervisores');

insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref, is_security_incident)
values (nexo_test.org('cliente-demo'), 'Incidente con ticket', :'s2', now(), 'test:incidente', true);
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
          where t.external_ref = 'test:incidente' and e.type = 'security'
            and e.body = 'Incidente de seguridad registrado (Ley 21.663): se avisó a supervisión (nivel 3).'),
  'el registro del incidente dice que se avisó a supervisión (nivel 3)');

rollback;
