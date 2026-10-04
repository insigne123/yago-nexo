-- Yago Nexo · Consola · división de tráfico sin redespliegue (D-04)
-- El tráfico de las APIs con despliegue progresivo pasa por nexo-division (Envoy). El motor de despliegues
-- cambia pesos y tráfico sombra en vivo, sin redesplegar la API en WSO2: no hay corte de servicio.

CREATE TABLE nexo.traffic_route (
  api_id          text PRIMARY KEY,                    -- id de la API en WSO2
  api_name        text NOT NULL,
  environment     text NOT NULL DEFAULT 'prod',
  route_prefix    text NOT NULL UNIQUE,                -- /rutas/<nombre>
  seed_url        text NOT NULL,                       -- backend estable declarado en el proyecto versionado
  stable_url      text NOT NULL,                       -- backend estable vigente
  candidate_url   text,
  weight          integer NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 100),
  mirror_percent  integer NOT NULL DEFAULT 0 CHECK (mirror_percent BETWEEN 0 AND 100),
  rollout_id      uuid REFERENCES nexo.rollout (id) ON DELETE SET NULL,
  revision_id     text,                                -- revisión de WSO2 desplegada que declaró la ruta
  version         bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Paso de tráfico sombra opcional antes del canary: el candidato recibe una copia de las lecturas (GET/HEAD)
-- y sus respuestas se descartan; si falla, se revierte sin que ningún consumidor lo note.
ALTER TABLE nexo.rollout ADD COLUMN shadow_seconds integer NOT NULL DEFAULT 0 CHECK (shadow_seconds BETWEEN 0 AND 3600);
ALTER TABLE nexo.rollout_step ADD COLUMN kind text NOT NULL DEFAULT 'canary' CHECK (kind IN ('sombra', 'canary', 'blue_green'));
ALTER TABLE nexo.rollout_step ADD COLUMN baseline jsonb;

-- Ya no se crean revisiones por paso: los pesos viven en la ruta.
ALTER TABLE nexo.rollout DROP COLUMN created_revisions;
ALTER TABLE nexo.rollout DROP COLUMN stable_revision_id;
