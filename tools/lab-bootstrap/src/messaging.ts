/**
 * Infraestructura de mensajería del flujo de solicitudes (BT-009, BT-051):
 * - nexo.solicitudes (direct) → solicitudes.nuevas
 * - nexo.reintentos (direct) → solicitudes.reintento.{1,2,3} con TTL 2/4/8 s que vuelven a la cola principal
 * - nexo.dlq (direct) → solicitudes.dlq (mensajes no procesados, reproceso autorizado), con la política
 *   POLITICA_FALLIDOS para que consultarla no descarte mensajes
 * y la tabla de idempotencia de Micro Integrator.
 */
import pg from "pg";

const MQ = process.env.NEXO_RABBITMQ_API ?? "http://rabbitmq:15672/api";
const auth = `Basic ${Buffer.from(`nexo:${process.env.RABBITMQ_PASSWORD ?? "nexo-lab-mq"}`).toString("base64")}`;

async function put(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${MQ}${path}`, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204)
    throw new Error(`RabbitMQ PUT ${path}: ${res.status} ${await res.text()}`);
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${MQ}${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RabbitMQ POST ${path}: ${res.status} ${await res.text()}`);
}

const v = "%2F";

/**
 * Política de la cola de fallidos (1-06). En RabbitMQ 4.x una cola quorum tiene un límite de entregas (20 por
 * omisión) y descarta el mensaje que lo supera. Medido en RabbitMQ 4.3.6, la versión del laboratorio, leyendo la
 * cola con la API de administración (POST /api/queues/{vhost}/{cola}/get):
 *   - con ackmode reject_requeue_true (o cualquier lector que rechace y devuelva), después de la lectura 21 el
 *     mensaje desaparece (la 22 ya no lo encuentra) sin que nadie lo reprocese;
 *   - con ackmode ack_requeue_true, el modo que usa la Consola, no se descarta (66 lecturas, mensaje intacto).
 * Con delivery-limit -1 la cola de fallidos queda sin límite de entregas (RabbitMQ lo informa como «unlimited»)
 * y ninguna forma de consultarla la vacía: 25 lecturas reject_requeue_true y el mensaje sigue. Solo se aplica a
 * solicitudes.dlq: la cola principal y las de reintento conservan el límite por omisión.
 */
export const POLITICA_FALLIDOS = {
  nombre: "nexo-fallidos-sin-limite-de-entregas",
  cuerpo: {
    pattern: "^solicitudes\\.dlq$",
    "apply-to": "quorum_queues",
    priority: 10,
    definition: { "delivery-limit": -1 },
  },
} as const;

export async function ensureMessaging(log: (m: string) => void): Promise<void> {
  for (const ex of ["nexo.solicitudes", "nexo.reintentos", "nexo.dlq"]) {
    await put(`/exchanges/${v}/${ex}`, { type: "direct", durable: true });
  }
  await put(`/queues/${v}/solicitudes.nuevas`, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await post(`/bindings/${v}/e/nexo.solicitudes/q/solicitudes.nuevas`, { routing_key: "nueva" });
  for (const n of [1, 2, 3]) {
    const q = `solicitudes.reintento.${n}`;
    await put(`/queues/${v}/${q}`, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-message-ttl": 2 ** n * 1000,
        "x-dead-letter-exchange": "nexo.solicitudes",
        "x-dead-letter-routing-key": "nueva",
        "x-dead-letter-strategy": "at-least-once",
        "x-overflow": "reject-publish",
      },
    });
    await post(`/bindings/${v}/e/nexo.reintentos/q/${q}`, { routing_key: String(n) });
  }
  await put(`/queues/${v}/solicitudes.dlq`, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await post(`/bindings/${v}/e/nexo.dlq/q/solicitudes.dlq`, { routing_key: "fallido" });
  // Una política (y no un argumento de la cola) porque los argumentos de una cola quorum ya declarada no se pueden
  // cambiar, y la política se aplica también a la cola existente del laboratorio sin perder sus mensajes.
  await put(`/policies/${v}/${POLITICA_FALLIDOS.nombre}`, POLITICA_FALLIDOS.cuerpo);
  log(
    "RabbitMQ: exchanges, cola principal, colas de reintento (2/4/8 s) y cola de fallidos (sin límite de entregas) listas",
  );
}

export async function ensureMiDatabase(log: (m: string) => void): Promise<void> {
  const client = new pg.Client({
    host: process.env.NEXO_PG_HOST ?? "localhost",
    port: Number(process.env.NEXO_PG_PORT ?? 15432),
    user: "mi",
    password: process.env.MI_DB_PASSWORD ?? "nexo-lab-mi",
    database: "mi_db",
  });
  await client.connect();
  await client.query(`DROP TABLE IF EXISTS nexo_idem_v0`);
  await client.query(`CREATE TABLE IF NOT EXISTS nexo_idem (
    clave varchar(200) PRIMARY KEY,
    id_solicitud varchar(64) NOT NULL,
    rut varchar(20) NOT NULL,
    razon_social varchar(200),
    correlacion varchar(100),
    creado_en timestamptz NOT NULL DEFAULT now()
  )`);
  // Compatibilidad con la primera versión de la tabla (columna respuesta).
  await client.query(`ALTER TABLE nexo_idem ADD COLUMN IF NOT EXISTS id_solicitud varchar(64)`);
  await client.query(`ALTER TABLE nexo_idem ADD COLUMN IF NOT EXISTS rut varchar(20)`);
  await client.query(`ALTER TABLE nexo_idem ADD COLUMN IF NOT EXISTS razon_social varchar(200)`);
  await client.query(`ALTER TABLE nexo_idem ADD COLUMN IF NOT EXISTS correlacion varchar(100)`);
  await client.query(`ALTER TABLE nexo_idem DROP COLUMN IF EXISTS respuesta`);
  await client.end();
  log("PostgreSQL: tabla de idempotencia de Micro Integrator lista");
}
