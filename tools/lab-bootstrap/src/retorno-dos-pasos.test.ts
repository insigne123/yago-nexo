import { describe, expect, it } from "vitest";
import { evaluarRetorno } from "./retorno-dos-pasos.js";

const bien = {
  solicitud: 201,
  aprobacion: 202,
  aprobada: { id: "r1", status: "aprobada", requestedBy: "carla.operacion", decidedBy: "luis.aprobador" },
  activo: "cpd",
  dns: "10.80.0.1",
};

describe("retorno al CPD en dos pasos (check-d05)", () => {
  it("cumple con solicitud 201, aprobación 202 de otra persona y el CPD de vuelta como activo", () => {
    const r = evaluarRetorno(bien);
    expect(r.cumple).toBe(true);
    expect(r.obtenido).toBe("201 · 202 · carla.operacion → luis.aprobador · activo cpd · dns 10.80.0.1");
  });

  it("no cumple si la misma persona solicita y aprueba, si no se aprueba o si no vuelve al CPD", () => {
    expect(
      evaluarRetorno({ ...bien, aprobada: { ...bien.aprobada, decidedBy: "carla.operacion" } }).cumple,
    ).toBe(false);
    expect(evaluarRetorno({ ...bien, aprobacion: 403, aprobada: undefined }).cumple).toBe(false);
    expect(evaluarRetorno({ solicitud: 409 }).cumple).toBe(false);
    expect(evaluarRetorno({ ...bien, activo: "gcp", dns: "10.80.0.2" }).cumple).toBe(false);
    // El retorno de un solo paso (POST /continuity/failback) ya no existe: 404.
    expect(evaluarRetorno({ solicitud: 404 }).obtenido).toMatch(/^404 · -/);
  });
});
