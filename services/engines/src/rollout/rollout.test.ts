import { describe, expect, it } from "vitest";
import { decide } from "./gates.js";

describe("compuertas de cada paso", () => {
  const t = { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 20 };
  const ok = { requests: 100, errors: 0, p99Ms: 120 };

  it("revierte apenas el candidato falla con tráfico suficiente, sin esperar la duración", () => {
    const d = decide({ candidate: { requests: 25, errors: 5, p99Ms: 100 }, stable: ok }, t, 5, 60);
    expect(d.action).toBe("revertir");
    expect(d.reason).toMatch(/tasa de error/);
  });

  it("revierte por latencia p99", () => {
    expect(decide({ candidate: { requests: 30, errors: 0, p99Ms: 1500 }, stable: ok }, t, 70, 60).action).toBe("revertir");
  });

  it("no culpa al candidato si la versión estable falla igual", () => {
    const d = decide({ candidate: { requests: 30, errors: 6, p99Ms: 100 }, stable: { requests: 300, errors: 90, p99Ms: 100 } }, t, 70, 60);
    expect(d.action).toBe("esperar");
  });

  it("espera la duración del paso y el tráfico mínimo antes de avanzar", () => {
    expect(decide({ candidate: { requests: 50, errors: 0, p99Ms: 90 }, stable: ok }, t, 30, 60).action).toBe("esperar");
    expect(decide({ candidate: { requests: 5, errors: 0, p99Ms: 90 }, stable: ok }, t, 90, 60).reason).toMatch(/tráfico insuficiente/);
    expect(decide({ candidate: { requests: 50, errors: 0, p99Ms: 90 }, stable: ok }, t, 61, 60).action).toBe("avanzar");
  });
});
