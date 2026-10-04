import { describe, expect, it } from "vitest";
import { completeness, flowDependencies, impactOf, pathOf, type GraphEdge, type GraphNode } from "./catalog-graph.js";

const FLOW = `<api xmlns="http://ws.apache.org/ns/synapse" name="SolicitudesConcesionAPI" context="/integracion/solicitudes">
  <resource methods="POST"><inSequence>
    <dblookup><connection><pool><dsName>jdbc/NEXO_MI_DB</dsName></pool></connection></dblookup>
    <call><endpoint key="RegistroOperadoresEP"/></call>
    <call><endpoint key="ColaSolicitudesEP"/></call>
    <call><endpoint key="RegistroOperadoresEP"/></call>
  </inSequence></resource></api>`;

describe("analizador de flujos del Integrador", () => {
  it("deriva sistemas, colas y base de datos sin duplicar", () => {
    const deps = flowDependencies(FLOW, new Map([["RegistroOperadoresEP", "http://registro-soap:7001/soap/registro"]]));
    expect(deps.map((d) => [d.id, d.relation])).toEqual([
      ["sistema:registro-soap:7001", "llama"],
      ["sistema:rabbitmq", "publica"],
      ["sistema:postgres-integracion", "escribe"],
    ]);
    expect(deps[0]!.label).toBe("registro-soap:7001 (RegistroOperadoresEP)");
  });

  it("usa el nombre del endpoint cuando no conoce su dirección", () => {
    expect(flowDependencies(`<call><endpoint key="ErpEP"/></call>`)[0]!.id).toBe("sistema:ErpEP");
  });

  it("normaliza rutas de URL", () => {
    expect(pathOf("http://mi:8290/integracion/solicitudes/")).toBe("/integracion/solicitudes");
    expect(pathOf("http://mi:8290")).toBe("/");
    expect(pathOf("no es url")).toBeUndefined();
  });
});

describe("completitud de la ficha (8 campos)", () => {
  it("cuenta como faltantes los vacíos y los contadores en cero", () => {
    const c = completeness({
      purpose: "Consultar concesiones",
      owner_team: "Concesiones",
      contract_ref: "",
      version: "1.0.0",
      auth_type: "oauth2",
      consumers_count: 0,
      dependencies_count: 2,
      state: "PUBLISHED",
    });
    expect(c.missing).toEqual(["contrato", "consumidores"]);
    expect(c.pct).toBe(75);
  });
});

describe("análisis de impacto", () => {
  const nodes: GraphNode[] = [
    { id: "sistema:registro", type: "sistema", label: "Registro" },
    { id: "flujo:solicitudes", type: "flujo", label: "Solicitudes" },
    { id: "api:solicitudes", type: "api", label: "Solicitudes 1.0.0" },
    { id: "api:otra", type: "api", label: "Otra" },
    { id: "consumidor:a", type: "consumidor", label: "Operador A" },
    { id: "consumidor:b", type: "consumidor", label: "Operador B" },
  ];
  const edges: GraphEdge[] = [
    { from: "flujo:solicitudes", to: "sistema:registro", relation: "llama", source: "analizador_mi" },
    { from: "api:solicitudes", to: "flujo:solicitudes", relation: "llama", source: "analizador_mi" },
    { from: "consumidor:a", to: "api:solicitudes", relation: "consume", source: "configuracion" },
    { from: "consumidor:b", to: "api:otra", relation: "consume", source: "configuracion" },
  ];

  it("recorre las dependencias hacia atrás y explica el camino", () => {
    const r = impactOf(nodes, edges, "sistema:registro", "campo");
    expect(r.affected.flujos.map((n) => n.id)).toEqual(["flujo:solicitudes"]);
    expect(r.affected.apis.map((n) => n.id)).toEqual(["api:solicitudes"]);
    expect(r.affected.consumidores.map((n) => n.id)).toEqual(["consumidor:a"]);
    expect(r.paths).toContainEqual(["sistema:registro", "flujo:solicitudes", "api:solicitudes", "consumidor:a"]);
    expect(r.severity).toBe("medio");
  });

  it("un retiro siempre es de impacto alto", () => {
    expect(impactOf(nodes, edges, "api:otra", "retiro").severity).toBe("alto");
  });

  it("sin dependientes el impacto es bajo", () => {
    expect(impactOf(nodes, edges, "consumidor:b", "contrato")).toMatchObject({ severity: "bajo", paths: [] });
  });
});
