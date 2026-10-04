-- Yago Nexo · Consola · soporte para los motores (D-01, D-02, D-04, D-05) y el reenvío al SIEM

-- Quién detectó la anomalía: el motor propone, una persona distinta aprueba (cuatro ojos).
ALTER TABLE nexo.anomaly_event ADD COLUMN detected_by text NOT NULL DEFAULT 'nexo-guardian';

-- Una anomalía por regla, objetivo (consumidor o IP), métrica y ventana. Con NULL en consumidor
-- el índice anterior no impedía duplicados para las anomalías por IP.
DROP INDEX nexo.anomaly_event_unico_por_ventana;
CREATE UNIQUE INDEX anomaly_event_unico_por_ventana
  ON nexo.anomaly_event (rule_id, (coalesce(consumer, '')), (coalesce(source_ip, '')), metric, window_start);

-- Latido de cada motor: la Consola muestra si están vivos y quién tiene el liderazgo.
CREATE TABLE nexo.engine_heartbeat (
  engine     text NOT NULL,                       -- descubrimiento, guardian, despliegues, continuidad, siem
  instance   text NOT NULL,                       -- host:pid
  leader     boolean NOT NULL DEFAULT false,
  info       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engine, instance)
);

-- Despliegues progresivos: revisión estable a la que se vuelve y revisiones creadas por el motor.
ALTER TABLE nexo.rollout ADD COLUMN stable_revision_id text;
ALTER TABLE nexo.rollout ADD COLUMN created_revisions text[] NOT NULL DEFAULT '{}';
ALTER TABLE nexo.rollout ADD COLUMN started_at timestamptz;
ALTER TABLE nexo.rollout ADD COLUMN finished_at timestamptz;
ALTER TABLE nexo.rollout_step ADD COLUMN revision_id text;
ALTER TABLE nexo.rollout_step ADD COLUMN detail text;

-- Reenvío de la auditoría al SIEM sin pérdida: cursor por destino, avanza solo tras el acuse.
CREATE TABLE nexo.siem_cursor (
  destination  text PRIMARY KEY,
  last_seq     bigint NOT NULL DEFAULT 0,
  sent_total   bigint NOT NULL DEFAULT 0,
  last_error   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Descubrimiento: evidencia de la detección (encabezados, cuerpo resumido) y origen del hallazgo.
ALTER TABLE nexo.discovery_finding ADD COLUMN evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE nexo.discovery_finding ADD COLUMN observed_calls integer NOT NULL DEFAULT 0;

-- Aristas derivadas de la configuración del gateway (endpoints y suscripciones), distintas de las manuales.
ALTER TABLE nexo.graph_edge DROP CONSTRAINT graph_edge_source_check;
ALTER TABLE nexo.graph_edge ADD CONSTRAINT graph_edge_source_check
  CHECK (source IN ('manual', 'configuracion', 'analizador_mi', 'trafico_observado', 'openmetadata'));
UPDATE nexo.graph_edge SET source = 'configuracion' WHERE source = 'manual';
