-- Yago Nexo · Consola · retorno al sitio principal con dos personas (BT-026, BT-036)
-- El retorno lo solicita una persona (operador o aprobador) y lo aprueba otra (aprobador). La solicitud vence:
-- si nadie la aprueba a tiempo queda «vencida» y hay que pedirla de nuevo. Solo la aprobación crea el evento de
-- conmutación que ejecutan los agentes de continuidad.

CREATE TABLE nexo.failback_request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_site          text NOT NULL,
  to_site            text NOT NULL DEFAULT 'cpd',
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'vencida')),
  requested_by       text NOT NULL,
  requested_by_sub   text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  decided_by         text,
  decided_by_sub     text,
  decided_at         timestamptz,
  decision_reason    text,
  failover_event_id  uuid REFERENCES nexo.failover_event (id) ON DELETE SET NULL,
  CHECK (expires_at > requested_at)
);
CREATE INDEX ON nexo.failback_request (requested_at DESC);

-- Una sola solicitud pendiente a la vez (las vencidas se marcan antes de crear otra).
CREATE UNIQUE INDEX failback_request_una_pendiente ON nexo.failback_request ((true)) WHERE status = 'pendiente';
