import { describe, expect, it } from "vitest";
import { FallaProgramada, Recepciones } from "./recepciones.js";

describe("registro de recepciones del destino", () => {
  it("guarda cada solicitud sin deduplicar y filtra por correlación y fecha", () => {
    const r = new Recepciones();
    r.registrar(
      { correlacion: "c1", idempotencyKey: "k1", status: 503, resultado: "falla-simulada" },
      new Date("2026-10-13T00:00:00Z"),
    );
    r.registrar(
      { correlacion: "c1", idempotencyKey: "k1", status: 201, resultado: "creado" },
      new Date("2026-10-13T00:00:02Z"),
    );
    r.registrar(
      { correlacion: "c1", idempotencyKey: "k1", status: 201, resultado: "repeticion" },
      new Date("2026-10-13T00:00:03Z"),
    );
    r.registrar(
      { correlacion: "c2", idempotencyKey: "k2", status: 201, resultado: "creado" },
      new Date("2026-10-13T00:00:04Z"),
    );
    expect(r.consultar({ correlaciones: ["c1"] }).map((f) => f.resultado)).toEqual([
      "falla-simulada",
      "creado",
      "repeticion",
    ]);
    expect(r.consultar({ desde: "2026-10-13T00:00:03Z" }).map((f) => f.correlacion)).toEqual(["c1", "c2"]);
    expect(r.consultar({})).toHaveLength(4);
    expect(() => r.consultar({ desde: "ayer" })).toThrow(RangeError);
  });

  it("acota la memoria descartando las filas más antiguas", () => {
    const r = new Recepciones(3);
    for (let i = 0; i < 5; i++)
      r.registrar({ correlacion: `c${i}`, idempotencyKey: "", status: 201, resultado: "creado" });
    expect(r.consultar({}).map((f) => f.correlacion)).toEqual(["c2", "c3", "c4"]);
  });
});

describe("falla programada", () => {
  it("falla exactamente las próximas N solicitudes con el código pedido y luego deja pasar", () => {
    const f = new FallaProgramada();
    expect(f.tomar()).toBeUndefined();
    f.programar(2);
    expect([f.tomar(), f.tomar(), f.tomar()]).toEqual([503, 503, undefined]);
    f.programar(1, 422);
    expect(f.estado).toEqual({ restantes: 1, status: 422 });
    expect([f.tomar(), f.tomar()]).toEqual([422, undefined]);
  });

  it("rechaza cantidades y códigos inválidos", () => {
    const f = new FallaProgramada();
    expect(() => f.programar(-1)).toThrow(RangeError);
    expect(() => f.programar(1.5)).toThrow(RangeError);
    expect(() => f.programar(1, 200)).toThrow(RangeError);
  });
});
