// @vitest-environment node
/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { layeredLayout } from "../features/graph/layout";
import { sha256Hex } from "../lib/sha256";
import { appendAudit, canonicalize, verifyAudit } from "./audit";
import { impactOf } from "@nexo/console-api/impacto";
import { simulateImpact } from "./impact";
import { createSeed } from "./seed";

describe("SHA-256 del simulador", () => {
  it("coincide con node:crypto", () => {
    for (const text of ["", "abc", "Concesiones · Región de Ñuble", "x".repeat(1000)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  it("encadena como @nexo/shared: SHA-256(hashPrevio + evento canónico)", () => {
    const chain: Parameters<typeof appendAudit>[0] = [];
    const first = appendAudit(chain, {
      actor: "ana",
      actorType: "usuario",
      action: "catalog.update",
      result: "exito",
      ts: "2026-10-04T12:00:00.000Z",
    });
    const { hash, ...rest } = first;
    expect(hash).toBe(
      createHash("sha256")
        .update(first.prevHash ?? "")
        .update(canonicalize(rest))
        .digest("hex"),
    );
    appendAudit(chain, {
      actor: "luis",
      actorType: "usuario",
      action: "rollout.approve",
      result: "exito",
      ts: "2026-10-04T12:01:00.000Z",
    });
    expect(verifyAudit(chain)).toEqual({ ok: true, count: 2, lastSeq: 2 });
    chain.splice(0, 1);
    expect(verifyAudit(chain)).toMatchObject({ ok: false, brokenAt: 2, reason: "encadenamiento" });
  });
});

describe("motor de impacto y disposición del grafo", () => {
  const seed = createSeed(Date.parse("2026-10-04T12:00:00Z"));
  const { nodes, edges } = seed.graph;

  it("un cambio en un sistema de destino llega a los flujos, las APIs y sus consumidores", () => {
    const result = simulateImpact(nodes, edges, "sis-cloudsql", "fuente");
    const ids = (list?: Array<{ id: string }>) => (list ?? []).map((n) => n.id);
    expect(ids(result.affected?.flujos)).toEqual(
      expect.arrayContaining(["flujo-reclamos", "flujo-tramites"]),
    );
    expect(ids(result.affected?.apis)).toEqual(expect.arrayContaining(["api-reclamos", "api-tramites"]));
    expect(ids(result.affected?.consumidores)).toContain("cons-mesa-ayuda");
    expect(result.severity).toBe("alto");
    expect(result.paths?.every((p) => p[0] === "sis-cloudsql")).toBe(true);
  });

  it("la demostración solo usa los orígenes de arista que genera la API (configuración y analizador del integrador)", () => {
    expect(new Set(edges.map((e) => e.source))).toEqual(new Set(["configuracion", "analizador_mi"]));
    expect(nodes.filter((n) => n.type === "dato" || n.type === "reporte")).toEqual([]);
    expect(JSON.stringify(nodes)).not.toMatch(/OpenMetadata|Looker/);
  });

  it("un cambio de contrato de una API solo afecta a sus consumidores", () => {
    const result = simulateImpact(nodes, edges, "api-espectro", "contrato");
    expect(result.affected?.consumidores?.map((n) => n.id)).toEqual(["cons-portal-tramites"]);
    expect(result.affected?.flujos).toEqual([]);
    expect(result.severity).toBe("medio");
  });

  it("la demo da el mismo resultado que el motor de impacto de la API en cada nodo y tipo de cambio", () => {
    for (const node of nodes) {
      for (const kind of ["contrato", "campo", "fuente", "retiro"] as const) {
        const product = impactOf(
          nodes.map((n) => ({ ...n, label: n.label ?? n.id })) as Parameters<typeof impactOf>[0],
          edges.map((e) => ({ ...e, source: e.source ?? "manual" })),
          node.id,
          kind,
        );
        expect(simulateImpact(nodes, edges, node.id, kind)).toEqual({ nodeId: node.id, ...product });
      }
    }
  });

  it("ubica los nodos en capas por tipo, de consumidores a sistemas", () => {
    const positions = layeredLayout(nodes, edges);
    const x = (id: string) => positions.get(id)?.x ?? -1;
    expect(positions.size).toBe(nodes.length);
    expect(x("cons-telecom-andina")).toBeLessThan(x("api-concesiones"));
    expect(x("api-concesiones")).toBeLessThan(x("flujo-concesiones"));
    expect(x("flujo-concesiones")).toBeLessThan(x("sis-oracle"));
  });
});
