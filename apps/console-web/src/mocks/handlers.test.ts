// @vitest-environment node
/// <reference types="node" />
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findMockUser, mockAccessToken } from "../auth/mockUsers";
import { createHandlers } from "./handlers";
import { MockStore } from "./store";

const BASE = "http://consola.test/api/v1";
let now = Date.parse("2026-10-04T12:00:00.000Z");
const store = new MockStore({ now: () => now, baseUrl: BASE });
const server = setupServer(...createHandlers(store, { baseUrl: BASE, latency: 0 }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  now = Date.parse("2026-10-04T12:00:00.000Z");
  store.reset();
});

interface Result {
  status: number;
  // Las respuestas se inspeccionan con propiedades distintas según la ruta.
  body: Record<string, unknown> & { [key: string]: unknown };
}

async function call(method: string, path: string, username?: string, payload?: unknown): Promise<Result> {
  const headers: Record<string, string> = {};
  if (username) {
    const user = findMockUser(username);
    if (!user) throw new Error(`usuario ${username}`);
    headers.Authorization = `Bearer ${mockAccessToken(user, Math.floor(now / 1000))}`;
  }
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body: Result["body"];
  try {
    body = text ? (JSON.parse(text) as Result["body"]) : {};
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}

const ROLLOUT = {
  apiId: "api-concesiones",
  strategy: "canary",
  candidateEndpoint: "https://concesiones-v14.interno.subtel.invalid",
  steps: [5, 25, 50, 100],
  stepDurationSec: 60,
  thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 20 },
  environment: "prod",
};

describe("API simulada: identidad y permisos", () => {
  it("exige un token", async () => {
    const res = await call("GET", "/me");
    expect(res.status).toBe(401);
  });

  it("GET /me devuelve los permisos de la matriz", async () => {
    const res = await call("GET", "/me", "luis.aprobador");
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["aprobador"]);
    expect(res.body.permissions).toContain("rollout:approve");
    expect(res.body.permissions).not.toContain("rollout:create");
  });

  it("responde 403 con el permiso faltante y audita el rechazo", async () => {
    const rejected = async () => {
      const audit = await call("GET", "/audit-events?action=rollout.approve&limit=1000", "pedro.auditoria");
      const events = audit.body as unknown as Array<{ actor: string; result: string; resource: string }>;
      return events.filter((e) => e.actor === "ana.desarrollo" && e.result === "rechazado");
    };
    const before = (await rejected()).length;
    const res = await call("POST", "/rollouts/rol-0004/approve", "ana.desarrollo");
    expect(res.status).toBe(403);
    expect(res.body.permission).toBe("rollout:approve");
    const after = await rejected();
    expect(after.length).toBe(before + 1);
    expect(after[0]?.resource).toBe("/rollouts/rol-0004/approve");
  });
});

describe("API simulada: regla de cuatro ojos", () => {
  it("quien crea un despliegue no puede aprobarlo; otra persona sí", async () => {
    const created = await call("POST", "/rollouts", "marta.dosroles", ROLLOUT);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pendiente_aprobacion");
    expect(created.body.createdBy).toBe("marta.dosroles");
    const id = String(created.body.id);

    const self = await call("POST", `/rollouts/${id}/approve`, "marta.dosroles");
    expect(self.status).toBe(403);
    expect(String(self.body.message)).toMatch(/cuatro ojos/i);
    expect(self.body.permission).toBeUndefined();

    const other = await call("POST", `/rollouts/${id}/approve`, "luis.aprobador");
    expect(other.status).toBe(200);
    expect(other.body.status).toBe("en_curso");
    expect(other.body.approvedBy).toBe("luis.aprobador");
    expect(other.body.currentWeight).toBe(5);
  });

  it("el retorno lo aprueba una persona distinta de quien inició el simulacro", async () => {
    const drill = await call("POST", "/continuity/drill", "carla.operacion");
    expect(drill.status).toBe(202);
    now += 15_000;
    // El operador no tiene el permiso de aprobar el retorno.
    expect((await call("POST", "/continuity/failback", "carla.operacion", { reason: "Prueba" })).status).toBe(
      403,
    );
    const ok = await call("POST", "/continuity/failback", "luis.aprobador", {
      reason: "Simulacro terminado",
    });
    expect(ok.status).toBe(202);
    expect(ok.body.kind).toBe("retorno");
    expect(ok.body.approvedBy).toBe("luis.aprobador");
  });
});

describe("API simulada: el estado cambia con las acciones y el tiempo", () => {
  it("un despliegue en curso sube su peso con el tiempo", async () => {
    const created = await call("POST", "/rollouts", "ana.desarrollo", ROLLOUT);
    const id = String(created.body.id);
    await call("POST", `/rollouts/${id}/approve`, "luis.aprobador");
    now += 6_500;
    const res = await call("GET", `/rollouts/${id}`, "carla.operacion");
    expect(res.body.status).toBe("en_curso");
    expect(res.body.currentWeight).toBe(25);
    const steps = res.body.stepsDone as Array<{ decision: string }>;
    expect(steps[0]?.decision).toBe("avanzar");
    now += 30_000;
    const done = await call("GET", `/rollouts/${id}`, "carla.operacion");
    expect(done.body.status).toBe("completado");
    expect(done.body.currentWeight).toBe(100);
  });

  it("una versión defectuosa se revierte sola en el primer paso", async () => {
    const created = await call("POST", "/rollouts", "ana.desarrollo", {
      ...ROLLOUT,
      candidateEndpoint: "https://concesiones-v14-mala.interno.subtel.invalid",
    });
    await call("POST", `/rollouts/${String(created.body.id)}/approve`, "luis.aprobador");
    now += 6_500;
    const res = await call("GET", `/rollouts/${String(created.body.id)}`, "carla.operacion");
    expect(res.body.status).toBe("revertido");
    expect(res.body.currentWeight).toBe(0);
    expect(String(res.body.rollbackReason)).toMatch(/Reversa automática/);
  });

  it("abortar un despliegue en curso lo deja revertido", async () => {
    const res = await call("POST", "/rollouts/rol-0001/abort", "carla.operacion", {
      reason: "Prueba de detención",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revertido");
    expect(String(res.body.rollbackReason)).toContain("carla.operacion");
  });

  it("aprobar un bloqueo propuesto lo activa en el gateway", async () => {
    const res = await call("POST", "/anomalies/anm-001/approve-block", "luis.aprobador");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("bloqueada");
    expect(res.body.approvedBy).toBe("luis.aprobador");
    const blocks = (await call("GET", "/blocks", "luis.aprobador")).body as unknown as Array<{
      id: string;
      active: boolean;
    }>;
    expect(blocks.find((b) => b.id === res.body.blockId)?.active).toBe(true);
    expect((await call("POST", "/anomalies/anm-001/approve-block", "luis.aprobador")).status).toBe(409);
  });

  it("el simulacro agrega pasos de a poco y cambia el sitio activo", async () => {
    const started = await call("POST", "/continuity/drill", "carla.operacion");
    expect(started.body.status).toBe("en_curso");
    expect((started.body.steps as unknown[]).length).toBe(1);
    now += 5_200;
    const partial = (await call("GET", "/continuity/events", "carla.operacion")).body as unknown as Array<{
      id: string;
      steps: unknown[];
    }>;
    expect(partial.find((e) => e.id === started.body.id)?.steps.length).toBe(4);
    now += 9_000;
    const events = (await call("GET", "/continuity/events", "carla.operacion")).body as unknown as Array<{
      id: string;
      status: string;
      rtoSeconds: number;
    }>;
    const drill = events.find((e) => e.id === started.body.id);
    expect(drill?.status).toBe("completado");
    expect(drill?.rtoSeconds).toBe(12);
    const state = await call("GET", "/continuity", "carla.operacion");
    expect(state.body.activeSite).toBe("gcp");
  });

  it("la verificación detecta un evento de auditoría alterado", async () => {
    const ok = await call("GET", "/audit-events/verify", "pedro.auditoria");
    expect(ok.body.ok).toBe(true);
    const tampered = await call("POST", "/__mock/audit/tamper", "pedro.auditoria");
    const broken = await call("GET", "/audit-events/verify", "pedro.auditoria");
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAt).toBe(tampered.body.seq);
    expect(broken.body.reason).toBe("hash");
    await call("POST", "/__mock/audit/restore", "pedro.auditoria");
    expect((await call("GET", "/audit-events/verify", "pedro.auditoria")).body.ok).toBe(true);
  });

  it("el consumidor solo ve el consumo de su organización", async () => {
    const res = await call("GET", "/usage?groupBy=consumer", "consumidor.demo");
    const rows = res.body as unknown as Array<{ label: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.label).toBe("Telecom Andina");
    const all = (await call("GET", "/usage?groupBy=consumer", "carla.operacion"))
      .body as unknown as unknown[];
    expect(all.length).toBeGreaterThan(5);
  });

  it("descarga el reporte de exposición en CSV", async () => {
    const res = await call("GET", "/discovery/report?format=csv", "carla.operacion");
    expect(res.status).toBe(200);
    expect(String(res.body.text)).toMatch(/^id,fuente,host,puerto,ruta/);
  });
});
