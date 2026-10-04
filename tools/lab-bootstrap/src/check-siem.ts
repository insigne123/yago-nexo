/**
 * Verificación del reenvío de auditoría al SIEM sin pérdida (BT-031, BT-032). El SIEM del laboratorio es
 * Fluent Bit (syslog RFC 5424) → OpenSearch nexo-siem-*:
 *   1. todos los eventos de la cadena están en el SIEM, sin huecos, y la cadena se verifica desde el SIEM;
 *   2. con el SIEM caído los eventos esperan en la base; al volver llegan todos, en orden;
 *   3. un reenvío (entrega "al menos una vez") no duplica: el id del evento es el id del documento.
 */
import { execFileSync } from "node:child_process";
import { fetch } from "undici";
import pg from "pg";
import { computeHash, GENESIS_HASH, type AuditEvent } from "@nexo/shared";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const OPENSEARCH = process.env.NEXO_OPENSEARCH_URL ?? "http://localhost:9200";
const DB_URL = process.env.NEXO_DATABASE_URL ?? "postgres://nexo:nexo-lab-console@localhost:15432/nexo";
const SIEM_CONTAINER = process.env.NEXO_LAB_SIEM_CONTAINER ?? "nexo-lab-fluent-bit-1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(username: string) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", username, password: PASSWORD }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function waitUntil(fn: () => Promise<boolean>, timeoutSec: number): Promise<number | undefined> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (await fn()) return Math.round((Date.now() - t0) / 1000);
    await sleep(1000);
  }
  return undefined;
}

/** Eventos tal como quedaron en el SIEM, ordenados por secuencia. */
async function siemEvents(): Promise<AuditEvent[]> {
  await fetch(`${OPENSEARCH}/nexo-siem-*/_refresh`, { method: "POST" });
  const out: AuditEvent[] = [];
  let after: unknown[] | undefined;
  for (;;) {
    const res = await fetch(`${OPENSEARCH}/nexo-siem-*/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: 1000, sort: [{ seq: "asc" }], ...(after ? { search_after: after } : {}) }),
    });
    const body = (await res.json()) as { hits?: { hits: Array<{ _source: Record<string, unknown>; sort: unknown[] }> } };
    const hits = body.hits?.hits ?? [];
    for (const h of hits) {
      const s = h._source;
      const e: Record<string, unknown> = {};
      for (const k of ["id", "ts", "seq", "source", "actor", "actorType", "action", "resource", "result", "sourceIp", "correlationId", "details", "prevHash", "hash"]) {
        if (s[k] !== undefined) e[k] = s[k];
      }
      out.push(e as unknown as AuditEvent);
    }
    if (hits.length < 1000) break;
    after = hits.at(-1)!.sort;
  }
  return out;
}

/** Verifica la cadena con lo que tiene el SIEM: secuencia continua desde 1 y cada hash recalculado. */
function verify(events: readonly AuditEvent[]): { ok: boolean; detail: string } {
  let prev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, detail: `hueco: se esperaba seq ${i + 1} y llegó ${e.seq}` };
    if (e.prevHash !== prev) return { ok: false, detail: `encadenamiento roto en seq ${e.seq}` };
    const { hash, ...rest } = e;
    if (computeHash(prev, rest) !== hash) return { ok: false, detail: `hash alterado en seq ${e.seq}` };
    prev = hash;
  }
  return { ok: true, detail: `${events.length} eventos, cadena íntegra` };
}

async function main() {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const maxSeq = async () => Number((await db.query("SELECT coalesce(max(seq), 0) AS n FROM nexo.audit_event")).rows[0].n);
  const cursor = async () => (await db.query("SELECT last_seq, last_error FROM nexo.siem_cursor LIMIT 1")).rows[0] as { last_seq: number; last_error: string | null } | undefined;
  const caughtUp = async () => Number((await cursor())?.last_seq ?? -1) === (await maxSeq());
  const rows: Array<Record<string, unknown>> = [];
  try {
    // 1) Todo lo existente está en el SIEM y se verifica allí.
    const t1 = await waitUntil(caughtUp, 90);
    await sleep(4000); // Fluent Bit entrega a OpenSearch cada 2 s
    const total = await maxSeq();
    let siem = await siemEvents();
    let v = verify(siem);
    rows.push({ prueba: "toda la cadena llegó al SIEM", esperado: `${total} eventos · cadena íntegra`, obtenido: `${siem.length} eventos · ${v.detail}${t1 === undefined ? " · cursor atrasado" : ""}`, cumple: siem.length === total && v.ok });

    // 2) SIEM caído: los eventos esperan; al volver llegan todos.
    execFileSync("docker", ["stop", SIEM_CONTAINER], { stdio: "ignore" });
    const dev = await token("ana.desarrollo");
    const N = 25;
    for (let i = 0; i < N; i++) {
      await fetch(`${BASE}/impact/simulate`, {
        method: "POST",
        headers: { authorization: `Bearer ${dev}`, "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "sistema:registro-soap:7001", change: { kind: "campo", detail: `verificación SIEM ${i + 1}` } }),
      });
    }
    await sleep(12_000);
    const during = await cursor();
    const pending = (await maxSeq()) - Number(during?.last_seq ?? 0);
    rows.push({
      prueba: "con el SIEM caído los eventos esperan en la base",
      esperado: `≥ ${N} pendientes · error registrado`,
      obtenido: `${pending} pendientes · ${during?.last_error ? "error registrado" : "sin error"}`,
      cumple: pending >= N && !!during?.last_error,
    });
    execFileSync("docker", ["start", SIEM_CONTAINER], { stdio: "ignore" });
    const t2 = await waitUntil(caughtUp, 180);
    await sleep(5000);
    siem = await siemEvents();
    v = verify(siem);
    const after = await maxSeq();
    rows.push({
      prueba: "al volver el SIEM llegan todos, en orden",
      esperado: `${after} eventos · cadena íntegra`,
      obtenido: `${siem.length} eventos · ${v.detail} · al día en ${t2 ?? "—"} s`,
      cumple: siem.length === after && v.ok && t2 !== undefined,
    });

    // 3) Reenvío de los últimos 10: el SIEM no duplica.
    await db.query("UPDATE nexo.siem_cursor SET last_seq = greatest(last_seq - 10, 0)");
    await waitUntil(caughtUp, 60);
    await sleep(5000);
    const again = await siemEvents();
    rows.push({ prueba: "un reenvío no duplica eventos", esperado: `${after} eventos`, obtenido: `${again.length} eventos`, cumple: again.length === after && verify(again).ok });
  } finally {
    try {
      execFileSync("docker", ["start", SIEM_CONTAINER], { stdio: "ignore" });
    } catch {
      /* ya estaba arriba */
    }
    await db.end();
  }
  console.table(rows);
  const ok = rows.every((r) => r.cumple);
  console.log(ok ? "[SIEM] verificado: auditoría entregada sin pérdida, en orden y verificable en el SIEM" : "[SIEM] NO cumple");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[SIEM] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
