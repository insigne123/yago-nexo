-- sd_tick(): vencimientos, avisos al 50/80/100 % a la cadena de turno, escalamiento de S1 sin
-- acuse (nivel 1 -> 2 -> 3 cada 10 minutos), hitos de la Ley 21.663 y despacho por pg_net.
-- Turnos de la semilla: nivel 1 agente1, nivel 2 agente2, nivel 3 supervisor.
begin;

\set s1 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s2 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'

-- Teléfonos sintéticos (solo dentro de esta transacción) para probar WhatsApp y voz.
update public.nexo_sd_members set phone_e164 = '+56900000002', whatsapp_opt_in = true, voice_opt_in = true
 where email = 'agente2.demo@yago.invalid';
update public.nexo_sd_members set phone_e164 = '+56900000003', whatsapp_opt_in = true, voice_opt_in = true
 where email = 'supervisor.demo@yago.invalid';

insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('cliente-demo'), 'Tick S2', :'s2', now(), 'test:t2'),
  (nexo_test.org('cliente-demo'), 'Tick S3 hábil', :'s3', nexo_test.cl('2026-10-05 10:00'), 'test:t3');

create temp view avisos as
  select t.external_ref as ref, n.*
  from public.nexo_sd_notifications n
  join public.nexo_sd_tickets t on t.id = n.ticket_id
  where t.external_ref like 'test:%';
create temp view relojes as
  select t.external_ref as ref, c.*
  from public.nexo_sd_sla_clocks c
  join public.nexo_sd_tickets t on t.id = c.ticket_id
  where t.external_ref like 'test:%';

-- A) S2 (acuse 240 min): umbrales 50 %, 80 % y 100 %.
select nexo_private.sd_tick(now() + interval '119 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from avisos where ref = 'test:t2' and template in ('sd_sla_umbral', 'sd_sla_vencido')), 0,
  'al 49 % del acuse no hay avisos');

select nexo_private.sd_tick(now() + interval '121 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from avisos
   where ref = 'test:t2' and template = 'sd_sla_umbral' and payload ->> 'umbral' = '50' and payload ->> 'metrica' = 'acuse'),
  2, 'al 50 % del acuse se avisa al nivel 1 (push y correo)');
select nexo_test.ok(
  (select bool_and(recipient_user_id = nexo_test.uid('agente1.demo@yago.invalid')) from avisos
   where ref = 'test:t2' and template = 'sd_sla_umbral' and payload ->> 'umbral' = '50'),
  'el aviso del 50 % va a la persona de turno de nivel 1');
select nexo_test.ok((select notified_50_at is not null from relojes where ref = 'test:t2' and metric = 'acuse'),
  'el reloj registra que se avisó el 50 %');

select nexo_private.sd_tick(now() + interval '121 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from avisos where ref = 'test:t2' and template = 'sd_sla_umbral' and payload ->> 'umbral' = '50'),
  2, 'repetir el tick no duplica avisos');

select nexo_private.sd_tick(now() + interval '193 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from avisos where ref = 'test:t2' and template = 'sd_sla_umbral' and payload ->> 'umbral' = '80'),
  5, 'al 80 % se avisa a los niveles 1 y 2 (nivel 2 también por WhatsApp)');
select nexo_test.ok(
  exists (select 1 from avisos where ref = 'test:t2' and payload ->> 'umbral' = '80' and channel = 'whatsapp'
          and recipient = '+56900000002'),
  'el nivel 2 recibe el aviso por WhatsApp a su número');

select nexo_private.sd_tick(now() + interval '241 minutes') is not null as tick;
select nexo_test.eq((select status from relojes where ref = 'test:t2' and metric = 'acuse'), 'incumplido',
  'al 100 % el acuse queda incumplido');
select nexo_test.eq(
  (select breached_at - started_at from relojes where ref = 'test:t2' and metric = 'acuse'),
  interval '240 minutes', 'breached_at es el instante del vencimiento');
select nexo_test.eq(
  (select count(distinct recipient_user_id)::int from avisos where ref = 'test:t2' and template = 'sd_sla_vencido'),
  3, 'el vencimiento se avisa a los niveles 1, 2 y 3');
select nexo_test.eq(
  (select count(*)::int from avisos where ref = 'test:t2' and template = 'sd_sla_vencido' and channel = 'voz'), 0,
  'en S2 el vencimiento no llama por voz');
select nexo_test.eq(
  (select count(*)::int from avisos where ref = 'test:t2' and template = 'sd_sla_umbral' and payload ->> 'umbral' = '50'
     and payload ->> 'metrica' = 'diagnostico'),
  2, 'el diagnóstico (480 min) llega a su 50 % en el mismo tick');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:t2' and e.type = 'escalation' and e.visibility = 'interno'),
  4, 'cada umbral queda como escalamiento interno en la línea de tiempo');

-- B) S1 sin acuse: nivel 1 al recibir, nivel 2 a los 10 minutos y nivel 3 a los 20, con llamada.
--    (Se crean recién aquí: los ticks de la sección A usaron instantes posteriores.)
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('cliente-demo'), 'Tick S1 sin acuse', :'s1', now(), 'test:t1'),
  (nexo_test.org('cliente-demo'), 'Tick S1 acusado', :'s1', now(), 'test:t1b');
update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:t1b';
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 1,
  'el S1 nace avisado al nivel 1');
select nexo_private.sd_tick(now() + interval '9 minutes') is not null as tick;
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 1,
  'a los 9 minutos sin acuse todavía no se escala');
select nexo_private.sd_tick(now() + interval '10 minutes') is not null as tick;
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 2,
  'a los 10 minutos sin acuse se escala al nivel 2');
select nexo_test.eq(
  (select string_agg(channel, ',' order by channel) from avisos
   where ref = 'test:t1' and template = 'sd_escalamiento_acuse' and payload ->> 'nivel' = '2'),
  'email,push,voz,whatsapp', 'el nivel 2 recibe push, WhatsApp, correo y llamada de voz');
select nexo_private.sd_tick(now() + interval '15 minutes') is not null as tick;
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 2,
  'a los 15 minutos sigue en nivel 2');
select nexo_private.sd_tick(now() + interval '20 minutes') is not null as tick;
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 3,
  'a los 20 minutos sin acuse se escala al nivel 3');
select nexo_test.ok(
  exists (select 1 from avisos where ref = 'test:t1' and template = 'sd_escalamiento_acuse' and payload ->> 'nivel' = '3'
          and channel = 'voz' and recipient_user_id = nexo_test.uid('supervisor.demo@yago.invalid')),
  'el nivel 3 recibe la llamada de voz');
select nexo_private.sd_tick(now() + interval '40 minutes') is not null as tick;
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1'), 3,
  'el escalamiento por falta de acuse se detiene en el nivel 3');
select nexo_test.eq((select escalation_level from public.nexo_sd_tickets where external_ref = 'test:t1b'), 1,
  'un S1 acusado no se escala');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:t1' and e.type = 'escalation' and e.payload ->> 'motivo' = 'sin_acuse'),
  2, 'cada escalamiento por falta de acuse queda en la línea de tiempo');

-- C) S3 hábil: el 50 % llega a las 14:00 del lunes y el vencimiento a las 18:00.
select nexo_private.sd_tick(nexo_test.cl('2026-10-05 13:59')) is not null as tick;
select nexo_test.eq((select notified_50_at from relojes where ref = 'test:t3' and metric = 'acuse'), null::timestamptz,
  'S3: a las 13:59 no se llega al 50 % de 8 horas hábiles');
select nexo_private.sd_tick(nexo_test.cl('2026-10-05 14:00')) is not null as tick;
select nexo_test.ok((select notified_50_at is not null from relojes where ref = 'test:t3' and metric = 'acuse'),
  'S3: a las 14:00 se avisa el 50 %');
select nexo_test.ok(
  (select bool_and(channel in ('push', 'email')) from avisos where ref = 'test:t3' and template = 'sd_sla_umbral'),
  'S3 avisa por push y correo (sin WhatsApp)');
select nexo_private.sd_tick(nexo_test.cl('2026-10-05 17:59')) is not null as tick;
select nexo_test.eq((select status from relojes where ref = 'test:t3' and metric = 'acuse'), 'en_curso',
  'S3: a las 17:59 el acuse todavía está en curso');
select nexo_private.sd_tick(nexo_test.cl('2026-10-05 18:00')) is not null as tick;
select nexo_test.eq(
  (select status || '@' || to_char(breached_at at time zone 'America/Santiago', 'DD-MM HH24:MI') from relojes
   where ref = 'test:t3' and metric = 'acuse'),
  'incumplido@05-10 18:00', 'S3: a las 18:00 vence el acuse de 8 horas hábiles');

-- D) Incidente de seguridad: plazos de la Ley 21.663 desde la configuración.
insert into public.nexo_sd_security_incidents (title, detected_at, org_id)
values ('Incidente de prueba', now(), nexo_test.org('cliente-demo'));
select nexo_test.ok(
  (select early_alert_due_at = detected_at + interval '3 hours'
      and second_report_due_at = detected_at + interval '72 hours'
      and final_report_due_at = detected_at + interval '15 days'
   from public.nexo_sd_security_incidents where title = 'Incidente de prueba'),
  'los plazos se calculan con 3 horas, 72 horas y 15 días de la configuración');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_notifications n
          where n.template = 'sd_incidente_seguridad' and n.payload ->> 'incidente' = 'Incidente de prueba'
            and n.recipient_user_id = nexo_test.uid('supervisor.demo@yago.invalid') and n.channel = 'whatsapp'),
  'al registrar el incidente se avisa al nivel 3 por WhatsApp');
select nexo_private.sd_tick(now() + interval '91 minutes') is not null as tick;
select nexo_private.sd_tick(now() + interval '92 minutes') is not null as tick;
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications n
   where n.template = 'sd_incidente_plazo' and n.payload ->> 'incidente' = 'Incidente de prueba'
     and n.payload ->> 'hito' = 'alerta_temprana' and n.payload ->> 'umbral' = '50'),
  2, 'al 50 % del plazo de alerta temprana se avisa una sola vez (push y correo)');
select nexo_private.sd_tick(now() + interval '181 minutes') is not null as tick;
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_notifications n
          where n.template = 'sd_incidente_plazo' and n.payload ->> 'incidente' = 'Incidente de prueba'
            and n.payload ->> 'umbral' = '100' and n.channel = 'voz'),
  'vencida la alerta temprana se llama por voz');
update public.nexo_sd_security_incidents set early_alert_sent_at = detected_at + interval '2 hours'
 where title = 'Incidente de prueba';
select nexo_test.ok(
  (select final_report_due_at = early_alert_sent_at + interval '15 days'
   from public.nexo_sd_security_incidents where title = 'Incidente de prueba'),
  'el informe final se cuenta desde el envío de la alerta temprana');

-- E) Despacho de avisos con pg_net (requiere los secretos de Vault).
select nexo_test.eq(nexo_private.sd_dispatch_notifications(), null::bigint,
  'sin secretos en Vault el despacho no llama a la función (solo advierte)');
insert into vault.secrets_stub (name, decrypted_secret) values
  ('nexo_sd_project_url', 'https://proyecto-de-prueba.supabase.co/'),
  ('nexo_sd_cron_secret', 'secreto-de-prueba');
select nexo_test.ok(nexo_private.sd_dispatch_notifications() is not null, 'con avisos pendientes se invoca nexo-sd-notify');
select nexo_test.ok(
  (select url = 'https://proyecto-de-prueba.supabase.co/functions/v1/nexo-sd-notify'
      and headers ->> 'x-nexo-cron-secret' = 'secreto-de-prueba'
   from net.http_request_log order by id desc limit 1),
  'la llamada va a /functions/v1/nexo-sd-notify con la cabecera x-nexo-cron-secret');
select nexo_test.throws($$select nexo_private.sd_invoke_function('otra-funcion', '{}'::jsonb)$$,
  'solo se invocan funciones nexo-sd-*', '22023');
update public.nexo_sd_notifications set status = 'enviada' where status = 'pendiente';
select nexo_test.eq(nexo_private.sd_dispatch_notifications(), null::bigint, 'sin avisos pendientes no se invoca la función');

select nexo_test.eq(
  (select string_agg(jobname || ' ' || schedule, ', ' order by jobname) from cron.job where jobname like 'nexo_sd_%'),
  'nexo_sd_monthly_report 20 12 1 * *, nexo_sd_notify_dispatch * * * * *, nexo_sd_sla_tick * * * * *',
  'pg_cron programa sd_tick y el despacho cada minuto y el informe mensual');

rollback;
