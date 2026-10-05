-- Pausas del reloj: el tiempo en pausa no cuenta (corrido y hábil), solo motivos tipificados,
-- una pausa abierta por ticket, acceso remoto con pausa automática y acuse del cliente.
begin;

\set s1 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s2 '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}'
\set s3 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}'

insert into public.nexo_sd_tickets (org_id, title, classification_answers, created_at, external_ref) values
  (nexo_test.org('cliente-demo'), 'Pausa corrida', :'s2', now() - interval '60 minutes', 'test:p24'),
  (nexo_test.org('cliente-demo'), 'Pausa hábil', :'s3', nexo_test.cl('2026-10-05 10:00'), 'test:phab'),
  (nexo_test.org('cliente-demo'), 'Pausa tardía', :'s1', now() - interval '90 minutes', 'test:ptarde'),
  (nexo_test.org('cliente-demo'), 'Acceso remoto', :'s1', now() - interval '20 minutes', 'test:remoto'),
  (nexo_test.org('cliente-demo'), 'Acuse en pausa', :'s1', now() - interval '20 minutes', 'test:acuse');

create temp view relojes as
  select t.external_ref as ref, c.*
  from public.nexo_sd_sla_clocks c
  join public.nexo_sd_tickets t on t.id = c.ticket_id
  where t.external_ref like 'test:%';
create temp view pausas as
  select t.external_ref as ref, p.*
  from public.nexo_sd_clock_pauses p
  join public.nexo_sd_tickets t on t.id = p.ticket_id
  where t.external_ref like 'test:%';
-- Vistas del dueño (sin RLS) legibles también cuando la prueba actúa como un usuario.
grant select on relojes, pausas to public;

-- 1) Pausa en calendario corrido: 20 minutos que no cuentan.
insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at)
select id, 'red', 'Corte del enlace MPLS entre el CPD y GCP (proveedor de red).', now() - interval '30 minutes'
from public.nexo_sd_tickets where external_ref = 'test:p24';
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:p24'),
  'acuse=pausado,diagnostico=pausado,solucion=pausado', 'al pausar, los relojes en curso quedan en pausa');
select nexo_test.eq(
  (select remaining_seconds_at_pause from relojes where ref = 'test:p24' and metric = 'acuse'),
  (240 - 30) * 60::numeric, 'se congela lo que quedaba del acuse (210 minutos)');
update public.nexo_sd_clock_pauses set ended_at = now() - interval '10 minutes'
 where ticket_id = (select id from public.nexo_sd_tickets where external_ref = 'test:p24');
select nexo_test.eq(
  (select string_agg(metric || '=' || status || '/' || paused_seconds::int, ',' order by metric) from relojes where ref = 'test:p24'),
  'acuse=en_curso/1200,diagnostico=en_curso/1200,solucion=en_curso/1200', 'al reanudar se acumulan los 20 minutos de pausa');
select nexo_test.eq(
  (select due_at - started_at from relojes where ref = 'test:p24' and metric = 'acuse'),
  interval '260 minutes', 'el acuse vence 240 + 20 minutos después de la recepción');
select nexo_test.eq(
  (select due_at - started_at from relojes where ref = 'test:p24' and metric = 'solucion'),
  interval '1460 minutes', 'la solución vence 1440 + 20 minutos después de la recepción');
select nexo_test.eq(
  (select string_agg(e.type, ',' order by e.created_at, e.seq) from public.nexo_sd_ticket_events e
   join public.nexo_sd_tickets t on t.id = e.ticket_id
   where t.external_ref = 'test:p24' and e.type in ('pause', 'resume') and e.visibility = 'publico'),
  'pause,resume', 'la pausa y la reanudación son visibles para el cliente en la línea de tiempo');
select nexo_test.ok(
  (select count(*) > 0 from public.nexo_sd_notifications n join public.nexo_sd_tickets t on t.id = n.ticket_id
   where t.external_ref = 'test:p24' and n.template = 'sd_pausa_iniciada'
     and n.recipient_user_id = nexo_test.uid('contraparte.demo@cliente.invalid')),
  'la contraparte recibe el aviso para acusar la pausa');

-- 2) Pausa en calendario hábil: solo descuenta minutos hábiles (lunes 17:00 a martes 10:00 = 2 h).
insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at)
select id, 'decision_cliente', 'El cliente pidió esperar la ventana de cambios del martes.', nexo_test.cl('2026-10-05 17:00')
from public.nexo_sd_tickets where external_ref = 'test:phab';
select nexo_test.eq(
  (select remaining_seconds_at_pause from relojes where ref = 'test:phab' and metric = 'acuse'),
  3600::numeric, 'S3: al pausar a las 17:00 quedaba 1 hora hábil de acuse');
update public.nexo_sd_clock_pauses set ended_at = nexo_test.cl('2026-10-06 10:00')
 where ticket_id = (select id from public.nexo_sd_tickets where external_ref = 'test:phab');
select nexo_test.eq((select paused_seconds from relojes where ref = 'test:phab' and metric = 'acuse'), 7200::numeric,
  'la pausa de lunes 17:00 a martes 10:00 descuenta 2 horas hábiles (no 17 horas)');
select nexo_test.eq((select due_at from relojes where ref = 'test:phab' and metric = 'acuse'), nexo_test.cl('2026-10-06 11:00'),
  'S3: el acuse pasa de lunes 18:00 a martes 11:00');

-- 3) Una pausa que empieza cuando el plazo ya venció no lo salva.
insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at)
select id, 'terceros', 'Proveedor del certificado no responde (mesa del tercero).', now() - interval '5 minutes'
from public.nexo_sd_tickets where external_ref = 'test:ptarde';
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:ptarde'),
  'acuse=en_curso,diagnostico=pausado,solucion=pausado',
  'el acuse vencido hace 30 minutos no se pausa (sd_tick lo marca incumplido)');
select nexo_test.ok(
  (select (nexo_private.sd_tick(now()) ->> 'vencidos')::int >= 1), 'sd_tick registra el vencimiento');
select nexo_test.eq((select status from relojes where ref = 'test:ptarde' and metric = 'acuse'), 'incumplido',
  'el acuse queda incumplido aunque haya una pausa abierta');

-- 4) Validaciones de las pausas.
select nexo_test.throws(
  $$insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification)
    select id, 'vacaciones', 'Motivo que no está tipificado en el contrato.' from public.nexo_sd_tickets where external_ref = 'test:acuse'$$,
  'un motivo no tipificado se rechaza', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification)
    select id, 'red', 'corta' from public.nexo_sd_tickets where external_ref = 'test:acuse'$$,
  'la justificación es obligatoria (mínimo 10 caracteres)', '23514');
select nexo_test.throws(
  $$insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification)
    select id, 'red', 'Segunda pausa mientras la primera sigue abierta.' from public.nexo_sd_tickets where external_ref = 'test:ptarde'$$,
  'solo puede haber una pausa abierta por ticket', '23505');

select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_pause_ticket((select id from public.nexo_sd_tickets where external_ref = 'test:acuse'), 'acceso_remoto_pendiente', 'Intento manual de pausa por acceso remoto.')$$,
  'la pausa por acceso remoto no se abre a mano', '22023');
select nexo_test.ok(
  public.nexo_sd_pause_ticket((select id from public.nexo_sd_tickets where external_ref = 'test:acuse'),
                              'infraestructura_cliente', 'Servidor del cliente sin energía en el CPD.') is not null,
  'un agente pausa con motivo tipificado y justificación');
reset role;

-- 5) Hito alcanzado durante una pausa: cuenta lo transcurrido hasta la pausa.
update public.nexo_sd_tickets set status = 'acusado' where external_ref = 'test:acuse';
select nexo_test.eq((select status from relojes where ref = 'test:acuse' and metric = 'acuse'), 'cumplido',
  'acusar durante la pausa cumple el acuse');
select nexo_test.eq((select status from relojes where ref = 'test:acuse' and metric = 'diagnostico'), 'pausado',
  'los demás relojes siguen en pausa');
update public.nexo_sd_tickets set status = 'resuelto' where external_ref = 'test:acuse';
select nexo_test.ok(
  (select count(*) = 0 from pausas where ref = 'test:acuse' and ended_at is null),
  'resolver el ticket cierra la pausa abierta');

-- 6) Acceso remoto (BT-065): mientras está pendiente, el reloj se pausa solo.
select nexo_test.login('agente1.demo@yago.invalid');
select nexo_test.ok(
  public.nexo_sd_request_remote_access((select id from public.nexo_sd_tickets where external_ref = 'test:remoto'),
    'Servidor gw-02 por SSH, 2 horas', 'Revisar los registros del nodo de gateway caído.') is not null,
  'un agente solicita acceso remoto');
reset role;
select nexo_test.eq(
  (select reason || '/' || (ended_at is null)::text from pausas where ref = 'test:remoto'),
  'acceso_remoto_pendiente/true', 'la solicitud abre una pausa automática por acceso remoto pendiente');
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:remoto'),
  'acuse=pausado,diagnostico=pausado,solucion=pausado', 'los relojes quedan en pausa mientras el cliente no habilita');
select nexo_test.ok(
  (select count(*) > 0 from public.nexo_sd_notifications n join public.nexo_sd_tickets t on t.id = n.ticket_id
   where t.external_ref = 'test:remoto' and n.template = 'sd_acceso_remoto_solicitado'),
  'la contraparte recibe la solicitud de acceso');

select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_decide_remote_access((select r.id from public.nexo_sd_remote_access_requests r
      join public.nexo_sd_tickets t on t.id = r.ticket_id where t.external_ref = 'test:remoto' limit 1), true, 'ok')$$,
  'el reportante no habilita accesos remotos', '42501');
select nexo_test.login('contraparte.demo@cliente.invalid');
select public.nexo_sd_decide_remote_access(
  (select r.id from public.nexo_sd_remote_access_requests r join public.nexo_sd_tickets t on t.id = r.ticket_id
   where t.external_ref = 'test:remoto'), true, 'Habilitado por la VPN de proveedores.');
reset role;
select nexo_test.ok(
  (select r.status = 'habilitado' and r.enabled_at is not null and r.decided_by = nexo_test.uid('contraparte.demo@cliente.invalid')
   from public.nexo_sd_remote_access_requests r join public.nexo_sd_tickets t on t.id = r.ticket_id
   where t.external_ref = 'test:remoto'),
  'la contraparte habilita el acceso (queda registrado quién y cuándo)');
select nexo_test.ok(
  (select count(*) = 0 from pausas where ref = 'test:remoto' and ended_at is null),
  'al habilitar el acceso se cierra la pausa automática');
select nexo_test.eq(
  (select string_agg(metric || '=' || status, ',' order by metric) from relojes where ref = 'test:remoto'),
  'acuse=en_curso,diagnostico=en_curso,solucion=en_curso', 'los relojes vuelven a correr');

select nexo_test.login('agente1.demo@yago.invalid');
select public.nexo_sd_revoke_remote_access(
  (select r.id from public.nexo_sd_remote_access_requests r join public.nexo_sd_tickets t on t.id = r.ticket_id
   where t.external_ref = 'test:remoto'), 'bitacora://sesiones/2026-10-04/gw-02.cast');
reset role;
select nexo_test.ok(
  (select r.status = 'revocado' and r.revoked_at is not null and r.session_log_ref like 'bitacora://%'
   from public.nexo_sd_remote_access_requests r join public.nexo_sd_tickets t on t.id = r.ticket_id
   where t.external_ref = 'test:remoto'),
  'al cerrar la sesión se revoca el acceso y se guarda la referencia de la bitácora');

-- Con una pausa manual abierta, pedir acceso remoto cambia el motivo sin superponer pausas.
select nexo_test.login('agente1.demo@yago.invalid');
select public.nexo_sd_pause_ticket((select id from public.nexo_sd_tickets where external_ref = 'test:remoto'),
  'terceros', 'El proveedor del balanceador revisa la configuración.');
select public.nexo_sd_request_remote_access((select id from public.nexo_sd_tickets where external_ref = 'test:remoto'),
  'Consola del balanceador, 1 hora', 'Aplicar la configuración que indicó el proveedor.');
reset role;
select nexo_test.eq((select count(*)::int from pausas where ref = 'test:remoto'), 3,
  'el ticket acumula tres pausas sin superponerse (acceso, terceros, acceso)');
select nexo_test.ok((select bool_and(ended_at is not null) from pausas where ref = 'test:remoto' and reason = 'terceros'),
  'la pausa manual se cierra al pedir el acceso remoto');
select nexo_test.eq((select reason from pausas where ref = 'test:remoto' and ended_at is null), 'acceso_remoto_pendiente',
  'la pausa abierta es la de acceso remoto pendiente');

-- 7) Acuse de la pausa por el cliente.
select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_acknowledge_pause((select id from pausas where ref = 'test:p24'), true, null)$$,
  'el reportante no acusa pausas (solo la contraparte)', '42501');
select nexo_test.login('contraparte.demo@cliente.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_acknowledge_pause((select id from pausas where ref = 'test:p24'), false, 'no')$$,
  'objetar exige un motivo', '22023');
select public.nexo_sd_acknowledge_pause((select id from pausas where ref = 'test:p24'), true, 'Confirmado: corte del proveedor.');
select nexo_test.ok(
  (select client_ack_status = 'aceptada' and client_ack_by = nexo_test.uid('contraparte.demo@cliente.invalid')
   from pausas where ref = 'test:p24'),
  'la contraparte acusa la pausa');
select nexo_test.throws(
  $$select public.nexo_sd_acknowledge_pause((select id from pausas where ref = 'test:p24'), true, null)$$,
  'una pausa se acusa una sola vez', '23514');
reset role;

rollback;
