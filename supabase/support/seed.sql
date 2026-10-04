-- =============================================================================
-- Mesa de soporte Nexo · Semilla de demostración (datos 100 % sintéticos)
--
-- * No crea usuarios ni escribe en auth.users (el proyecto es compartido y otro producto
--   tiene un trigger ahí). Vincula como miembros solo las cuentas de demostración que ya
--   existan en Supabase Auth con estos correos (dominio .invalid, que nunca se entrega):
--     reportante.demo@subtel.invalid · contraparte.demo@subtel.invalid
--     agente1.demo@yago.invalid · agente2.demo@yago.invalid · supervisor.demo@yago.invalid
-- * Sin teléfonos: ningún aviso de prueba puede llegar a un número real.
-- * Se puede ejecutar más de una vez (no duplica filas ni consume correlativos).
-- =============================================================================

insert into public.nexo_sd_organizations (name, slug, is_provider) values
  ('Yago', 'yago', true),
  ('SUBTEL (demo)', 'subtel-demo', false)
on conflict (slug) do nothing;

insert into public.nexo_sd_members (user_id, org_id, role, display_name, email)
select u.id, o.id, v.role, v.display_name, v.email
from (values
  ('reportante.demo@subtel.invalid', 'subtel-demo', 'reportante', 'Camila Rojas (demo)'),
  ('contraparte.demo@subtel.invalid', 'subtel-demo', 'contraparte', 'Diego Soto (demo)'),
  ('agente1.demo@yago.invalid', 'yago', 'agente', 'Agente de primer contacto (demo)'),
  ('agente2.demo@yago.invalid', 'yago', 'agente', 'Técnico de turno (demo)'),
  ('supervisor.demo@yago.invalid', 'yago', 'supervisor', 'Supervisión y seguridad (demo)')
) as v(email, org_slug, role, display_name)
join auth.users u on lower(u.email) = v.email
join public.nexo_sd_organizations o on o.slug = v.org_slug
on conflict (user_id, org_id) do nothing;

-- Turnos de demostración: 30 días, nivel 1 -> 2 -> 3.
insert into public.nexo_sd_oncall_shifts (user_id, level, starts_at, ends_at, notes)
select m.user_id, v.level, date_trunc('day', now()) - interval '1 day', date_trunc('day', now()) + interval '30 days',
       'Turno de demostración (semilla)'
from (values
  ('agente1.demo@yago.invalid', 1),
  ('agente2.demo@yago.invalid', 2),
  ('supervisor.demo@yago.invalid', 3)
) as v(email, level)
join public.nexo_sd_members m on m.email = v.email
where not exists (
  select 1 from public.nexo_sd_oncall_shifts s
  where s.user_id = m.user_id and s.notes = 'Turno de demostración (semilla)'
);

-- Tickets de demostración (external_ref seed:N evita duplicados al reaplicar).
insert into public.nexo_sd_tickets
  (org_id, title, description, classification_answers, category, component, environment, channel,
   reporter_id, created_by, created_at, external_ref, is_security_incident)
select o.id, v.title, v.description, v.answers::jsonb, v.category, v.component, v.environment, 'web',
       u.id, u.id, now() - v.age::interval, v.ref, v.security
from (values
  ('seed:1', 'Los gateways de producción responden 5xx',
   'Desde las 03:10 todas las APIs publicadas responden 502. No hay nodo alternativo disponible.',
   '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":false,"degradacionOSeguridad":true,"soloNoProductivoOMenor":false}',
   'Plataforma', 'Gateway', 'prod', '25 minutes', false),
  ('seed:2', 'Un nodo de gateway cayó y el otro responde lento',
   'El nodo 2 no responde; el nodo 1 sostiene el tráfico con latencia p95 sobre lo comprometido.',
   '{"esConsultaOCambio":false,"servicioProductivoCaido":true,"existeAlternativa":true,"degradacionOSeguridad":true,"soloNoProductivoOMenor":false}',
   'Plataforma', 'Gateway', 'prod', '5 hours', false),
  ('seed:3', 'El portal de desarrolladores muestra mal la documentación',
   'La API de concesiones aparece sin ejemplos en el portal.',
   '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":true}',
   'Portal', 'Portal de desarrolladores', 'prod', '2 days', false),
  ('seed:4', 'Consulta sobre cómo exportar un contrato OpenAPI',
   '¿Desde dónde se descarga el contrato OpenAPI de una API publicada?',
   '{"esConsultaOCambio":true,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":false,"soloNoProductivoOMenor":false}',
   'Consulta', 'Consola', 'prod', '1 day', false),
  ('seed:5', 'Vulnerabilidad explotable en un componente expuesto',
   'Aviso de seguridad del proveedor con explotación activa en el componente de autenticación.',
   '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":true,"soloNoProductivoOMenor":false}',
   'Seguridad', 'Key Manager', 'prod', '40 minutes', true),
  ('seed:6', 'Errores intermitentes en la API de trámites (mes anterior)',
   'La API de trámites devolvió errores 503 intermitentes sobre el umbral durante 2 horas.',
   '{"esConsultaOCambio":false,"servicioProductivoCaido":false,"existeAlternativa":false,"degradacionOSeguridad":true,"soloNoProductivoOMenor":false}',
   'Integración', 'API de trámites', 'prod', '35 days', false)
) as v(ref, title, description, answers, category, component, environment, age, security)
join public.nexo_sd_organizations o on o.slug = 'subtel-demo'
left join auth.users u on lower(u.email) = 'reportante.demo@subtel.invalid'
where not exists (select 1 from public.nexo_sd_tickets t where t.external_ref = v.ref)
order by now() - v.age::interval;

-- Avance de los tickets, con hitos en tiempos verosímiles.
update public.nexo_sd_tickets t
   set status = 'acusado', acknowledged_at = t.created_at + interval '20 minutes'
 where t.external_ref = 'seed:2' and t.status = 'nuevo';

update public.nexo_sd_tickets t
   set status = 'en_diagnostico', acknowledged_at = t.created_at + interval '2 hours',
       diagnosed_at = t.created_at + interval '1 day'
 where t.external_ref = 'seed:3' and t.status = 'nuevo';

update public.nexo_sd_tickets t
   set status = 'resuelto', acknowledged_at = t.created_at + interval '3 hours',
       diagnosed_at = t.created_at + interval '3 hours', resolved_at = t.created_at + interval '4 hours'
 where t.external_ref = 'seed:4' and t.status = 'nuevo';

update public.nexo_sd_tickets t
   set status = 'resuelto', acknowledged_at = t.created_at + interval '30 minutes',
       diagnosed_at = t.created_at + interval '3 hours', workaround_at = t.created_at + interval '5 hours',
       resolved_at = t.created_at + interval '20 hours'
 where t.external_ref = 'seed:6' and t.status = 'nuevo';

-- Pausa cerrada en el ticket S2 (infraestructura de SUBTEL), con acuse de la contraparte.
insert into public.nexo_sd_clock_pauses (ticket_id, reason, justification, started_at, created_by)
select t.id, 'infraestructura_subtel',
       'Mantención programada del balanceador de SUBTEL; sin acceso al nodo 2 (demo).',
       now() - interval '3 hours', null
from public.nexo_sd_tickets t
where t.external_ref = 'seed:2'
  and not exists (select 1 from public.nexo_sd_clock_pauses p where p.ticket_id = t.id);

update public.nexo_sd_clock_pauses p
   set ended_at = now() - interval '2 hours'
  from public.nexo_sd_tickets t
 where t.id = p.ticket_id and t.external_ref = 'seed:2' and p.ended_at is null;

-- RCA publicado y paquete de corrección pendiente de aprobación para el S2 del mes anterior.
insert into public.nexo_sd_rca_reports
  (ticket_id, org_id, title, summary, timeline, root_cause, corrective_actions, preventive_actions, status)
select t.id, t.org_id, 'RCA: errores intermitentes en la API de trámites',
       'Durante 2 horas la API de trámites respondió 503 intermitentes por agotamiento del pool de conexiones.',
       '10:05 alerta de errores · 10:35 acuse · 13:05 solución temporal (más conexiones) · 06:05 corrección definitiva.',
       'El pool de conexiones al backend tenía un tope bajo y no se recuperaba tras timeouts.',
       'Se ajustó el tamaño del pool y el tiempo de espera; se agregó reintento con espera.',
       'Alerta preventiva al 70 % del pool y prueba de carga mensual.',
       'publicado'
from public.nexo_sd_tickets t
where t.external_ref = 'seed:6'
  and not exists (select 1 from public.nexo_sd_rca_reports r where r.ticket_id = t.id);

insert into public.nexo_sd_patch_packages
  (org_id, version, title, description, rollback_plan, ticket_id, status)
select t.org_id, '1.0.1', 'Ajuste del pool de conexiones de la API de trámites',
       'Aumenta el pool de conexiones y agrega reintentos con espera creciente.',
       'Revertir a la revisión 1.0.0 del despliegue con Argo CD (rollback en un paso) y verificar la prueba de humo.',
       t.id, 'pendiente_aprobacion'
from public.nexo_sd_tickets t
where t.external_ref = 'seed:6'
on conflict (org_id, version) do nothing;

-- Mensaje de un remitente no registrado: queda en cuarentena.
select public.nexo_sd_inbound_message(
  'email', 'persona.desconocida@ejemplo.invalid', 'Persona sin registro (demo)',
  'Consulta por la API de concesiones', 'Hola, ¿cómo solicito credenciales para la API de concesiones?',
  'seed-correo-1', now() - interval '10 minutes');

-- Los avisos que generó la semilla son de demostración: se marcan como enviados en modo
-- simulado para que nexo-sd-notify nunca intente entregarlos.
update public.nexo_sd_notifications n
   set status = 'enviada', sent_at = now(), result = '{"simulado": true, "origen": "semilla"}'::jsonb
 where n.status = 'pendiente'
   and n.recipient_user_id in (select m.user_id from public.nexo_sd_members m where m.email like '%.invalid');
