-- Incidentes de seguridad (Ley 21.663) con plazos configurables, paquetes de corrección con
-- aprobación de cuatro ojos y RCA visibles para la organización al publicarse.
begin;

\set s2 '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":true,"soloNoProductivoOMenor":false}'

insert into public.nexo_sd_tickets (org_id, title, classification_answers, external_ref) values
  (nexo_test.org('cliente-demo'), 'Credenciales expuestas', :'s2', 'test:inc'),
  (nexo_test.org('cliente-demo'), 'Tráfico anómalo en el gateway', :'s2', 'test:inc2');
select id as t_inc from public.nexo_sd_tickets where external_ref = 'test:inc' \gset
select id as t_inc2 from public.nexo_sd_tickets where external_ref = 'test:inc2' \gset

-- ---------------------------------------------------------------------------
-- Incidentes
-- ---------------------------------------------------------------------------
select nexo_test.eq(
  (select security_early_alert_hours || '/' || security_second_report_hours || '/' || security_final_report_days
   from public.nexo_sd_settings),
  '3/72/15', 'la configuración trae 3 horas, 72 horas y 15 días (a verificar con el procedimiento institucional)');

select nexo_test.login('agente1.demo@yago.invalid');
insert into public.nexo_sd_security_incidents (ticket_id, title, description, affected_services, early_alert_hours)
values (:'t_inc', 'Credenciales expuestas en un repositorio', 'Clave de servicio publicada por error.',
        array['Key Manager', 'API de concesiones'], 99);
select nexo_test.ok(
  (select early_alert_hours = 3 and second_report_hours = 72 and final_report_days = 15
      and org_id = nexo_test.org('cliente-demo') and created_by = nexo_test.uid('agente1.demo@yago.invalid')
   from public.nexo_sd_security_incidents where ticket_id = :'t_inc'),
  'el incidente copia los plazos de la configuración (no los que envía el cliente) y la organización del ticket');
select nexo_test.ok((select is_security_incident from public.nexo_sd_tickets where id = :'t_inc'),
  'el ticket queda marcado como incidente de seguridad');
select nexo_test.ok(
  exists (select 1 from public.nexo_sd_ticket_events where ticket_id = :'t_inc' and type = 'security' and visibility = 'interno'),
  'el registro del incidente queda en la línea de tiempo interna');
select nexo_test.throws(
  $$update public.nexo_sd_security_incidents set early_alert_hours = 10 where ticket_id = '$$ || :'t_inc' || $$'$$,
  'los plazos del incidente no se cambian después de crearlo', '42501');
update public.nexo_sd_security_incidents
   set early_alert_sent_at = detected_at + interval '2 hours', csirt_reference = 'CSIRT-2026-0001',
       classification = 'significativo'
 where ticket_id = :'t_inc';
select nexo_test.ok(
  (select final_report_due_at = early_alert_sent_at + interval '15 days' and csirt_reference = 'CSIRT-2026-0001'
   from public.nexo_sd_security_incidents where ticket_id = :'t_inc'),
  'al registrar la alerta temprana, el informe final se recalcula y se guarda la referencia del CSIRT');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_settings set security_early_alert_hours = 1$$), 0,
  'un agente no cambia la configuración');
update public.nexo_sd_tickets set is_security_incident = true where id = :'t_inc2';
select nexo_test.ok(exists (select 1 from public.nexo_sd_security_incidents where ticket_id = :'t_inc2'),
  'marcar un ticket como incidente de seguridad crea el incidente');
reset role;

select nexo_test.login('supervisor.demo@yago.invalid');
select nexo_test.eq(
  nexo_test.affected($$update public.nexo_sd_settings set security_early_alert_hours = 2$$), 1,
  'un supervisor ajusta el plazo de la alerta temprana');
insert into public.nexo_sd_security_incidents (title, org_id) values ('Incidente con plazo ajustado', nexo_test.org('cliente-demo'));
select nexo_test.ok(
  (select early_alert_hours = 2 and early_alert_due_at = detected_at + interval '2 hours'
   from public.nexo_sd_security_incidents where title = 'Incidente con plazo ajustado'),
  'los incidentes nuevos usan el plazo ajustado');
select nexo_test.eq(
  (select early_alert_hours from public.nexo_sd_security_incidents where ticket_id = :'t_inc'), 3::numeric,
  'los incidentes anteriores conservan su plazo');
reset role;

select nexo_test.login('contraparte.demo@cliente.invalid');
select nexo_test.ok((select count(*) >= 2 from public.nexo_sd_security_incidents where org_id = nexo_test.org('cliente-demo')),
  'la contraparte ve los incidentes de su organización');
select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_security_incidents), 0, 'el reportante no ve incidentes');
select nexo_test.throws(
  $$insert into public.nexo_sd_security_incidents (title) values ('Intento del reportante')$$,
  'el reportante no registra incidentes', '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Paquetes de corrección (cuatro ojos)
-- ---------------------------------------------------------------------------
select nexo_test.login('agente1.demo@yago.invalid');
insert into public.nexo_sd_patch_packages (org_id, version, title, description, rollback_plan, ticket_id, status) values
  (nexo_test.org('cliente-demo'), '1.0.2', 'Rotación de credenciales', 'Rota la clave expuesta y revoca tokens.',
   'Restaurar la clave anterior desde el respaldo cifrado y reiniciar el Key Manager.', :'t_inc', 'pendiente_aprobacion'),
  (nexo_test.org('cliente-demo'), '1.0.3', 'Paquete en borrador', 'Todavía en preparación.',
   'Revertir el despliegue a la revisión anterior con Argo CD.', null, 'aprobado');
select nexo_test.eq((select status from public.nexo_sd_patch_packages where version = '1.0.3'), 'borrador',
  'un paquete nuevo no puede nacer aprobado');
select nexo_test.ok(nexo_test.denied($$select public.nexo_sd_decide_patch((select id from public.nexo_sd_patch_packages where version = '1.0.2'), true, 'ok')$$),
  'un agente no aprueba paquetes');
select nexo_test.ok(nexo_test.denied($$update public.nexo_sd_patch_packages set approved_by = auth.uid() where version = '1.0.2'$$),
  'la aprobación no se escribe directamente');
select nexo_test.throws($$update public.nexo_sd_patch_packages set status = 'aplicado' where version = '1.0.2'$$,
  'no se aplica un paquete sin aprobación', '23514');
reset role;

select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.eq(
  (select string_agg(version, ',' order by version) from public.nexo_sd_patch_packages where org_id = nexo_test.org('cliente-demo')),
  '1.0.1,1.0.2', 'la organización ve los paquetes que salieron de borrador (no los borradores)');
reset role;

select nexo_test.login('supervisor.demo@yago.invalid');
select public.nexo_sd_decide_patch((select id from public.nexo_sd_patch_packages where version = '1.0.2'), true,
  'Aprobado para la ventana del jueves.');
insert into public.nexo_sd_patch_packages (org_id, version, title, description, rollback_plan, status) values
  (nexo_test.org('cliente-demo'), '1.0.4', 'Paquete del supervisor', 'Ajuste de cuotas.',
   'Restaurar la política de cuotas anterior desde el repositorio GitOps.', 'pendiente_aprobacion');
select nexo_test.throws(
  $$select public.nexo_sd_decide_patch((select id from public.nexo_sd_patch_packages where version = '1.0.4'), true, 'Me apruebo')$$,
  'quien prepara un paquete no puede aprobarlo', '42501');
reset role;
select nexo_test.ok(
  (select status = 'aprobado' and approved_by = nexo_test.uid('supervisor.demo@yago.invalid') and approved_at is not null
   from public.nexo_sd_patch_packages where version = '1.0.2'),
  'un supervisor distinto de quien lo preparó aprueba el paquete');

select nexo_test.login('contraparte.demo@cliente.invalid');
select nexo_test.throws(
  $$select public.nexo_sd_decide_patch((select id from public.nexo_sd_patch_packages where version = '1.0.4'), false, null)$$,
  'rechazar exige un motivo', '22023');
select public.nexo_sd_decide_patch((select id from public.nexo_sd_patch_packages where version = '1.0.4'), true,
  'Aprobado por la contraparte técnica.');
reset role;
select nexo_test.eq((select status from public.nexo_sd_patch_packages where version = '1.0.4'), 'aprobado',
  'la contraparte del cliente aprueba un paquete');

select nexo_test.login('agente1.demo@yago.invalid');
update public.nexo_sd_patch_packages set status = 'aplicado' where version = '1.0.2';
select nexo_test.ok(
  (select applied_at is not null and applied_by = nexo_test.uid('agente1.demo@yago.invalid')
   from public.nexo_sd_patch_packages where version = '1.0.2'),
  'al aplicarlo se registra quién y cuándo');
update public.nexo_sd_patch_packages set status = 'revertido' where version = '1.0.2';
select nexo_test.ok((select rolled_back_at is not null from public.nexo_sd_patch_packages where version = '1.0.2'),
  'la reversa queda registrada');
reset role;

-- ---------------------------------------------------------------------------
-- RCA
-- ---------------------------------------------------------------------------
select nexo_test.login('agente1.demo@yago.invalid');
insert into public.nexo_sd_rca_reports (ticket_id, title, summary, root_cause)
values (:'t_inc', 'RCA: credenciales expuestas', 'Una clave quedó en un repositorio público.',
        'Falta de escaneo de secretos en el repositorio auxiliar.');
select nexo_test.ok(
  (select org_id = nexo_test.org('cliente-demo') and author_id = nexo_test.uid('agente1.demo@yago.invalid')
      and status = 'borrador' and published_at is null
   from public.nexo_sd_rca_reports where ticket_id = :'t_inc'),
  'el RCA toma la organización del ticket y queda en borrador');
reset role;
select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.eq((select count(*)::int from public.nexo_sd_rca_reports where ticket_id = :'t_inc'), 0,
  'la organización no ve el RCA en borrador');
select nexo_test.throws(
  $$insert into public.nexo_sd_rca_reports (ticket_id, title, summary, root_cause) values ('$$ || :'t_inc' || $$', 'Intento de RCA', 'Resumen', 'Causa')$$,
  'el reportante no escribe RCA', '42501');
select nexo_test.login('agente1.demo@yago.invalid');
update public.nexo_sd_rca_reports set status = 'publicado' where ticket_id = :'t_inc';
select nexo_test.login('reportante.demo@cliente.invalid');
select nexo_test.ok(
  (select count(*) = 1 and bool_and(published_at is not null) from public.nexo_sd_rca_reports where ticket_id = :'t_inc'),
  'al publicarlo, la organización ve el RCA');
reset role;

rollback;
