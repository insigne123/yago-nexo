-- Canal entrante (correo y WhatsApp), cuarentena, bandeja de salida con reintentos y
-- resumen mensual del SLA.
begin;

\set s1 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'
\set s4 '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'

-- ---------------------------------------------------------------------------
-- Canal entrante
-- ---------------------------------------------------------------------------
select nexo_test.eq(
  public.nexo_sd_inbound_message('email', 'Reportante.Demo@SUBTEL.invalid', 'Camila', 'El portal no carga',
    'Desde las 08:00 el portal de desarrolladores no carga.', 'msg-001', now() - interval '2 minutes') ->> 'resultado',
  'ticket', 'un correo de un miembro registrado crea un ticket');
select id as t_mail, number as n_mail from public.nexo_sd_tickets where external_ref = 'email:msg-001' \gset
select nexo_test.ok(
  (select org_id = nexo_test.org('subtel-demo') and reporter_id = nexo_test.uid('reportante.demo@subtel.invalid')
      and channel = 'email' and intake_status = 'aceptado'
   from public.nexo_sd_tickets where id = :'t_mail'),
  'el remitente se asocia a su organización y queda como reportante (correo sin distinguir mayúsculas)');
select nexo_test.eq(
  (select severity || '/' || classification_source from public.nexo_sd_tickets where id = :'t_mail'),
  'S1/provisional', 'sin asistente la severidad es provisional (S1 según la configuración)');
select nexo_test.eq(
  (select sla_started_at from public.nexo_sd_tickets where id = :'t_mail'), now() - interval '2 minutes',
  'el SLA parte cuando llegó el mensaje');
select nexo_test.eq((select count(*)::int from public.nexo_sd_sla_clocks where ticket_id = :'t_mail'), 3,
  'el ticket del correo tiene sus relojes');
select nexo_test.eq(
  public.nexo_sd_inbound_message('email', 'reportante.demo@subtel.invalid', 'Camila', 'El portal no carga',
    'Repetido', 'msg-001', now()) ->> 'resultado',
  'duplicado', 'el mismo mensaje no crea un segundo ticket');

select nexo_test.eq(
  public.nexo_sd_inbound_message('email', 'reportante.demo@subtel.invalid', 'Camila', 'Re: [' || :'n_mail' || '] El portal no carga',
    'Ya volvió a cargar, pero lento.', 'msg-002', now()) ->> 'resultado',
  'comentario', 'una respuesta con el número del ticket se agrega como comentario');
select nexo_test.ok(
  (select author_id = nexo_test.uid('reportante.demo@subtel.invalid') and visibility = 'publico'
   from public.nexo_sd_ticket_events where payload ->> 'external_ref' = 'email:msg-002'),
  'el comentario queda a nombre del remitente');

select nexo_test.eq(
  public.nexo_sd_inbound_message('email', 'alguien@desconocido.invalid', 'Alguien', 'Hola',
    'Necesito ayuda con la API.', 'msg-003', now()) ->> 'resultado',
  'cuarentena', 'un remitente desconocido queda en cuarentena');
select id as t_cuar from public.nexo_sd_tickets where external_ref = 'email:msg-003' \gset
select nexo_test.ok(
  (select org_id is null and intake_status = 'cuarentena' and sla_started_at is null
   from public.nexo_sd_tickets where id = :'t_cuar'),
  'el ticket en cuarentena no tiene organización ni SLA');
select nexo_test.eq((select count(*)::int from public.nexo_sd_sla_clocks where ticket_id = :'t_cuar'), 0,
  'en cuarentena no corren relojes');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_notifications where ticket_id = :'t_cuar' and template = 'sd_ticket_cuarentena'
          and recipient_user_id = nexo_test.uid('agente1.demo@yago.invalid')),
  'el nivel 1 recibe aviso para revisar la cuarentena');
select nexo_test.eq(
  public.nexo_sd_inbound_message('email', 'agente1.demo@yago.invalid', 'Agente', 'Prueba', 'Sin número de ticket',
    'msg-004', now()) ->> 'resultado',
  'cuarentena', 'el personal de Yago no abre tickets por correo sin número (queda en cuarentena)');

update public.nexo_sd_members set phone_e164 = '+56922222222' where email = 'contraparte.demo@subtel.invalid';
select nexo_test.eq(
  public.nexo_sd_inbound_message('whatsapp', '56922222222', 'Diego', null,
    'La API de concesiones responde 500 a todos.', 'wamid.ABC', now() - interval '3 days') ->> 'resultado',
  'ticket', 'un WhatsApp de un número registrado crea un ticket');
select nexo_test.ok(
  (select reporter_id = nexo_test.uid('contraparte.demo@subtel.invalid') and channel = 'whatsapp'
      and channel_sender = '+56922222222' and title = 'La API de concesiones responde 500 a todos.'
      and created_at = now()
   from public.nexo_sd_tickets where external_ref = 'whatsapp:wamid.ABC'),
  'el número se normaliza, el título sale del texto y una fecha antigua se reemplaza por la recepción');

-- Revisión de la cuarentena por un agente.
select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_accept_quarantined_ticket('$$ || :'t_cuar' || $$', nexo_test.org('subtel-demo'), nexo_test.uid('agente2.demo@yago.invalid'), null)$$,
  'el reportante asignado debe ser de la organización', '23514');
select public.nexo_sd_accept_quarantined_ticket(:'t_cuar', nexo_test.org('subtel-demo'),
  nexo_test.uid('reportante.demo@subtel.invalid'), :'s3');
reset role;
select nexo_test.ok(
  (select intake_status = 'aceptado' and org_id = nexo_test.org('subtel-demo') and severity = 'S3'
      and classification_source = 'asistente' and sla_started_at = now()
   from public.nexo_sd_tickets where id = :'t_cuar'),
  'al aceptar se asigna la organización, se clasifica con el asistente y el SLA parte en ese momento');
select nexo_test.eq(
  (select string_agg(metric || '=' || target_minutes, ',' order by metric) from public.nexo_sd_sla_clocks where ticket_id = :'t_cuar'),
  'acuse=480,diagnostico=1620,solucion=5400', 'el ticket aceptado tiene los relojes de S3');
select id as t_cuar2 from public.nexo_sd_tickets where external_ref = 'email:msg-004' \gset
select nexo_test.login('agente1.demo@yago.invalid');
select public.nexo_sd_discard_quarantined_ticket(:'t_cuar2', 'Mensaje de prueba interna');
reset role;
select nexo_test.eq(
  (select intake_status || '/' || status from public.nexo_sd_tickets where id = :'t_cuar2'), 'descartado/cerrado',
  'descartar cierra el ticket en cuarentena');

-- ---------------------------------------------------------------------------
-- Bandeja de salida (nexo-sd-notify): toma, reintentos con espera creciente y tope de intentos
-- ---------------------------------------------------------------------------
update public.nexo_sd_notifications set status = 'enviada' where status = 'pendiente';
insert into public.nexo_sd_notifications (channel, recipient, ticket_id, template, priority, next_attempt_at, dedup_key) values
  ('email', 'a@ejemplo.invalid', :'t_mail', 'sd_prueba', 3, now() - interval '1 minute', 'prueba:1'),
  ('email', 'b@ejemplo.invalid', :'t_mail', 'sd_prueba', 1, now() + interval '10 minutes', 'prueba:2'),
  ('push', 'c', :'t_mail', 'sd_prueba', 5, now() - interval '1 minute', 'prueba:3');
select nexo_test.eq(
  (select string_agg(dedup_key || '#' || attempts, ',' order by priority) from public.nexo_sd_claim_notifications(10)),
  'prueba:1#1,prueba:3#1', 'se toman los pendientes vencidos por prioridad y se cuenta el intento');
select nexo_test.eq((select count(*)::int from public.nexo_sd_claim_notifications(10)), 0,
  'los avisos tomados quedan bloqueados para otra ejecución');
select id as n1 from public.nexo_sd_notifications where dedup_key = 'prueba:1' \gset
select id as n3 from public.nexo_sd_notifications where dedup_key = 'prueba:3' \gset
select nexo_test.ok(
  (select status = 'pendiente' and locked_until is null and last_error = 'timeout'
      and next_attempt_at = now() + interval '60 seconds'
   from public.nexo_sd_complete_notification(:'n1', false, null, 'timeout')),
  'un fallo deja el aviso pendiente y lo reprograma en 1 minuto');
select nexo_test.eq(
  (select string_agg(s::text, ',' order by a) from unnest(array[1, 2, 3, 4, 5, 7]) as a,
     lateral nexo_private.sd_backoff_seconds(a) as s),
  '60,120,240,480,960,1800', 'la espera crece al doble con tope de 30 minutos');
update public.nexo_sd_notifications set attempts = 5 where id = :'n1';
select nexo_test.eq((select status from public.nexo_sd_complete_notification(:'n1', false, null, 'HTTP 500')), 'fallida',
  'al quinto intento fallido el aviso queda como fallido');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events where ticket_id = :'t_mail' and type = 'notification'
          and body like 'Falló el aviso por email%'),
  'un aviso fallido queda en la línea de tiempo interna');
select nexo_test.ok(
  (select status = 'enviada' and sent_at is not null and result ->> 'simulado' = 'true'
   from public.nexo_sd_complete_notification(:'n3', true, '{"simulado": true}'::jsonb, null)),
  'un envío correcto (o simulado) queda como enviado');
select nexo_test.eq((select status from public.nexo_sd_complete_notification(:'n3', false, null, 'tarde')), 'enviada',
  'completar un aviso ya enviado no lo cambia');
insert into public.nexo_sd_notifications (channel, recipient, ticket_id, template, dedup_key)
values ('email', 'direccion-invalida', :'t_mail', 'sd_prueba', 'prueba:4');
select id as n4 from public.nexo_sd_notifications where dedup_key = 'prueba:4' \gset
update public.nexo_sd_notifications set attempts = 1 where id = :'n4';
select nexo_test.eq(
  (select status from public.nexo_sd_complete_notification(:'n4', false, null, 'HTTP 422: dirección inválida', true)),
  'fallida', 'un rechazo definitivo del proveedor no se reintenta');

-- ---------------------------------------------------------------------------
-- Resumen mensual con datos controlados (julio de 2026)
-- ---------------------------------------------------------------------------
insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('subtel-demo'), 'Julio S1 a tiempo', :'s1', nexo_test.cl('2026-07-10 10:00'), 'test:jul-a'),
  (nexo_test.org('subtel-demo'), 'Julio S1 con atraso', :'s1', nexo_test.cl('2026-07-20 10:00'), 'test:jul-b'),
  (nexo_test.org('subtel-demo'), 'Julio S4', :'s4', nexo_test.cl('2026-07-15 10:00'), 'test:jul-c');
insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at)
select id, 'red', 'Corte de enlace del proveedor durante 10 minutos.', created_at + interval '10 minutes'
from public.nexo_sd_tickets where external_ref = 'test:jul-b';
update public.nexo_sd_clock_pauses p set ended_at = p.started_at + interval '10 minutes'
  from public.nexo_sd_tickets t where t.id = p.ticket_id and t.external_ref = 'test:jul-b';
update public.nexo_sd_tickets t set status = 'resuelto', acknowledged_at = t.created_at + interval '30 minutes',
       diagnosed_at = t.created_at + interval '90 minutes', resolved_at = t.created_at + interval '200 minutes'
 where t.external_ref = 'test:jul-a';
update public.nexo_sd_tickets t set status = 'resuelto', acknowledged_at = t.created_at + interval '90 minutes',
       diagnosed_at = t.created_at + interval '100 minutes', resolved_at = t.created_at + interval '300 minutes'
 where t.external_ref = 'test:jul-b';
update public.nexo_sd_tickets t set status = 'acusado', acknowledged_at = t.created_at + interval '2 hours'
 where t.external_ref = 'test:jul-c';

select nexo_test.eq(
  (select string_agg(format('%s %s: %s/%s/%s %s%% prom %s máx %s', severity, metric, total, met_on_time, breached,
                            coalesce(compliance_pct::text, '-'), coalesce(avg_effective_minutes::text, '-'),
                            coalesce(max_effective_minutes::text, '-')), ' | ' order by severity, metric)
   from public.nexo_sd_sla_summary('2026-07', nexo_test.org('subtel-demo')) where total > 0),
  'S1 acuse: 2/1/1 50.00% prom 55.0 máx 80.0 | S1 diagnostico: 2/2/0 100.00% prom 90.0 máx 90.0 | '
  || 'S1 solucion: 2/1/1 50.00% prom 245.0 máx 290.0 | S4 acuse: 1/1/0 100.00% prom 120.0 máx 120.0',
  'cumplimiento por severidad y métrica, con minutos efectivos (sin pausas) y hábiles para S4');
select nexo_test.eq((select count(*)::int from public.nexo_sd_sla_summary('2026-07', nexo_test.org('subtel-demo'))), 10,
  'el resumen trae todas las métricas comprometidas aunque no tengan casos (S1-S3: 3, S4: 1)');
select nexo_test.throws($$select * from public.nexo_sd_sla_summary('julio')$$, 'el período debe ser AAAA-MM', '22023');

select public.nexo_sd_monthly_report_data('2026-07', nexo_test.org('subtel-demo')) as informe \gset
select nexo_test.ok(
  (select (d -> 'tickets' ->> 'total') = '3' and (d -> 'tickets' -> 'por_severidad') = '{"S1": 2, "S4": 1}'::jsonb
      and jsonb_array_length(d -> 'resumen') = 10 and jsonb_array_length(d -> 'incumplimientos') = 2
      and (d -> 'pausas' -> 0 ->> 'motivo') = 'red' and (d -> 'pausas' -> 0 ->> 'minutos')::numeric = 10
   from (select (:'informe')::jsonb as d) x),
  'los datos del informe incluyen tickets, resumen, pausas e incumplimientos');
select public.nexo_sd_record_monthly_report(nexo_test.org('subtel-demo'), '2026-07', (:'informe')::jsonb,
  'informes/' || nexo_test.org('subtel-demo') || '/2026-07.pdf', null) as rep1 \gset
select public.nexo_sd_record_monthly_report(nexo_test.org('subtel-demo'), '2026-07', (:'informe')::jsonb,
  'informes/' || nexo_test.org('subtel-demo') || '/2026-07.pdf', null) as rep2 \gset
select nexo_test.eq(:'rep1'::uuid, :'rep2'::uuid, 'regenerar el informe del mismo mes lo reemplaza');
select nexo_test.ok(
  (select count(distinct recipient_user_id) = 2 from public.nexo_sd_notifications where template = 'sd_informe_mensual'),
  'la contraparte y el reportante reciben el aviso del informe');
select nexo_test.login('reportante.demo@subtel.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_monthly_reports where period = '2026-07'), 1,
  'la organización ve su informe mensual');
select nexo_test.ok(public.nexo_sd_mark_notifications_read(null) >= 1, 'el reportante marca sus avisos como leídos');
select nexo_test.eq(
  (select count(*)::int from public.nexo_sd_notifications
   where recipient_user_id = nexo_test.uid('reportante.demo@subtel.invalid') and read_at is null), 0,
  'ya no le quedan avisos sin leer');
select nexo_test.login('sin.membresia@ejemplo.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_monthly_reports), 0, 'sin membresía no ve informes');
reset role;

rollback;
