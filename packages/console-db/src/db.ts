import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.NEXO_DATABASE_URL): Db {
  if (!connectionString) throw new Error("Falta NEXO_DATABASE_URL");
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.NEXO_DATABASE_POOL ?? 10),
    ssl: process.env.NEXO_DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.NEXO_DATABASE_SSL_INSECURE !== "true" } : undefined,
  });
  // Los timestamps se devuelven como string ISO para no perder la zona horaria en JSON.
  pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
  pg.types.setTypeParser(20, (v) => Number(v)); // bigint → number (secuencias de auditoría)
  pg.types.setTypeParser(1700, (v) => Number(v)); // numeric → number
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Aplica las migraciones pendientes en orden, con bloqueo para que dos réplicas no migren a la vez. */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE SCHEMA IF NOT EXISTS nexo");
    await client.query(
      "CREATE TABLE IF NOT EXISTS nexo.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM nexo.schema_migrations")).rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO nexo.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        log(`migración aplicada: ${file}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`falló la migración ${file}: ${e instanceof Error ? e.message : e}`, { cause: e });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
  }
  return applied;
}
