// @vitest-environment node
/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { layeredLayout } from "../features/graph/layout";
import { sha256Hex } from "../lib/sha256";
import { appendAudit, canonicalize, verifyAudit } from "./audit";
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

  it("un cambio de campo en un dato llega a los consumidores y reportes", () => {
    const result = simulateImpact(nodes, edges, "dato-reclamo", "campo");
    const ids = (list?: Array<{ id: string }>) => (list ?? []).map((n) => n.id);
    expect(ids(result.affected?.sistemas)).toContain("sis-cloudsql");
    expect(ids(result.affected?.apis)).toEqual(expect.arrayContaining(["api-reclamos", "api-tramites"]));
    expect(ids(result.affected?.reportes)).toContain("rep-reclamos");
    expect(ids(result.affected?.consumidores)).toContain("cons-mesa-ayuda");
    expect(result.severity).toBe("alto");
    expect(result.paths?.every((p) => p[0] === "dato-reclamo")).toBe(true);
  });

  it("un cambio de contrato de una API solo afecta a sus consumidores", () => {
    const result = simulateImpact(nodes, edges, "api-espectro", "contrato");
    expect(result.affected?.consumidores?.map((n) => n.id)).toEqual(["cons-portal-tramites"]);
    expect(result.affected?.flujos).toEqual([]);
    expect(result.severity).toBe("medio");
  });

  it("ubica los nodos en capas por tipo, de consumidores a reportes", () => {
    const positions = layeredLayout(nodes, edges);
    const x = (id: string) => positions.get(id)?.x ?? -1;
    expect(positions.size).toBe(nodes.length);
    expect(x("cons-telecom-andina")).toBeLessThan(x("api-concesiones"));
    expect(x("api-concesiones")).toBeLessThan(x("flujo-concesiones"));
    expect(x("flujo-concesiones")).toBeLessThan(x("sis-oracle"));
    expect(x("sis-oracle")).toBeLessThan(x("dato-concesion"));
    expect(x("dato-concesion")).toBeLessThan(x("rep-mercado"));
  });
});
