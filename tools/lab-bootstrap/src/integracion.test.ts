import { describe, expect, it } from "vitest";
import {
  Verificaciones,
  buscarEnCola,
  evaluarAceptada,
  evaluarConsultaNoDestructiva,
  sinLimiteDeEntregas,
  evaluarEnFallidos,
  evaluarEntrega,
  evaluarInvalida,
  evaluarRechazoSinReintento,
  evaluarRepeticion,
  evaluarTraza,
  spansPorServicio,
  type Recepcion,
} from "./integracion.js";

const original = {
  idSolicitud: "SOL-1154b355",
  estado: "recibida",
  operador: { rut: "76.086.428-5", razonSocial: "Operador Sintético" },
  correlacion: "urn:uuid:1",
};
const rec = (correlacion: string, status: number, resultado: Recepcion["resultado"]): Recepcion => ({
  en: "2026-10-13T00:00:00Z",
  correlacion,
  idempotencyKey: "k",
  status,
  resultado,
});

describe("aserciones de check-integracion", () => {
  it("la solicitud válida exige 202, identificador, correlación y la razón social del servicio SOAP", () => {
    expect(evaluarAceptada(202, original).ok).toBe(true);
    // Servicio SOAP detenido: el flujo cae en su secuencia de error y responde 502.
    const caido = evaluarAceptada(502, { error: "no fue posible procesar la solicitud" });
    expect(caido.ok).toBe(false);
    expect(caido.detalle).toMatch(/502.*SOAP/);
    expect(evaluarAceptada(202, { ...original, operador: { rut: "76.086.428-5", razonSocial: "" } }).ok).toBe(
      false,
    );
  });

  it("la repetición exige 200, la misma solicitud y el encabezado de repetición", () => {
    expect(evaluarRepeticion(200, { ...original, repeticion: true }, "true", original).ok).toBe(true);
    expect(evaluarRepeticion(202, { ...original, idSolicitud: "SOL-otro" }, null, original).ok).toBe(false);
    expect(evaluarRepeticion(200, { ...original, repeticion: true }, null, original).ok).toBe(false);
  });

  it("la inválida exige 422 del esquema (no 400 ni 502)", () => {
    expect(evaluarInvalida(422, { error: "solicitud inválida" }).ok).toBe(true);
    expect(evaluarInvalida(400, { error: "solicitud inválida" }).ok).toBe(false);
    expect(evaluarInvalida(502, {}).ok).toBe(false);
  });

  it("la entrega exige exactamente un registro creado en el destino para la correlación", () => {
    expect(
      evaluarEntrega([rec("urn:uuid:1", 201, "creado"), rec("otra", 201, "creado")], "urn:uuid:1").ok,
    ).toBe(true);
    expect(
      evaluarEntrega(
        [rec("urn:uuid:1", 503, "falla-simulada"), rec("urn:uuid:1", 201, "creado")],
        "urn:uuid:1",
      ).ok,
    ).toBe(true);
    expect(evaluarEntrega([], "urn:uuid:1").ok).toBe(false);
    expect(
      evaluarEntrega([rec("urn:uuid:1", 201, "creado"), rec("urn:uuid:1", 201, "creado")], "urn:uuid:1")
        .detalle,
    ).toMatch(/2 veces/);
  });

  it("un rechazo 4xx debe llegar una sola vez al destino y quedar en fallidos con 1 intento", () => {
    expect(evaluarRechazoSinReintento([rec("c", 422, "falla-simulada")], "c", 422).ok).toBe(true);
    expect(
      evaluarRechazoSinReintento([rec("c", 422, "falla-simulada"), rec("c", 422, "falla-simulada")], "c", 422)
        .ok,
    ).toBe(false);
    const m = {
      payload: "{}",
      properties: { headers: { "x-correlacion": "c", "x-intentos": 1, "x-motivo": "HTTP 422" } },
    };
    expect(buscarEnCola([{ payload: "{}" }, m], "c")).toBe(m);
    expect(evaluarEnFallidos(m, 422).ok).toBe(true);
    expect(
      evaluarEnFallidos(
        { ...m, properties: { headers: { ...m.properties.headers, "x-intentos": "4" } } },
        422,
      ).ok,
    ).toBe(false);
    expect(evaluarEnFallidos(undefined, 422).ok).toBe(false);
  });

  it("la consulta de fallidos es no destructiva solo con la política sin límite y el mensaje intacto", () => {
    const conPolitica = {
      policy: "p",
      delivery_limit: "unlimited",
      effective_policy_definition: { "delivery-limit": -1 },
    };
    expect(sinLimiteDeEntregas(conPolitica)).toBe(true);
    expect(sinLimiteDeEntregas({ delivery_limit: 20, effective_policy_definition: {} })).toBe(false);
    expect(evaluarConsultaNoDestructiva(conPolitica, 25, true).ok).toBe(true);
    expect(evaluarConsultaNoDestructiva(conPolitica, 25, false).ok).toBe(false);
    const sinPolitica = evaluarConsultaNoDestructiva(
      { delivery_limit: 20, effective_policy_definition: {} },
      undefined,
      true,
    );
    expect(sinPolitica.ok).toBe(false);
    expect(sinPolitica.detalle).toMatch(/no se hacen las lecturas.*make bootstrap/);
  });

  it("la traza debe tener spans del gateway y de Micro Integrator", () => {
    const t = {
      result: {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "WSO2-SYNAPSE" } }] },
            scopeSpans: [{ spans: [1, 2] }, { spans: [3] }],
          },
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "API:Gateway" } }] },
            scopeSpans: [{ spans: [1] }],
          },
        ],
      },
    };
    expect(spansPorServicio(t)).toEqual({ "WSO2-SYNAPSE": 3, "API:Gateway": 1 });
    expect(evaluarTraza(200, t, "abc").ok).toBe(true);
    expect(evaluarTraza(404, undefined, "abc").ok).toBe(false);
    expect(evaluarTraza(200, { result: { resourceSpans: [t.result.resourceSpans[1]!] } }, "abc").ok).toBe(
      false,
    );
  });

  it("una sola verificación que no cumple hace fallar el conjunto", () => {
    const lineas: string[] = [];
    const v = new Verificaciones((m) => lineas.push(m));
    v.verificar("a", true, "bien");
    v.verificar("b", false, "mal");
    expect(v.fallidas.map((f) => f.nombre)).toEqual(["b"]);
    expect(v.resumen()).toBe("1 de 2 verificaciones cumplen");
    expect(lineas[1]).toMatch(/NO CUMPLE · b: mal/);
  });
});
