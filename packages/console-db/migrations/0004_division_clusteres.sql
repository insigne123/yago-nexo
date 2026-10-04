-- Yago Nexo · Consola · clústeres de nexo-division con "crear antes de quitar" (D-04)
-- Cada backend (URL) es un clúster de Envoy con nombre propio. Al promover el candidato la ruta sigue usando
-- el mismo clúster, y un clúster que deja de usarse se conserva un tiempo de gracia antes de retirarlo:
-- así ningún cambio de ruta apunta a un clúster que Envoy todavía no tiene o que ya quitó.
CREATE TABLE nexo.traffic_cluster (
  api_id           text NOT NULL REFERENCES nexo.traffic_route (api_id) ON DELETE CASCADE,
  url              text NOT NULL,
  last_referenced  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_id, url)
);
