/**
 * Infraestructura de mensajería del flujo de solicitudes (BT-009, BT-051):
 * - nexo.solicitudes (direct) → solicitudes.nuevas
 * - nexo.reintentos (direct) → solicitudes.reintento.{1,2,3} con TTL 2/4/8 s que vuelven a la cola principal
 * - nexo.dlq (direct) → solicitudes.dlq (mensajes no procesados, reproceso autorizado)
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
  if (!res.ok && res.status !== 204) throw new Error(`RabbitMQ PUT ${path}: ${res.status} ${await res.text()}`);
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
  log("RabbitMQ: exchanges, cola principal, colas de reintento (2/4/8 s) y cola de fallidos listas");
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
