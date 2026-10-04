import pg from "pg";

/**
 * Operaciones de PostgreSQL para la conmutación (D-05). En el laboratorio el sitio de respaldo tiene una
 * réplica por streaming; al conmutar se promueve con pg_promote(). El RPO estimado sale del rezago de
 * replicación en el momento de promover (bytes de WAL recibidos aún no aplicados). En SUBTEL el procedimiento
 * es el mismo con CloudNativePG en GKE.
 */
async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000, ssl: process.env.NEXO_DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.NEXO_DATABASE_SSL_INSECURE !== "true" } : undefined });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isInRecovery(url: string): Promise<boolean> {
  return withClient(url, async (c) => (await c.query<{ r: boolean }>("SELECT pg_is_in_recovery() AS r")).rows[0]!.r);
}

/** ¿El sitio de respaldo puede tomar el control? Su base responde (esté en espera o ya promovida). */
export async function backupReady(replicaUrl: string): Promise<boolean> {
  return withClient(replicaUrl, async (c) => {
    await c.query("SELECT 1");
    return true;
  }).catch(() => false);
}

/** Rezago de replicación de la réplica en bytes (0 si está al día o no se puede medir). */
export async function replicationLagBytes(replicaUrl: string): Promise<number> {
  return withClient(replicaUrl, async (c) => {
    const r = await c.query<{ lag: string | null }>("SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag").catch(() => ({ rows: [{ lag: null }] }));
    return Number(r.rows[0]?.lag ?? 0) || 0;
  });
}

/** Promueve la réplica a primario y espera a que acepte escrituras. Devuelve los milisegundos que tardó. */
export async function promote(replicaUrl: string, timeoutMs = 30_000): Promise<number> {
  const t0 = Date.now();
  await withClient(replicaUrl, async (c) => {
    if (!(await c.query<{ r: boolean }>("SELECT pg_is_in_recovery() AS r")).rows[0]!.r) return; // ya es primario
    await c.query("SELECT pg_promote(true, 60)");
  });
  while (Date.now() - t0 < timeoutMs) {
    const recovering = await isInRecovery(replicaUrl).catch(() => true);
    if (!recovering) {
      // El sitio promovido debe aceptar escrituras: se levanta el cierre heredado del primario (si lo había)
      // y se confirma con una escritura real antes de darla por promovida.
      await withClient(replicaUrl, async (c) => {
        await c.query("ALTER SYSTEM RESET default_transaction_read_only");
        await c.query("SELECT pg_reload_conf()");
        await c.query("CREATE TEMP TABLE nexo_promote_ok (x int)");
      });
      return Date.now() - t0;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`la réplica no terminó de promoverse en ${timeoutMs} ms`);
}

/**
 * Cierra las escrituras en el primario, si todavía responde (evita que ambos sitios acepten escrituras).
 * En el laboratorio se hace por defecto; si el primario ya no responde, no es necesario.
 */
export async function fenceWrites(primaryUrl: string): Promise<boolean> {
  return withClient(primaryUrl, async (c) => {
    await c.query("ALTER SYSTEM SET default_transaction_read_only = on");
    await c.query("SELECT pg_reload_conf()");
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'").catch(() => undefined);
    return true;
  }).catch(() => false);
}
