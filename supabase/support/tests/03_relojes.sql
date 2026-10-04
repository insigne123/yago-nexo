-- Relojes SLA: creación según la política de cada severidad, correlativo, hitos por estado,
-- transiciones válidas y recálculo al reclasificar.
begin;

\set s1 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s2 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'
\set s4 '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'

-- Como backend (puede fijar created_at): dos tickets 24x7 recientes y dos hábiles el viernes 09-10 16:00.
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('subtel-demo'), 'Reloj S1', :'s1', now() - interval '10 minutes', 'test:s1'),
  (nexo_test.org('subtel-demo'), 'Reloj S2', :'s2', now() - interval '5 hours', 'test:s2'),
  (nexo_test.org('subtel-demo'), 'Reloj S3', :'s3', nexo_test.cl('2026-10-09 16:00'), 'test:s3'),
  (nexo_test.org('subtel-demo'), 'Reloj S4', :'s4', nexo_test.cl('2026-10-09 16:00'), 'test:s4');

create temp view relojes as
  select t.external_ref as ref, c.*
  from public.nexo_sd_sla_clocks c
  join public.nexo_sd_tickets t on t.id = c.ticket_id
  where t.external_ref like 'test:%';
grant select on relojes to public;

select nexo_test.eq((select count(*)::int from relojes), 12, 'cada ticket aceptado crea sus tres relojes');

select nexo_test.eq(
  (select string_agg(metric || '=' || target_minutes || '/' || calendar, ',' order by metric) from relojes where ref = 'test:s1'),
  'acuse=60/24x7,diagnostico=120/24x7,solucion=240/24x7', 'S1: 60 / 120 / 240 minutos corridos');
select nexo_test.eq(
  (select string_agg(metric || '=' || target_minutes || '/' || calendar, ',' order by metric) from relojes where ref = 'test:s2'),
  'acuse=240/24x7,diagnostico=480/24x7,solucion=1440/24x7', 'S2: 240 / 480 / 1440 minutos corridos');
select nexo_test.eq(
  (select string_agg(metric || '=' || target_minutes || '/' || calendar, ',' order by metric) from relojes where ref = 'test:s3'),
  'acuse=480/habil,diagnostico=1620/habil,solucion=5400/habil', 'S3: 8 horas, 3 días y 10 días hábiles');
select nexo_test.eq(
  (select string_agg(metric || '=' || coalesce(target_minutes::text, '-') || '/' || status, ',' order by metric)
   from relojes where ref = 'test:s4'),
  'acuse=540/en_curso,diagnostico=-/no_aplica,solucion=-/no_aplica', 'S4: solo acuse en 1 día hábil');

select nexo_test.eq(
  (select due_at - started_at from relojes where ref = 'test:s1' and metric = 'acuse'),
  interval '60 minutes', 'S1: el acuse vence 60 minutos después de la recepción');
select nexo_test.eq(
  (select started_at from relojes where ref = 'test:s1' and metric = 'acuse'),
  (select created_at from public.nexo_sd_tickets where external_ref = 'test:s1'),
  'el reloj parte en la recepción del ticket');
select nexo_test.eq(
  (select due_at from relojes where ref = 'test:s3' and metric = 'acuse'),
  nexo_test.cl('2026-10-13 15:00'), 'S3: acuse del viernes 16:00 vence el martes 13-10 15:00 (lunes feriado)');
select nexo_test.eq(
  (select due_at from relojes where ref = 'test:s3' and metric = 'diagnostico'),
  nexo_test.cl('2026-10-15 16:00'), 'S3: diagnóstico vence 3 días hábiles después (jueves 15-10 16:00)');
select nexo_test.eq(
  (select due_at from relojes where ref = 'test:s3' and metric = 'solucion'),
  nexo_test.cl('2026-10-26 16:00'), 'S3: solución vence 10 días hábiles después (lunes 26-10 16:00)');
select nexo_test.eq(
  (select due_at from relojes where ref = 'test:s4' and metric = 'acuse'),
  nexo_test.cl('2026-10-13 16:00'), 'S4: acuse vence 1 día hábil después (martes 13-10 16:00)');

-- Correlativo
select nexo_test.ok(
  (select bool_and(number ~ '^SD-2026-[0-9]{4}$') from public.nexo_sd_tickets where external_ref like 'test:s%'),
  'el número tiene el formato SD-AAAA-NNNN');
select nexo_test.eq(
  (select count(distinct number)::int from public.nexo_sd_tickets where external_ref like 'test:s%'), 4,
  'cada ticket tiene un número distinto');
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('subtel-demo'), 'Fin de año', :'s4', nexo_test.cl('2026-12-31 23:30'), 'test:anio-2026'),
  (nexo_test.org('subtel-demo'), 'Año nuevo', :'s4', nexo_test.cl('2027-01-01 00:30'), 'test:anio-2027');
select nexo_test.eq((select number from public.nexo_sd_tickets where external_ref = 'test:anio-2027'), 'SD-2027-0001',
  'el correlativo se reinicia con el año local (01-01-2027 00:30 en Santiago)');
select nexo_test.ok((select number like 'SD-2026-%' from public.nexo_sd_tickets where external_ref = 'test:anio-2026'),
  'el 31-12 a las 23:30 en Santiago sigue siendo 2026 aunque en UTC ya sea 2027');

select nexo_test.ok(
  (select bool_and(sla_started_at = created_at and escalation_level = 1) from public.nexo_sd_tickets where external_ref like 'test:s%'),
  'el SLA parte con la recepción y el ticket queda avisado al nivel 1');
select nexo_test.ok(
  (select count(*) >= 2 from public.nexo_sd_notifications n
   join public.nexo_sd_tickets t on t.id = n.ticket_id
   where t.external_ref = 'test:s1' and n.template = 'sd_ticket_nuevo'
     and n.recipient_user_id = nexo_test.uid('agente1.demo@yago.invalid')),
  'un ticket nuevo avisa al turno de nivel 1 (push y correo)');
select nexo_test.ok(
  (select count(*) = 1 from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:s1' and e.type = 'status_change' and e.visibility = 'publico'),
  'la recepción queda en la línea de tiempo pública');

-- Hitos al cambiar de estado
update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:s1';
select nexo_test.eq((select status from relojes where ref = 'test:s1' and metric = 'acuse'), 'cumplido',
  'acusado marca el acuse como cumplido (10 min < 60 min)');
select nexo_test.eq(
  (select met_at from relojes where ref = 'test:s1' and metric = 'acuse'),
  (select acknowledged_at from public.nexo_sd_tickets where external_ref = 'test:s1'),
  'met_at del acuse es el instante del acuse');
select nexo_test.eq((select status from relojes where ref = 'test:s1' and metric = 'diagnostico'), 'en_curso',
  'el diagnóstico sigue corriendo');

update public.nexo_sd_tickets set status = 'resuelto' where external_ref = 'test:s1';
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:s1'),
  'acuse=cumplido,diagnostico=cumplido,solucion=cumplido', 'saltar a resuelto marca también diagnóstico y solución');
select nexo_test.ok(
  (select diagnosed_at is not null and resolved_at is not null and workaround_at is null
   from public.nexo_sd_tickets where external_ref = 'test:s1'),
  'se registran los instantes de diagnóstico y resolución');

update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:s2';
select nexo_test.eq((select status from relojes where ref = 'test:s2' and metric = 'acuse'), 'incumplido',
  'un acuse después de 5 horas incumple el plazo S2 de 4 horas');
select nexo_test.eq(
  (select breached_at from relojes where ref = 'test:s2' and metric = 'acuse'),
  (select due_at from relojes where ref = 'test:s2' and metric = 'acuse'),
  'breached_at es el vencimiento');

update public.nexo_sd_tickets set status = 'solucion_temporal' where external_ref = 'test:s2';
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:s2'),
  'acuse=incumplido,diagnostico=cumplido,solucion=cumplido', 'la solución temporal cumple el plazo de solución');
select nexo_test.ok((select workaround_at is not null from public.nexo_sd_tickets where external_ref = 'test:s2'),
  'se registra el instante de la solución temporal');

update public.nexo_sd_tickets set status = 'en_diagnostico' where external_ref = 'test:s2';
select nexo_test.eq((select status from public.nexo_sd_tickets where external_ref = 'test:s2'), 'en_diagnostico',
  'desde la solución temporal se puede volver a diagnóstico');
select nexo_test.throws($$update public.nexo_sd_tickets set status = 'nuevo' where external_ref = 'test:s2'$$,
  'un ticket no vuelve a nuevo', '23514');
select nexo_test.throws($$update public.nexo_sd_tickets set status = 'cerrado' where external_ref = 'test:s2'$$,
  'solo se cierra un ticket resuelto', '23514');
update public.nexo_sd_tickets set status = 'resuelto' where external_ref = 'test:s2';
update public.nexo_sd_tickets set status = 'cerrado' where external_ref = 'test:s2';
select nexo_test.ok((select closed_at is not null from public.nexo_sd_tickets where external_ref = 'test:s2'),
  'cerrar registra closed_at');
select nexo_test.throws($$update public.nexo_sd_tickets set status = 'en_diagnostico' where external_ref = 'test:s2'$$,
  'un ticket cerrado no cambia de estado', '23514');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:s2' and e.type = 'status_change'),
  6, 'cada cambio de estado queda en la línea de tiempo (recepción + 5 cambios)');

-- Reclasificación: la severidad cambia solo por las respuestas y los relojes se recalculan.
update public.nexo_sd_tickets set classification_answers = :'s1' where external_ref = 'test:s3';
select nexo_test.eq(
  (select severity || '/' || classification_source from public.nexo_sd_tickets where external_ref = 'test:s3'),
  'S1/reclasificacion', 'reclasificar con el asistente cambia la severidad');
select nexo_test.eq(
  (select string_agg(metric || '=' || target_minutes || '/' || calendar || '@' ||
          to_char(due_at at time zone 'America/Santiago', 'DD-MM HH24:MI'), ',' order by metric)
   from relojes where ref = 'test:s3'),
  'acuse=60/24x7@09-10 17:00,diagnostico=120/24x7@09-10 18:00,solucion=240/24x7@09-10 20:00',
  'al pasar de S3 a S1 los plazos se recalculan desde la recepción en minutos corridos');
update public.nexo_sd_tickets set classification_answers = :'s2' where external_ref = 'test:s4';
select nexo_test.eq(
  (select string_agg(metric || '=' || coalesce(target_minutes::text, '-') || '/' || status, ',' order by metric)
   from relojes where ref = 'test:s4'),
  'acuse=240/en_curso,diagnostico=480/en_curso,solucion=1440/en_curso', 'S4 a S2: los relojes sin plazo pasan a correr');
select nexo_test.ok(
  (select count(*) = 1 from public.nexo_sd_ticket_events e join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:s4' and e.type = 'reclassification' and e.payload ->> 'de' = 'S4'
     and e.payload ->> 'a' = 'S2'),
  'la reclasificación queda en la línea de tiempo');
select nexo_test.throws($$update public.nexo_sd_tickets set severity = 'S4' where external_ref = 'test:s4'$$,
  'la severidad no se cambia sin las respuestas del asistente', '23514');

rollback;
