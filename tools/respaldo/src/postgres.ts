// Acceso a PostgreSQL desde la herramienta: snapshot exportado, conteo de filas y sondas.
import { readFileSync } from "node:fs";
import pg from "pg";
import type { ModoTls } from "./config.js";
import type { ConteoTabla, SondaAuditoria } from "./manifiesto.js";

export interface Conexion {
  host: string;
  puerto: number;
  usuario: string;
  clave: string;
  base: string;
  tls?: ModoTls;
  ca?: string;
}

function ssl(c: Conexion): pg.ClientConfig["ssl"] {
  if (!c.tls || c.tls === "desactivado") return false;
  if (c.tls === "requerido") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ca: readFileSync(c.ca!, "utf8") };
}

/**
 * Abre una sesión con parámetros fijos de salida: la huella del contenido se calcula con el texto
 * de cada fila, que no debe depender de la zona horaria ni del estilo de fechas de la sesión.
 */
export async function conectar(c: Conexion): Promise<pg.Client> {
  const cliente = new pg.Client({
    host: c.host,
    port: c.puerto,
    user: c.usuario,
    password: c.clave,
    database: c.base,
    ssl: ssl(c),
    application_name: "nexo-respaldo",
    connectionTimeoutMillis: 15_000,
  });
  await cliente.connect();
  await cliente.query(
    `SET TimeZone = 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1;
     SET bytea_output = 'hex'; SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0; SET lock_timeout = '60s'`,
  );
  return cliente;
}

export interface Snapshot {
  id: string;
  instante: string;
  lsn: string | null;
}

/**
 * Abre una transacción REPEATABLE READ de solo lectura y exporta su snapshot. Mientras la
 * transacción siga abierta, pg_dump --snapshot ve exactamente los mismos datos que se cuentan aquí.
 */
export async function exportarSnapshot(cliente: pg.Client): Promise<Snapshot> {
  await cliente.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const r = await cliente.query<{ id: string; instante: string; lsn: string | null }>(
    `SELECT pg_export_snapshot() AS id,
            to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instante,
            (CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END)::text AS lsn`,
  );
  const fila = r.rows[0]!;
  return { id: fila.id, instante: fila.instante, lsn: fila.lsn };
}

export async function versionServidor(cliente: pg.Client): Promise<{ version: string; num: number }> {
  const r = await cliente.query<{ v: string; n: string }>(
    "SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n",
  );
  return { version: r.rows[0]!.v, num: Number(r.rows[0]!.n) };
}

/** Bases que se pueden respaldar: todas las que aceptan conexiones, salvo las plantillas. */
export async function listarBases(cliente: pg.Client): Promise<string[]> {
  const r = await cliente.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
  );
  return r.rows.map((f) => f.datname);
}

/** Tablas de usuario (ordinarias y particionadas), sin catálogos ni tablas temporales. */
export async function listarTablas(cliente: pg.Client): Promise<{ esquema: string; tabla: string }[]> {
  const r = await cliente.query<{ esquema: string; tabla: string }>(
    `SELECT n.nspname AS esquema, c.relname AS tabla
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      ORDER BY 1, 2`,
  );
  return r.rows;
}

/**
 * Cuenta las filas de cada tabla y, si se pide, calcula una huella del contenido: la suma de los
 * primeros 60 bits del MD5 del texto de cada fila. No depende del orden físico de las filas (que
 * cambia al restaurar) y no necesita ordenar la tabla. Sirve para detectar una restauración
 * incompleta o distinta; la integridad criptográfica de los archivos la da AES-GCM.
 */
export async function contarTablas(cliente: pg.Client, huella: boolean): Promise<ConteoTabla[]> {
  const tablas = await listarTablas(cliente);
  const conteos: ConteoTabla[] = [];
  for (const t of tablas) {
    const nombre = `${cliente.escapeIdentifier(t.esquema)}.${cliente.escapeIdentifier(t.tabla)}`;
    const sql = huella
      ? `SELECT count(*)::text AS filas,
                coalesce(sum(('x' || substr(md5(__fila_respaldo::text), 1, 15))::bit(60)::bigint), 0)::text AS huella
           FROM ${nombre} AS __fila_respaldo`
      : `SELECT count(*)::text AS filas FROM ${nombre}`;
    const r = await cliente.query<{ filas: string; huella?: string }>(sql);
    const fila = r.rows[0]!;
    const conteo: ConteoTabla = { esquema: t.esquema, tabla: t.tabla, filas: Number(fila.filas) };
    if (huella) conteo.huella = fila.huella!;
    conteos.push(conteo);
  }
  return conteos;
}

/** Estado de la cadena de auditoría de la Consola, si la base la tiene (tabla nexo.audit_event). */
export async function sondaAuditoria(cliente: pg.Client): Promise<SondaAuditoria | undefined> {
  const existe = await cliente.query<{ t: string | null }>(
    "SELECT to_regclass('nexo.audit_event')::text AS t",
  );
  if (!existe.rows[0]?.t) return undefined;
  const r = await cliente.query<{ eventos: string; ultimo_seq: string | null; ultimo_hash: string | null }>(
    `SELECT (SELECT count(*) FROM nexo.audit_event)::text AS eventos,
            ultimo.seq::text AS ultimo_seq, ultimo.hash::text AS ultimo_hash
       FROM (SELECT 1) AS uno
       LEFT JOIN LATERAL (SELECT seq, hash FROM nexo.audit_event ORDER BY seq DESC LIMIT 1) AS ultimo ON true`,
  );
  const f = r.rows[0]!;
  return {
    eventos: Number(f.eventos),
    ultimoSeq: f.ultimo_seq === null ? null : Number(f.ultimo_seq),
    ultimoHash: f.ultimo_hash,
  };
}
