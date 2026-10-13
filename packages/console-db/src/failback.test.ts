/**
 * Retorno con dos personas. Las pruebas de lógica corren siempre; las de base de datos corren contra un
 * PostgreSQL desechable cuando se define NEXO_TEST_DATABASE_URL (la prueba borra y recrea el esquema «nexo»):
 *
 *   docker run -d --rm --name nexo-pg-prueba -e POSTGRES_PASSWORD=prueba -p 55432:5432 postgres:16-alpine
 *   NEXO_TEST_DATABASE_URL=postgres://postgres:prueba@localhost:55432/postgres pnpm --filter @nexo/console-db test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditStore } from "./audit-store.js";
import { createPool, migrate, type Db } from "./db.js";
import {
  approveFailback,
  effectiveStatus,
  expireFailbackRequests,
  FailbackError,
  failbackRow,
  getFailbackRequest,
  listFailbackRequests,
  rejectFailback,
  requestFailback,
  samePerson,
} from "./failback.js";

describe("identidades del retorno", () => {
  it("es la misma persona si coincide el usuario o el sujeto del token", () => {
    expect(
      samePerson({ username: "carla.operacion", sub: "a" }, { username: "carla.operacion", sub: "b" }),
    ).toBe(true);
    expect(
      samePerson({ username: "otro-nombre", sub: "s-1" }, { username: "carla.operacion", sub: "s-1" }),
    ).toBe(true);
    expect(
      samePerson({ username: "luis.aprobador", sub: "s-2" }, { username: "carla.operacion", sub: "s-1" }),
    ).toBe(false);
    expect(samePerson({ username: "luis.aprobador" }, { username: "carla.operacion", sub: null })).toBe(
      false,
    );
  });

  it("una solicitud pendiente con el plazo cumplido está vencida", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(effectiveStatus("pendiente", "2026-10-08T11:59:59Z", now)).toBe("vencida");
    expect(effectiveStatus("pendiente", "2026-10-08T12:00:01Z", now)).toBe("pendiente");
    expect(effectiveStatus("aprobada", "2026-10-08T11:00:00Z", now)).toBe("aprobada");
  });

  it("entrega la fila con los nombres del contrato", () => {
    const row = failbackRow(
      {
        id: "7f0c1c1e-0000-4000-8000-000000000001",
        from_site: "gcp",
        to_site: "cpd",
        reason: "CPD restablecido",
        status: "aprobada",
        requested_by: "carla.operacion",
        requested_at: "2026-10-08T11:00:00.000Z",
        expires_at: "2026-10-08T11:30:00.000Z",
        decided_by: "luis.aprobador",
        decided_at: "2026-10-08T11:05:00.000Z",
        decision_reason: null,
        failover_event_id: "7f0c1c1e-0000-4000-8000-000000000002",
      },
      new Date("2026-10-08T12:00:00Z"),
    );
    expect(row).toEqual({
      id: "7f0c1c1e-0000-4000-8000-000000000001",
      fromSite: "gcp",
      toSite: "cpd",
      reason: "CPD restablecido",
      status: "aprobada",
      requestedBy: "carla.operacion",
      requestedAt: "2026-10-08T11:00:00.000Z",
      expiresAt: "2026-10-08T11:30:00.000Z",
      decidedBy: "luis.aprobador",
      decidedAt: "2026-10-08T11:05:00.000Z",
      failoverEventId: "7f0c1c1e-0000-4000-8000-000000000002",
    });
  });
});

const DB_URL = process.env.NEXO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("retorno con dos personas en PostgreSQL", () => {
  let db: Db;
  const carla = { username: "carla.operacion", sub: "sub-carla" };
  const luis = { username: "luis.aprobador", sub: "sub-luis" };

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof FailbackError ? e.code : String(e);
    }
  };

  beforeAll(async () => {
    db = createPool(DB_URL);
    await db.query("DROP SCHEMA IF EXISTS nexo CASCADE");
    const applied = await migrate(db, () => undefined);
    expect(applied).toContain("0005_retorno_dos_personas.sql");
    expect(await migrate(db, () => undefined)).toEqual([]);
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM nexo.failback_request");
    await db.query("DELETE FROM nexo.failover_event");
    await db.query("UPDATE nexo.continuity_settings SET active_site = 'gcp' WHERE id = 1");
  });

  it("con el CPD activo no hay retorno que pedir", async () => {
    await db.query("UPDATE nexo.continuity_settings SET active_site = 'cpd' WHERE id = 1");
    expect(await code(requestFailback(db, { actor: carla, reason: "prueba", ttlMinutes: 30 }))).toBe(
      "sitio_activo",
    );
  });

  it("una persona lo pide, la misma no lo aprueba y otra sí; el evento registra a las dos", async () => {
    const { request } = await requestFailback(db, {
      actor: carla,
      reason: "CPD restablecido",
      ttlMinutes: 30,
    });
    expect(request).toMatchObject({
      status: "pendiente",
      requestedBy: "carla.operacion",
      fromSite: "gcp",
      toSite: "cpd",
    });
    expect(new Date(request.expiresAt).getTime() - new Date(request.requestedAt).getTime()).toBe(30 * 60_000);

    expect(await code(requestFailback(db, { actor: luis, reason: "otra", ttlMinutes: 30 }))).toBe(
      "pendiente_existente",
    );
    expect(await code(approveFailback(db, { id: request.id, actor: carla }))).toBe("misma_persona");
    // El mismo sujeto con otro nombre de usuario también es la misma persona.
    expect(
      await code(approveFailback(db, { id: request.id, actor: { username: "alias", sub: "sub-carla" } })),
    ).toBe("misma_persona");

    const ok = await approveFailback(db, { id: request.id, actor: luis, reason: "conforme" });
    expect(ok.request).toMatchObject({
      status: "aprobada",
      decidedBy: "luis.aprobador",
      decisionReason: "conforme",
    });
    expect(ok.failoverEvent).toMatchObject({
      kind: "retorno",
      trigger: "manual",
      from_site: "gcp",
      to_site: "cpd",
      requested_by: "carla.operacion",
      approved_by: "luis.aprobador",
      status: "en_curso",
    });
    expect(ok.request.failoverEventId).toBe(ok.failoverEvent.id);

    expect(await code(approveFailback(db, { id: request.id, actor: luis }))).toBe("no_pendiente");
    // Con el retorno en curso no se puede pedir otro.
    expect(await code(requestFailback(db, { actor: carla, reason: "otra vez", ttlMinutes: 30 }))).toBe(
      "conmutacion_en_curso",
    );
  });

  it("la solicitud vence: no se puede aprobar y queda marcada", async () => {
    const { request } = await requestFailback(db, {
      actor: carla,
      reason: "CPD restablecido",
      ttlMinutes: 1,
    });
    await db.query(
      "UPDATE nexo.failback_request SET requested_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [request.id],
    );
    expect((await getFailbackRequest(db, request.id))?.status).toBe("vencida");
    expect(await code(approveFailback(db, { id: request.id, actor: luis }))).toBe("vencida");
    const row = (await db.query("SELECT status FROM nexo.failback_request WHERE id = $1", [request.id]))
      .rows[0];
    expect(row.status).toBe("vencida");
    expect((await db.query("SELECT count(*)::int AS n FROM nexo.failover_event")).rows[0].n).toBe(0);
  });

  it("el barrido marca cada solicitud vencida una sola vez y deja las vigentes", async () => {
    const { request } = await requestFailback(db, { actor: carla, reason: "barrido", ttlMinutes: 30 });
    expect(await expireFailbackRequests(db)).toEqual([]);
    await db.query(
      "UPDATE nexo.failback_request SET requested_at = now() - interval '40 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [request.id],
    );
    const [a, b] = await Promise.all([expireFailbackRequests(db), expireFailbackRequests(db)]);
    expect([...a!, ...b!].map((r) => [r.id, r.status])).toEqual([[request.id, "vencida"]]);
    expect(await expireFailbackRequests(db)).toEqual([]);
    // Ya marcada, aprobarla informa «vencida» sin volver a devolverla para auditar.
    const late = await approveFailback(db, { id: request.id, actor: luis }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(FailbackError);
    expect((late as FailbackError).code).toBe("vencida");
    expect((late as FailbackError).expired).toBeUndefined();
  });

  it("una solicitud vencida no impide pedir otra y se informa para auditarla", async () => {
    const first = await requestFailback(db, { actor: carla, reason: "primera", ttlMinutes: 1 });
    await db.query(
      "UPDATE nexo.failback_request SET requested_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [first.request.id],
    );
    const second = await requestFailback(db, { actor: luis, reason: "segunda", ttlMinutes: 30 });
    expect(second.expired.map((r) => r.id)).toEqual([first.request.id]);
    expect(second.request.status).toBe("pendiente");
    const list = await listFailbackRequests(db);
    expect(list.map((r) => r.status)).toEqual(["pendiente", "vencida"]);
  });

  it("se puede rechazar o retirar con motivo; luego se puede pedir de nuevo", async () => {
    const { request } = await requestFailback(db, { actor: luis, reason: "primera", ttlMinutes: 30 });
    const rejected = await rejectFailback(db, { id: request.id, actor: luis, reason: "retiro mi solicitud" });
    expect(rejected).toMatchObject({
      status: "rechazada",
      decidedBy: "luis.aprobador",
      decisionReason: "retiro mi solicitud",
    });
    expect(await code(rejectFailback(db, { id: request.id, actor: luis, reason: "de nuevo" }))).toBe(
      "no_pendiente",
    );
    expect(await code(requestFailback(db, { actor: carla, reason: "segunda", ttlMinutes: 30 }))).toBe("ok");
  });

  it("un id desconocido o mal formado no existe", async () => {
    expect(await code(approveFailback(db, { id: "no-es-uuid", actor: luis }))).toBe("no_existe");
    expect(await code(approveFailback(db, { id: "7f0c1c1e-0000-4000-8000-000000000009", actor: luis }))).toBe(
      "no_existe",
    );
    expect(await getFailbackRequest(db, "no-es-uuid")).toBeUndefined();
  });

  it("la cadena de auditoría admite los eventos de rechazo y de error", async () => {
    const store = new AuditStore(db);
    await store.append({
      source: "consola",
      actor: "anonimo",
      actorType: "usuario",
      action: "acceso.rechazado.autenticacion",
      resource: "ip/10.0.0.9",
      result: "rechazado",
      sourceIp: "10.0.0.9",
      details: { intentos: 3 },
    });
    await store.append({
      source: "consola",
      actor: "luis.aprobador",
      actorType: "usuario",
      action: "mensajes.reprocesar",
      resource: "mensaje/x",
      result: "error",
      details: { estado: 502 },
    });
    expect(await store.verify()).toMatchObject({ ok: true });
  });
});
