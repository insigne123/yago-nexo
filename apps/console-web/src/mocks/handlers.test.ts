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
  candidateEndpoint: "https://concesiones-v14.interno.cliente.invalid",
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
      const audit = await call(
        "GET",
        "/audit-events?action=acceso.rechazado.permiso&limit=1000",
        "pedro.auditoria",
      );
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
    expect(self.body.permission).toBe("cuatro-ojos");
    const fourEyes = (
      await call("GET", "/audit-events?action=acceso.rechazado.cuatro_ojos", "pedro.auditoria")
    ).body as unknown as Array<{ actor: string; resource: string; result: string }>;
    expect(fourEyes[0]).toMatchObject({
      actor: "marta.dosroles",
      resource: `/rollouts/${id}/approve`,
      result: "rechazado",
    });

    const other = await call("POST", `/rollouts/${id}/approve`, "luis.aprobador");
    expect(other.status).toBe(200);
    expect(other.body.status).toBe("en_curso");
    expect(other.body.approvedBy).toBe("luis.aprobador");
    expect(other.body.currentWeight).toBe(5);
  });

  it("el retorno lo solicita una persona y lo aprueba otra, como la API", async () => {
    // Caída simulada del sitio principal: los agentes conmutan al respaldo (herramienta del modo simulado).
    expect((await call("POST", "/__mock/continuity/outage", "carla.operacion")).status).toBe(202);
    now += 15_000;
    // Sin motivo no hay solicitud; el auditor no tiene el permiso de solicitar.
    expect((await call("POST", "/continuity/failback/requests", "carla.operacion", {})).status).toBe(400);
    expect(
      (await call("POST", "/continuity/failback/requests", "pedro.auditoria", { reason: "Primario sano" }))
        .status,
    ).toBe(403);
    const req = await call("POST", "/continuity/failback/requests", "carla.operacion", {
      reason: "Primario restablecido y base al día",
    });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe("pendiente");
    expect(req.body.requestedBy).toBe("carla.operacion");
    const id = String(req.body.id);
    // Solo una pendiente a la vez.
    const dup = await call("POST", "/continuity/failback/requests", "luis.aprobador", {
      reason: "Otra solicitud",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("pendiente_existente");
    expect(dup.body.requestId).toBe(id);
    // GET /continuity informa la pendiente.
    const state = await call("GET", "/continuity", "carla.operacion");
    expect((state.body.pendingFailback as { id: string }).id).toBe(id);
    // La operadora no puede aprobar (permiso).
    expect(
      (await call("POST", `/continuity/failback/requests/${id}/approve`, "carla.operacion", {})).status,
    ).toBe(403);
    const ok = await call("POST", `/continuity/failback/requests/${id}/approve`, "luis.aprobador", {
      reason: "Conforme",
    });
    expect(ok.status).toBe(202);
    const approval = ok.body as unknown as {
      request: { status: string; decidedBy: string; failoverEventId: string };
      event: { id: string; kind: string; requestedBy: string; approvedBy: string };
    };
    expect(approval.request.status).toBe("aprobada");
    expect(approval.request.decidedBy).toBe("luis.aprobador");
    expect(approval.event.kind).toBe("retorno");
    expect(approval.event.requestedBy).toBe("carla.operacion");
    expect(approval.event.approvedBy).toBe("luis.aprobador");
    expect(approval.request.failoverEventId).toBe(approval.event.id);
    const again = await call("POST", `/continuity/failback/requests/${id}/approve`, "luis.aprobador", {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("no_pendiente");

    // El retorno reapunta el tráfico; la re-sincronización de la réplica queda pendiente para el operador.
    now += 5_000;
    const events = (await call("GET", "/continuity/events", "carla.operacion")).body as unknown as Array<{
      id: string;
      status: string;
      rtoSeconds?: number;
      steps: Array<{ name: string; status: string }>;
    }>;
    const back = events.find((e) => e.id === approval.event.id);
    expect(back?.status).toBe("completado");
    expect(back?.rtoSeconds).toBeUndefined();
    expect(back?.steps.at(-1)).toMatchObject({ name: "Re-sincronizar la réplica", status: "pendiente" });
    expect((await call("GET", "/continuity", "carla.operacion")).body.activeSite).toBe("cpd");

    const audit = (await call("GET", "/audit-events?action=continuidad.retorno", "pedro.auditoria"))
      .body as unknown as Array<{ action: string; actor: string; result: string }>;
    expect(audit.map((e) => `${e.action}:${e.actor}`)).toEqual(
      expect.arrayContaining([
        "continuidad.retorno.solicitar:carla.operacion",
        "continuidad.retorno.aprobar:luis.aprobador",
        // El segundo intento de aprobar una solicitud ya aprobada (409) queda como «rechazado».
        "continuidad.retorno.aprobar:luis.aprobador",
      ]),
    );
    // Rechazados como en la API: la solicitud sin motivo (400), el duplicado y la segunda aprobación (409).
    expect(audit.filter((e) => e.result === "rechazado").map((e) => `${e.action}:${e.actor}`)).toEqual(
      expect.arrayContaining([
        "continuidad.retorno.solicitar:carla.operacion",
        "continuidad.retorno.solicitar:luis.aprobador",
        "continuidad.retorno.aprobar:luis.aprobador",
      ]),
    );
    // La operadora sin el permiso de aprobar: rechazo por permiso, como en la API.
    const denied = (await call("GET", "/audit-events?action=acceso.rechazado.permiso", "pedro.auditoria"))
      .body as unknown as Array<{ actor: string; resource: string }>;
    expect(denied.some((e) => e.actor === "carla.operacion" && e.resource.endsWith(`/${id}/approve`))).toBe(
      true,
    );
  });

  it("quien solicita el retorno no puede aprobarlo (cuatro ojos) y la solicitud vence", async () => {
    await call("POST", "/__mock/continuity/outage", "carla.operacion");
    now += 15_000;
    const req = await call("POST", "/continuity/failback/requests", "luis.aprobador", {
      reason: "Primario restablecido",
    });
    const id = String(req.body.id);
    const self = await call("POST", `/continuity/failback/requests/${id}/approve`, "luis.aprobador", {});
    expect(self.status).toBe(403);
    expect(self.body.permission).toBe("cuatro-ojos");
    expect(String(self.body.message)).toMatch(/cuatro ojos/i);
    // Vence a los 30 minutos.
    now += 31 * 60_000;
    const late = await call("POST", `/continuity/failback/requests/${id}/approve`, "ana.desarrollo", {});
    expect(late.status).toBe(403); // la desarrolladora no tiene el permiso
    const expired = await call("POST", `/continuity/failback/requests/${id}/reject`, "luis.aprobador", {
      reason: "Ya no aplica",
    });
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe("vencida");
    const list = (await call("GET", "/continuity/failback/requests", "carla.operacion"))
      .body as unknown as Array<{
      id: string;
      status: string;
    }>;
    expect(list.find((r) => r.id === id)?.status).toBe("vencida");
    expect((await call("GET", "/continuity", "carla.operacion")).body.pendingFailback).toBeUndefined();
  });

  it("una solicitud pendiente se puede rechazar con motivo", async () => {
    await call("POST", "/__mock/continuity/outage", "carla.operacion");
    now += 15_000;
    const req = await call("POST", "/continuity/failback/requests", "carla.operacion", {
      reason: "Primario sano",
    });
    const id = String(req.body.id);
    expect(
      (await call("POST", `/continuity/failback/requests/${id}/reject`, "luis.aprobador", {})).status,
    ).toBe(400);
    const rejected = await call("POST", `/continuity/failback/requests/${id}/reject`, "luis.aprobador", {
      reason: "La base del CPD no está al día",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rechazada");
    expect(rejected.body.decisionReason).toBe("La base del CPD no está al día");
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
      candidateEndpoint: "https://concesiones-v14-mala.interno.cliente.invalid",
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

  it("el simulacro, como el del agente, mide la réplica sin conmutar ni registrar RTO", async () => {
    const started = await call("POST", "/continuity/drill", "carla.operacion");
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("en_curso");
    expect((started.body.steps as unknown[]).length).toBe(1);
    now += 5_000;
    const events = (await call("GET", "/continuity/events", "carla.operacion")).body as unknown as Array<{
      id: string;
      status: string;
      rtoSeconds?: number;
      steps: Array<{ name: string }>;
    }>;
    const drill = events.find((e) => e.id === started.body.id);
    expect(drill?.status).toBe("completado");
    expect(drill?.rtoSeconds).toBeUndefined();
    expect(drill?.steps.map((st) => st.name)).toEqual([
      "Verificar réplica al día",
      "Estimar tiempo de preparación",
    ]);
    expect((await call("GET", "/continuity", "carla.operacion")).body.activeSite).toBe("cpd");
  });

  it("la caída simulada del primario conmuta con los pasos del agente y registra el RTO", async () => {
    const started = await call("POST", "/__mock/continuity/outage", "carla.operacion");
    expect(started.status).toBe(202);
    expect(started.body.kind).toBe("conmutacion");
    expect(started.body.trigger).toBe("automatico");
    now += 2_000;
    const mid = (await call("GET", "/continuity", "carla.operacion")).body as {
      activeSite: string;
      sites: Array<{ id: string; vote: string }>;
    };
    expect(mid.activeSite).toBe("cpd");
    expect(mid.sites.filter((x) => x.vote === "primario_caido").length).toBe(2);
    now += 5_000;
    const events = (await call("GET", "/continuity/events", "carla.operacion")).body as unknown as Array<{
      id: string;
      status: string;
      rtoSeconds?: number;
      requestedBy?: string;
    }>;
    const failover = events.find((e) => e.id === started.body.id);
    expect(failover?.status).toBe("completado");
    expect(failover?.rtoSeconds).toBe(5);
    expect(failover?.requestedBy).toBe("nexo-continuidad@gcp");
    expect((await call("GET", "/continuity", "carla.operacion")).body.activeSite).toBe("gcp");
    // Ya en el respaldo: no hay otra caída que simular ni simulacro posible hasta el retorno.
    expect((await call("POST", "/__mock/continuity/outage", "carla.operacion")).status).toBe(409);
    expect((await call("POST", "/continuity/drill", "carla.operacion")).status).toBe(409);
  });

  it("en modo manual los agentes no conmutan solos", async () => {
    expect((await call("PUT", "/continuity/mode", "admin.nexo", { mode: "manual" })).status).toBe(200);
    const res = await call("POST", "/__mock/continuity/outage", "carla.operacion");
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/modo manual/);
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

describe("API simulada: exportación con el mismo contenido que la API", () => {
  it("el manifiesto lista las APIs de WSO2, los flujos, el catálogo y el grafo, con la versión publicada", async () => {
    const created = await call("POST", "/exports", "admin.nexo");
    expect(created.status).toBe(202);
    now += 10_000;
    const job = await call("GET", `/exports/${String(created.body.id)}`, "admin.nexo");
    expect(job.body.status).toBe("listo");
    const manifest = job.body.manifest as {
      version: string;
      items: Array<{ tipo: string; archivo: string; sha256: string }>;
    };
    expect(manifest.version).toBe(__APP_VERSION__);
    expect(new Set(manifest.items.map((i) => i.tipo))).toEqual(
      new Set(["api", "flujo", "metadatos", "plataforma"]),
    );
    expect(manifest.items.map((i) => i.archivo)).toEqual(
      expect.arrayContaining([
        "metadatos/catalogo.json",
        "metadatos/grafo.json",
        "plataforma/platform.yaml",
        "plataforma/workflows/workflow-extensions.xml",
        "plataforma/governance/guia-estilo-institucional.yaml",
      ]),
    );
    expect(
      manifest.items.filter((i) => i.tipo === "api").every((i) => /^apis\/.+\.zip$/.test(i.archivo)),
    ).toBe(true);
    expect(manifest.items.every((i) => /^[0-9a-f]{64}$/.test(i.sha256))).toBe(true);
  });
});
