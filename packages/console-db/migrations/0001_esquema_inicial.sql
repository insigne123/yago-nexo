-- Yago Nexo · Consola · esquema inicial
-- PostgreSQL estándar (12+). Todo vive en el esquema "nexo"; solo el backend de la Consola accede.

CREATE SCHEMA IF NOT EXISTS nexo;

-- ---------------------------------------------------------------- catálogo (BT-018)
CREATE TABLE nexo.api_asset (
  id                text PRIMARY KEY,                -- "api:<id WSO2>"
  wso2_api_id       text UNIQUE NOT NULL,
  name              text NOT NULL,
  version           text NOT NULL,
  context           text NOT NULL,
  type              text NOT NULL DEFAULT 'HTTP',
  purpose           text,
  owner_team        text,
  owner_contact     text,
  audience          text CHECK (audience IN ('interna', 'operadores', 'publica')),
  state             text NOT NULL DEFAULT 'CREATED',
  auth_type         text,
  contract_ref      text,
  classification    text CHECK (classification IN ('publica', 'interna', 'reservada', 'datos_personales')),
  consumers_count   integer NOT NULL DEFAULT 0,
  dependencies_count integer NOT NULL DEFAULT 0,
  synced_at         timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nexo.api_history (
  id        bigserial PRIMARY KEY,
  api_id    text NOT NULL REFERENCES nexo.api_asset (id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  detail    text
);
CREATE INDEX ON nexo.api_history (api_id, ts DESC);

CREATE TABLE nexo.consumer (
  id            text PRIMARY KEY,                    -- id de aplicación WSO2
  name          text NOT NULL,
  organization  text,
  contact       text,
  audience      text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nexo.subscription (
  consumer_id  text NOT NULL REFERENCES nexo.consumer (id) ON DELETE CASCADE,
  api_id       text NOT NULL REFERENCES nexo.api_asset (id) ON DELETE CASCADE,
  plan         text,
  status       text,
  PRIMARY KEY (consumer_id, api_id)
);

-- ---------------------------------------------------------------- grafo de dependencias e impacto (BT-022, BT-024)
CREATE TABLE nexo.graph_node (
  id     text PRIMARY KEY,                           -- "api:..", "flujo:..", "sistema:..", "dato:..", "consumidor:..", "reporte:.."
  type   text NOT NULL CHECK (type IN ('api', 'flujo', 'sistema', 'dato', 'consumidor', 'reporte')),
  label  text NOT NULL,
  meta   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE nexo.graph_edge (
  from_id   text NOT NULL REFERENCES nexo.graph_node (id) ON DELETE CASCADE,
  to_id     text NOT NULL REFERENCES nexo.graph_node (id) ON DELETE CASCADE,
  relation  text NOT NULL CHECK (relation IN ('llama', 'lee', 'escribe', 'publica', 'transforma', 'consume')),
  source    text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'analizador_mi', 'trafico_observado', 'openmetadata')),
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX ON nexo.graph_edge (to_id);

-- ---------------------------------------------------------------- descubrimiento (D-01)
CREATE TABLE nexo.discovery_scan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status        text NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso', 'terminado', 'fallido')),
  sources       text[] NOT NULL DEFAULT '{}',
  targets       text[] NOT NULL DEFAULT '{}',
  totals        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  requested_by  text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE nexo.discovery_finding (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint             text UNIQUE NOT NULL,      -- fuente + host + puerto + ruta
  scan_id                 uuid REFERENCES nexo.discovery_scan (id) ON DELETE SET NULL,
  source                  text NOT NULL CHECK (source IN ('apisix', 'nginx', 'red', 'gcp')),
  host                    text NOT NULL,
  port                    integer,
  path                    text NOT NULL,
  protocol                text,
  spec_found              boolean NOT NULL DEFAULT false,
  auth_detected           text NOT NULL DEFAULT 'desconocida',
  tls                     text,
  personal_data_suspected boolean NOT NULL DEFAULT false,
  matched_api_id          text,
  exposure_score          integer NOT NULL DEFAULT 0 CHECK (exposure_score BETWEEN 0 AND 100),
  reasons                 text[] NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'gobernado', 'riesgo_aceptado', 'en_migracion', 'descartado')),
  note                    text,
  first_seen              timestamptz NOT NULL DEFAULT now(),
  last_seen               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- anomalías y bloqueos (D-02)
CREATE TABLE nexo.anomaly_rule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  api_id             text,
  consumer_id        text,
  metric             text NOT NULL CHECK (metric IN ('volumen', 'errores', 'latencia', 'tamano', 'ips_distintas', 'fuera_de_horario')),
  sensitivity        numeric NOT NULL DEFAULT 4 CHECK (sensitivity BETWEEN 1 AND 10),
  min_volume         integer NOT NULL DEFAULT 30,
  action             text NOT NULL CHECK (action IN ('alertar', 'bloquear_automatico', 'bloquear_con_aprobacion')),
  block_ttl_minutes  integer NOT NULL DEFAULT 30,
  enabled            boolean NOT NULL DEFAULT true,
  created_by         text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nexo.block (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deny_policy_id   text,
  condition_type   text NOT NULL CHECK (condition_type IN ('APPLICATION', 'IP', 'USER', 'API')),
  condition_value  text NOT NULL,
  reason           text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  created_by       text NOT NULL,
  released_by      text,
  released_at      timestamptz
);

CREATE TABLE nexo.anomaly_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  rule_id       uuid REFERENCES nexo.anomaly_rule (id) ON DELETE SET NULL,
  api_name      text,
  consumer      text,
  source_ip     text,
  metric        text NOT NULL,
  observed      numeric NOT NULL,
  baseline      numeric NOT NULL,
  score         numeric NOT NULL,
  window_start  timestamptz,
  action_taken  text,
  block_id      uuid REFERENCES nexo.block (id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'bloqueo_propuesto', 'bloqueada', 'descartada', 'resuelta')),
  approved_by   text,
  dismissed_by  text,
  reason        text
);
CREATE INDEX ON nexo.anomaly_event (ts DESC);
CREATE UNIQUE INDEX anomaly_event_unico_por_ventana ON nexo.anomaly_event (rule_id, consumer, metric, window_start);

-- ---------------------------------------------------------------- despliegues progresivos (D-04)
CREATE TABLE nexo.rollout (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id              text NOT NULL,
  api_name            text,
  strategy            text NOT NULL CHECK (strategy IN ('canary', 'blue_green')),
  candidate_endpoint  text NOT NULL,
  stable_endpoint     text,
  steps               integer[] NOT NULL DEFAULT '{5,25,50,100}',
  step_duration_sec   integer NOT NULL DEFAULT 60,
  thresholds          jsonb NOT NULL DEFAULT '{"maxErrorRate":0.02,"maxP99Ms":800,"minRequests":20}'::jsonb,
  environment         text NOT NULL DEFAULT 'prod',
  status              text NOT NULL DEFAULT 'pendiente_aprobacion'
                        CHECK (status IN ('pendiente_aprobacion', 'en_curso', 'completado', 'revertido', 'abortado')),
  current_weight      integer NOT NULL DEFAULT 0,
  rollback_reason     text,
  created_by          text NOT NULL,
  approved_by         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nexo.rollout_step (
  id          bigserial PRIMARY KEY,
  rollout_id  uuid NOT NULL REFERENCES nexo.rollout (id) ON DELETE CASCADE,
  weight      integer NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  requests    integer NOT NULL DEFAULT 0,
  error_rate  numeric,
  p99_ms      numeric,
  decision    text NOT NULL DEFAULT 'pendiente' CHECK (decision IN ('avanzar', 'revertir', 'pendiente'))
);

-- ---------------------------------------------------------------- continuidad (D-05, BT-036)
CREATE TABLE nexo.continuity_settings (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode               text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'automatico')),
  active_site        text NOT NULL DEFAULT 'cpd',
  rto_objetivo_min   numeric NOT NULL DEFAULT 15,
  rpo_objetivo_min   numeric NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text
);
INSERT INTO nexo.continuity_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE nexo.site_status (
  id         text PRIMARY KEY,                         -- cpd, gcp, testigo
  name       text NOT NULL,
  role       text NOT NULL CHECK (role IN ('primario', 'respaldo', 'testigo')),
  checks     jsonb NOT NULL DEFAULT '{}'::jsonb,
  vote       text NOT NULL DEFAULT 'sin_voto' CHECK (vote IN ('primario_sano', 'primario_caido', 'sin_voto')),
  last_seen  timestamptz
);

CREATE TABLE nexo.failover_event (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CHECK (kind IN ('conmutacion', 'retorno', 'simulacro')),
  trigger                text NOT NULL CHECK (trigger IN ('automatico', 'manual', 'simulacro')),
  from_site              text NOT NULL,
  to_site                text NOT NULL,
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  rto_seconds            numeric,
  rpo_seconds_estimated  numeric,
  steps                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                 text NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso', 'completado', 'fallido')),
  requested_by           text,
  approved_by            text
);

-- ---------------------------------------------------------------- mensajes fallidos (BT-051)
CREATE TABLE nexo.dead_letter (
  id                text PRIMARY KEY,                  -- correlación del mensaje
  queue             text NOT NULL,
  flow              text,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  first_failed_at   timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'reprocesado', 'descartado')),
  reprocessed_by    text,
  reprocessed_at    timestamptz,
  reason            text,
  payload_preview   text
);

-- ---------------------------------------------------------------- auditoría (BT-031, BT-032)
CREATE TABLE nexo.audit_event (
  id              uuid PRIMARY KEY,
  seq             bigint UNIQUE NOT NULL,
  ts              timestamptz NOT NULL,
  source          text NOT NULL,
  actor           text NOT NULL,
  actor_type      text NOT NULL,
  action          text NOT NULL,
  resource        text,
  result          text NOT NULL,
  source_ip       text,
  correlation_id  text,
  details         jsonb,
  prev_hash       char(64) NOT NULL,
  hash            char(64) NOT NULL
);
CREATE INDEX ON nexo.audit_event (ts DESC);
CREATE INDEX ON nexo.audit_event (actor);

-- ---------------------------------------------------------------- alertas y exportaciones
CREATE TABLE nexo.alert (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL,
  name         text NOT NULL,
  severity     text,
  summary      text,
  labels       jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint  text
);

CREATE TABLE nexo.export_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'en_curso' CHECK (status IN ('en_curso', 'listo', 'fallido')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  manifest    jsonb,
  file_path   text,
  error       text
);
