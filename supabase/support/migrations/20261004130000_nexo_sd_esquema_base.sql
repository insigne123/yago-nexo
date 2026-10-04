-- =============================================================================
-- Mesa de soporte Nexo · 01 · Esquema base
--
-- El proyecto Supabase es COMPARTIDO con ANTON.IA 2.0 (objetos anton2_* en public y
-- el esquema anton2_private). Reglas que cumple este archivo y los siguientes:
--   * Todo objeto propio en public empieza con nexo_sd_; lo interno vive en nexo_private.
--   * No se referencia, modifica ni depende de ningún objeto anton2_*.
--   * No se crean triggers en auth.users ni se cambian ajustes de Auth: auth.users solo
--     se referencia por clave foránea. La pertenencia a la mesa es explícita
--     (nexo_sd_members): quien no esté ahí no ve nada.
--   * No se usa ALTER DEFAULT PRIVILEGES (afectaría objetos de ANTON); los permisos se
--     otorgan objeto por objeto.
--   * RLS habilitado en todas las tablas; ninguna tabla es legible por anon.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Esquema interno
-- -----------------------------------------------------------------------------
create schema if not exists nexo_private;
comment on schema nexo_private is
  'Mesa de soporte Nexo: funciones y tablas internas. No está expuesto por la API (PostgREST).';

revoke all on schema nexo_private from public;
revoke all on schema nexo_private from anon;
revoke all on schema nexo_private from authenticated;
-- authenticated necesita USAGE solo para evaluar las funciones auxiliares de RLS
-- (cada función se habilita una por una en la migración de RLS).
grant usage on schema nexo_private to authenticated;
grant usage on schema nexo_private to service_role;

-- -----------------------------------------------------------------------------
-- Utilidad: updated_at
-- -----------------------------------------------------------------------------
create or replace function nexo_private.sd_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Organizaciones y miembros
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  is_provider boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.nexo_sd_organizations is
  'Mesa de soporte Nexo: organizaciones. is_provider marca a Yago (una sola fila).';
create unique index if not exists nexo_sd_organizations_one_provider
  on public.nexo_sd_organizations (is_provider) where is_provider;

create table if not exists public.nexo_sd_members (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  org_id          uuid not null references public.nexo_sd_organizations (id) on delete cascade,
  role            text not null check (role in ('reportante', 'contraparte', 'agente', 'supervisor')),
  display_name    text not null check (char_length(btrim(display_name)) between 2 and 120),
  email           text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone_e164      text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_opt_in boolean not null default false,
  voice_opt_in    boolean not null default false,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, org_id)
);
comment on table public.nexo_sd_members is
  'Mesa de soporte Nexo: pertenencia explícita. agente y supervisor solo existen en la organización proveedora (Yago).';
create index if not exists nexo_sd_members_user_idx on public.nexo_sd_members (user_id);
create index if not exists nexo_sd_members_org_idx on public.nexo_sd_members (org_id);
create index if not exists nexo_sd_members_email_idx on public.nexo_sd_members (lower(email));
create index if not exists nexo_sd_members_phone_idx on public.nexo_sd_members (phone_e164);

-- -----------------------------------------------------------------------------
-- Configuración (una fila)
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_settings (
  id                            boolean primary key default true check (id),
  timezone                      text not null default 'America/Santiago',
  business_start                time not null default '09:00',
  business_end                  time not null default '18:00',
  business_isodows              int[] not null default '{1,2,3,4,5}',
  require_mfa                   boolean not null default true,
  s1_ack_escalation_minutes     int not null default 10 check (s1_ack_escalation_minutes > 0),
  inbound_provisional_severity  text not null default 'S1'
                                  check (inbound_provisional_severity in ('S1', 'S2', 'S3', 'S4')),
  -- Ley 21.663 (art. 9): plazos de reporte al CSIRT. Verificar con el procedimiento institucional.
  security_early_alert_hours    numeric not null default 3 check (security_early_alert_hours > 0),
  security_second_report_hours  numeric not null default 72 check (security_second_report_hours > 0),
  security_final_report_days    numeric not null default 15 check (security_final_report_days > 0),
  notify_max_attempts           int not null default 5 check (notify_max_attempts between 1 and 20),
  app_base_url                  text not null default 'https://soporte.yago.cl',
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references auth.users (id) on delete set null,
  constraint nexo_sd_settings_business_hours check (business_start < business_end),
  constraint nexo_sd_settings_isodows check (business_isodows <@ array[1, 2, 3, 4, 5, 6, 7]
                                             and cardinality(business_isodows) between 1 and 7)
);
comment on table public.nexo_sd_settings is
  'Mesa de soporte Nexo: parámetros (calendario hábil, MFA, escalamiento y plazos de la Ley 21.663).';
comment on column public.nexo_sd_settings.security_early_alert_hours is
  'Alerta temprana al CSIRT: 3 horas desde que se toma conocimiento. Verificar con el procedimiento institucional.';
comment on column public.nexo_sd_settings.security_second_report_hours is
  'Segundo reporte: 72 horas desde que se toma conocimiento. Verificar con el procedimiento institucional.';
comment on column public.nexo_sd_settings.security_final_report_days is
  'Informe final: 15 días corridos desde el envío de la alerta temprana. Verificar con el procedimiento institucional.';
comment on column public.nexo_sd_settings.inbound_provisional_severity is
  'Severidad provisional de tickets de correo o WhatsApp sin asistente: ante la duda se trata como S1 hasta reclasificar.';

insert into public.nexo_sd_settings (id) values (true) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Feriados y políticas SLA (los datos se cargan en las migraciones siguientes)
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_holidays (
  day           date primary key,
  name          text not null,
  irrenunciable boolean not null default false,
  legal_basis   text,
  created_at    timestamptz not null default now()
);
comment on table public.nexo_sd_holidays is
  'Mesa de soporte Nexo: feriados nacionales de Chile que excluye el calendario hábil.';

create table if not exists public.nexo_sd_sla_policies (
  severity             text primary key check (severity in ('S1', 'S2', 'S3', 'S4')),
  name                 text not null,
  calendar             text not null check (calendar in ('24x7', 'habil')),
  acuse_minutes        int check (acuse_minutes > 0),
  diagnostico_minutes  int check (diagnostico_minutes > 0),
  solucion_minutes     int check (solucion_minutes > 0),
  channels             text[] not null default '{push,email}'
                         check (channels <@ array['email', 'whatsapp', 'push', 'voz']::text[]),
  voice_on_escalation  boolean not null default false,
  description          text,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null
);
comment on table public.nexo_sd_sla_policies is
  'Mesa de soporte Nexo: plazos por severidad. 24x7 en minutos corridos; habil en minutos hábiles (1 día hábil = 540 min, 09:00-18:00).';

insert into public.nexo_sd_sla_policies
  (severity, name, calendar, acuse_minutes, diagnostico_minutes, solucion_minutes, channels, voice_on_escalation, description)
values
  ('S1', 'Crítica', '24x7', 60, 120, 240, '{push,whatsapp,email}', true,
   'Servicio productivo caído sin alternativa. Acuse 1 h, diagnóstico 2 h, solución o solución temporal 4 h corridas.'),
  ('S2', 'Alta', '24x7', 240, 480, 1440, '{push,whatsapp,email}', false,
   'Servicio degradado con impacto. Acuse 4 h, diagnóstico 8 h, solución 24 h corridas.'),
  ('S3', 'Media', 'habil', 480, 1620, 5400, '{push,email}', false,
   'Falla menor. Acuse 8 horas hábiles, diagnóstico 3 días hábiles, solución 10 días hábiles.'),
  ('S4', 'Baja', 'habil', 540, null, null, '{push,email}', false,
   'Consulta o cambio. Acuse 1 día hábil; sin otros plazos.')
on conflict (severity) do nothing;

-- -----------------------------------------------------------------------------
-- Tickets
-- -----------------------------------------------------------------------------
create table if not exists nexo_private.sd_ticket_counters (
  year       int primary key,
  last_value int not null default 0
);
comment on table nexo_private.sd_ticket_counters is
  'Mesa de soporte Nexo: correlativo anual de tickets (SD-AAAA-NNNN).';

create table if not exists public.nexo_sd_tickets (
  id                     uuid primary key default gen_random_uuid(),
  number                 text not null unique,
  org_id                 uuid references public.nexo_sd_organizations (id) on delete restrict,
  title                  text not null check (char_length(btrim(title)) between 3 and 200),
  description            text not null default '' check (char_length(description) <= 20000),
  severity               text not null check (severity in ('S1', 'S2', 'S3', 'S4')),
  classification_answers jsonb,
  classification_rule    text not null,
  classification_source  text not null default 'asistente'
                           check (classification_source in ('asistente', 'provisional', 'reclasificacion')),
  category               text check (category is null or char_length(category) <= 80),
  component              text check (component is null or char_length(component) <= 120),
  environment            text not null default 'prod' check (environment in ('prod', 'qa', 'dev')),
  status                 text not null default 'nuevo'
                           check (status in ('nuevo', 'acusado', 'en_diagnostico', 'solucion_temporal', 'resuelto', 'cerrado')),
  intake_status          text not null default 'aceptado'
                           check (intake_status in ('aceptado', 'cuarentena', 'descartado')),
  channel                text not null default 'web' check (channel in ('web', 'email', 'whatsapp', 'telefono')),
  channel_sender         text,
  external_ref           text unique,
  reporter_id            uuid references auth.users (id) on delete set null,
  assignee_id            uuid references auth.users (id) on delete set null,
  created_by             uuid references auth.users (id) on delete set null,
  is_security_incident   boolean not null default false,
  escalation_level       int not null default 0 check (escalation_level between 0 and 3),
  last_escalated_at      timestamptz,
  sla_started_at         timestamptz,
  acknowledged_at        timestamptz,
  diagnosed_at           timestamptz,
  workaround_at          timestamptz,
  resolved_at            timestamptz,
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint nexo_sd_tickets_org_required check (org_id is not null or intake_status <> 'aceptado'),
  constraint nexo_sd_tickets_web_answers check (channel <> 'web' or classification_answers is not null)
);
comment on table public.nexo_sd_tickets is
  'Mesa de soporte Nexo: tickets. La severidad se calcula siempre desde classification_answers (BT-061).';
comment on column public.nexo_sd_tickets.intake_status is
  'aceptado: corre el SLA. cuarentena: remitente no registrado, espera revisión de un agente (sin relojes). descartado: rechazado.';
create index if not exists nexo_sd_tickets_org_status_idx on public.nexo_sd_tickets (org_id, status);
create index if not exists nexo_sd_tickets_status_idx on public.nexo_sd_tickets (status) where status <> 'cerrado';
create index if not exists nexo_sd_tickets_assignee_idx on public.nexo_sd_tickets (assignee_id);
create index if not exists nexo_sd_tickets_intake_idx on public.nexo_sd_tickets (intake_status) where intake_status <> 'aceptado';

-- -----------------------------------------------------------------------------
-- Línea de tiempo
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_ticket_events (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.nexo_sd_tickets (id) on delete cascade,
  type        text not null check (type in ('comment', 'status_change', 'pause', 'resume', 'escalation',
                                            'notification', 'attachment', 'assignment', 'reclassification',
                                            'remote_access', 'security')),
  visibility  text not null default 'publico' check (visibility in ('publico', 'interno')),
  body        text check (body is null or char_length(body) <= 20000),
  payload     jsonb not null default '{}'::jsonb,
  author_id   uuid references auth.users (id) on delete set null,
  author_name text,
  created_at  timestamptz not null default now(),
  seq         bigint generated always as identity
);
comment on table public.nexo_sd_ticket_events is
  'Mesa de soporte Nexo: línea de tiempo inmutable. interno solo lo ven agentes y supervisores. Orden: created_at, seq.';
create index if not exists nexo_sd_ticket_events_ticket_idx on public.nexo_sd_ticket_events (ticket_id, created_at, seq);
create unique index if not exists nexo_sd_ticket_events_external_ref
  on public.nexo_sd_ticket_events ((payload ->> 'external_ref')) where payload ? 'external_ref';

-- -----------------------------------------------------------------------------
-- Relojes SLA y pausas
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_sla_clocks (
  id                         uuid primary key default gen_random_uuid(),
  ticket_id                  uuid not null references public.nexo_sd_tickets (id) on delete cascade,
  metric                     text not null check (metric in ('acuse', 'diagnostico', 'solucion')),
  calendar                   text not null check (calendar in ('24x7', 'habil')),
  target_minutes             int check (target_minutes > 0),
  started_at                 timestamptz not null,
  due_at                     timestamptz,
  met_at                     timestamptz,
  breached_at                timestamptz,
  paused_seconds             numeric not null default 0 check (paused_seconds >= 0),
  paused_since               timestamptz,
  remaining_seconds_at_pause numeric,
  status                     text not null default 'en_curso'
                               check (status in ('en_curso', 'pausado', 'cumplido', 'incumplido', 'no_aplica')),
  notified_50_at             timestamptz,
  notified_80_at             timestamptz,
  notified_100_at            timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (ticket_id, metric)
);
comment on table public.nexo_sd_sla_clocks is
  'Mesa de soporte Nexo: un reloj por métrica. paused_seconds y remaining_seconds_at_pause se expresan en el calendario del reloj (corridos o hábiles).';
create index if not exists nexo_sd_sla_clocks_running_idx on public.nexo_sd_sla_clocks (due_at) where status = 'en_curso';

create table if not exists public.nexo_sd_clock_pauses (
  id                       uuid primary key default gen_random_uuid(),
  ticket_id                uuid not null references public.nexo_sd_tickets (id) on delete cascade,
  reason                   text not null check (reason in ('infraestructura_subtel', 'red', 'terceros',
                                                          'decision_subtel', 'acceso_remoto_pendiente')),
  justification            text not null check (char_length(btrim(justification)) >= 10),
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz,
  created_by               uuid references auth.users (id) on delete set null,
  ended_by                 uuid references auth.users (id) on delete set null,
  remote_access_request_id uuid,
  subtel_ack_status        text check (subtel_ack_status in ('aceptada', 'objetada')),
  subtel_ack_by            uuid references auth.users (id) on delete set null,
  subtel_ack_at            timestamptz,
  subtel_ack_note          text,
  created_at               timestamptz not null default now(),
  constraint nexo_sd_clock_pauses_range check (ended_at is null or ended_at >= started_at)
);
comment on table public.nexo_sd_clock_pauses is
  'Mesa de soporte Nexo: pausas tipificadas del reloj (BT-061). Una sola pausa abierta por ticket.';
create unique index if not exists nexo_sd_clock_pauses_one_open
  on public.nexo_sd_clock_pauses (ticket_id) where ended_at is null;
create index if not exists nexo_sd_clock_pauses_ticket_idx on public.nexo_sd_clock_pauses (ticket_id, started_at);

-- -----------------------------------------------------------------------------
-- Acceso remoto (BT-065)
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_remote_access_requests (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null references public.nexo_sd_tickets (id) on delete cascade,
  scope           text not null check (char_length(btrim(scope)) >= 5),
  justification   text not null check (char_length(btrim(justification)) >= 10),
  status          text not null default 'pendiente'
                    check (status in ('pendiente', 'habilitado', 'rechazado', 'revocado')),
  requested_by    uuid references auth.users (id) on delete set null,
  requested_at    timestamptz not null default now(),
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  enabled_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users (id) on delete set null,
  session_log_ref text,
  pause_id        uuid references public.nexo_sd_clock_pauses (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.nexo_sd_remote_access_requests is
  'Mesa de soporte Nexo: solicitudes de acceso remoto. Mientras están pendientes, el reloj queda en pausa (acceso_remoto_pendiente).';
create unique index if not exists nexo_sd_remote_access_one_pending
  on public.nexo_sd_remote_access_requests (ticket_id) where status = 'pendiente';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'nexo_sd_clock_pauses_remote_access_fk'
      and conrelid = 'public.nexo_sd_clock_pauses'::regclass
  ) then
    alter table public.nexo_sd_clock_pauses
      add constraint nexo_sd_clock_pauses_remote_access_fk
      foreign key (remote_access_request_id)
      references public.nexo_sd_remote_access_requests (id) on delete set null;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Turnos, notificaciones
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_oncall_shifts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  level      int not null check (level between 1 and 3),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  notes      text check (notes is null or char_length(notes) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nexo_sd_oncall_shifts_range check (ends_at > starts_at)
);
comment on table public.nexo_sd_oncall_shifts is
  'Mesa de soporte Nexo: turnos. Nivel 1 (primer contacto) -> 2 (técnico) -> 3 (seguridad y supervisión).';
create index if not exists nexo_sd_oncall_shifts_lookup on public.nexo_sd_oncall_shifts (level, starts_at, ends_at);

create table if not exists public.nexo_sd_notifications (
  id                uuid primary key default gen_random_uuid(),
  channel           text not null check (channel in ('email', 'whatsapp', 'push', 'voz')),
  recipient         text not null,
  recipient_user_id uuid references auth.users (id) on delete set null,
  ticket_id         uuid references public.nexo_sd_tickets (id) on delete cascade,
  template          text not null,
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'pendiente' check (status in ('pendiente', 'enviada', 'fallida')),
  priority          int not null default 5 check (priority between 1 and 9),
  attempts          int not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  locked_until      timestamptz,
  last_error        text,
  result            jsonb,
  sent_at           timestamptz,
  read_at           timestamptz,
  dedup_key         text unique,
  created_at        timestamptz not null default now()
);
comment on table public.nexo_sd_notifications is
  'Mesa de soporte Nexo: bandeja de salida. La procesa la función nexo-sd-notify (reintentos con espera creciente, máximo 5).';
create index if not exists nexo_sd_notifications_pending_idx
  on public.nexo_sd_notifications (priority, next_attempt_at) where status = 'pendiente';
create index if not exists nexo_sd_notifications_user_idx
  on public.nexo_sd_notifications (recipient_user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Incidentes de seguridad (Ley 21.663), RCA, paquetes de corrección, informes
-- -----------------------------------------------------------------------------
create table if not exists public.nexo_sd_security_incidents (
  id                   uuid primary key default gen_random_uuid(),
  ticket_id            uuid unique references public.nexo_sd_tickets (id) on delete set null,
  org_id               uuid references public.nexo_sd_organizations (id) on delete restrict,
  title                text not null check (char_length(btrim(title)) between 3 and 200),
  description          text,
  detected_at          timestamptz not null default now(),
  classification       text not null default 'por_clasificar'
                         check (classification in ('por_clasificar', 'significativo', 'no_significativo')),
  affected_services    text[] not null default '{}',
  early_alert_hours    numeric not null check (early_alert_hours > 0),
  second_report_hours  numeric not null check (second_report_hours > 0),
  final_report_days    numeric not null check (final_report_days > 0),
  early_alert_due_at   timestamptz,
  early_alert_sent_at  timestamptz,
  second_report_due_at timestamptz,
  second_report_at     timestamptz,
  final_report_due_at  timestamptz,
  final_report_at      timestamptz,
  csirt_reference      text,
  status               text not null default 'abierto' check (status in ('abierto', 'cerrado')),
  notes                text,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  closed_at            timestamptz
);
comment on table public.nexo_sd_security_incidents is
  'Mesa de soporte Nexo: incidentes de seguridad con los hitos de la Ley 21.663. Los plazos se copian desde nexo_sd_settings al crear el incidente.';

create table if not exists public.nexo_sd_rca_reports (
  id                 uuid primary key default gen_random_uuid(),
  ticket_id          uuid not null references public.nexo_sd_tickets (id) on delete cascade,
  org_id             uuid not null references public.nexo_sd_organizations (id) on delete restrict,
  title              text not null check (char_length(btrim(title)) between 3 and 200),
  summary            text not null,
  timeline           text,
  root_cause         text not null,
  corrective_actions text,
  preventive_actions text,
  status             text not null default 'borrador' check (status in ('borrador', 'publicado')),
  document_path      text,
  author_id          uuid references auth.users (id) on delete set null,
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.nexo_sd_rca_reports is
  'Mesa de soporte Nexo: análisis de causa raíz (después de cada S1 o S2).';
create index if not exists nexo_sd_rca_reports_org_idx on public.nexo_sd_rca_reports (org_id, status);

create table if not exists public.nexo_sd_patch_packages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.nexo_sd_organizations (id) on delete restrict,
  version         text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  title           text not null check (char_length(btrim(title)) between 3 and 200),
  description     text not null,
  rollback_plan   text not null check (char_length(btrim(rollback_plan)) >= 10),
  ticket_id       uuid references public.nexo_sd_tickets (id) on delete set null,
  artifact_path   text,
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  status          text not null default 'borrador'
                    check (status in ('borrador', 'pendiente_aprobacion', 'aprobado', 'rechazado', 'aplicado', 'revertido')),
  created_by      uuid references auth.users (id) on delete set null,
  approved_by     uuid references auth.users (id) on delete set null,
  approved_at     timestamptz,
  approval_note   text,
  applied_by      uuid references auth.users (id) on delete set null,
  applied_at      timestamptz,
  rolled_back_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, version)
);
comment on table public.nexo_sd_patch_packages is
  'Mesa de soporte Nexo: paquetes de corrección con plan de reversa (BT-054, BT-065). Aprobación de cuatro ojos.';

create table if not exists public.nexo_sd_monthly_reports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.nexo_sd_organizations (id) on delete cascade,
  period       text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  summary      jsonb not null default '{}'::jsonb,
  pdf_path     text,
  generated_at timestamptz not null default now(),
  generated_by uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (org_id, period)
);
comment on table public.nexo_sd_monthly_reports is
  'Mesa de soporte Nexo: informe mensual de cumplimiento del SLA (JSON y PDF en el bucket nexo-sd-adjuntos).';

-- -----------------------------------------------------------------------------
-- updated_at automático
-- -----------------------------------------------------------------------------
create or replace trigger nexo_sd_organizations_touch before update on public.nexo_sd_organizations
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_members_touch before update on public.nexo_sd_members
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_settings_touch before update on public.nexo_sd_settings
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_sla_policies_touch before update on public.nexo_sd_sla_policies
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_sla_clocks_touch before update on public.nexo_sd_sla_clocks
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_remote_access_touch before update on public.nexo_sd_remote_access_requests
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_oncall_shifts_touch before update on public.nexo_sd_oncall_shifts
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_security_incidents_touch before update on public.nexo_sd_security_incidents
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_rca_reports_touch before update on public.nexo_sd_rca_reports
  for each row execute function nexo_private.sd_touch_updated_at();
create or replace trigger nexo_sd_patch_packages_touch before update on public.nexo_sd_patch_packages
  for each row execute function nexo_private.sd_touch_updated_at();

-- -----------------------------------------------------------------------------
-- RLS en todas las tablas (las políticas están en la migración de RLS) y permisos base:
-- anon no tiene ningún privilegio; authenticated recibe solo lo necesario más adelante.
-- -----------------------------------------------------------------------------
alter table public.nexo_sd_organizations          enable row level security;
alter table public.nexo_sd_members                enable row level security;
alter table public.nexo_sd_settings               enable row level security;
alter table public.nexo_sd_holidays               enable row level security;
alter table public.nexo_sd_sla_policies           enable row level security;
alter table public.nexo_sd_tickets                enable row level security;
alter table public.nexo_sd_ticket_events          enable row level security;
alter table public.nexo_sd_sla_clocks             enable row level security;
alter table public.nexo_sd_clock_pauses           enable row level security;
alter table public.nexo_sd_remote_access_requests enable row level security;
alter table public.nexo_sd_oncall_shifts          enable row level security;
alter table public.nexo_sd_notifications          enable row level security;
alter table public.nexo_sd_security_incidents     enable row level security;
alter table public.nexo_sd_rca_reports            enable row level security;
alter table public.nexo_sd_patch_packages         enable row level security;
alter table public.nexo_sd_monthly_reports        enable row level security;
alter table nexo_private.sd_ticket_counters       enable row level security;

revoke all on table
  public.nexo_sd_organizations, public.nexo_sd_members, public.nexo_sd_settings, public.nexo_sd_holidays,
  public.nexo_sd_sla_policies, public.nexo_sd_tickets, public.nexo_sd_ticket_events, public.nexo_sd_sla_clocks,
  public.nexo_sd_clock_pauses, public.nexo_sd_remote_access_requests, public.nexo_sd_oncall_shifts,
  public.nexo_sd_notifications, public.nexo_sd_security_incidents, public.nexo_sd_rca_reports,
  public.nexo_sd_patch_packages, public.nexo_sd_monthly_reports
from anon, authenticated;

grant all on table
  public.nexo_sd_organizations, public.nexo_sd_members, public.nexo_sd_settings, public.nexo_sd_holidays,
  public.nexo_sd_sla_policies, public.nexo_sd_tickets, public.nexo_sd_ticket_events, public.nexo_sd_sla_clocks,
  public.nexo_sd_clock_pauses, public.nexo_sd_remote_access_requests, public.nexo_sd_oncall_shifts,
  public.nexo_sd_notifications, public.nexo_sd_security_incidents, public.nexo_sd_rca_reports,
  public.nexo_sd_patch_packages, public.nexo_sd_monthly_reports
to service_role;

revoke all on table nexo_private.sd_ticket_counters from public, anon, authenticated, service_role;

-- La tabla interna de correlativos no tiene acceso para ningún rol de la API (solo el dueño).
drop policy if exists nexo_sd_counters_sin_acceso on nexo_private.sd_ticket_counters;
create policy nexo_sd_counters_sin_acceso on nexo_private.sd_ticket_counters
  as restrictive for all to public using (false) with check (false);
