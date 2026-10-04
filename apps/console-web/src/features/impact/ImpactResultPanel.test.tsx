import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphNode, ImpactRequest, ImpactResult } from "../../api/types";
import { impactCsv, impactHighlight } from "./impact";
import { ImpactResultPanel } from "./ImpactResultPanel";

const graphNodes: GraphNode[] = [
  { id: "dato-reclamo", type: "dato", label: "Tabla RECLAMO" },
  { id: "sis-cloudsql", type: "sistema", label: "Cloud SQL Reclamos (GCP)" },
  { id: "flujo-reclamos", type: "flujo", label: "Ingreso de reclamos" },
  { id: "api-reclamos", type: "api", label: "Reclamos 2.1.0" },
  { id: "cons-mesa", type: "consumidor", label: "Mesa de Ayuda Ciudadana" },
  { id: "cons-portal", type: "consumidor", label: "Portal de Trámites SUBTEL" },
  { id: "rep-reclamos", type: "reporte", label: "Reporte mensual de reclamos" },
];
const nodes = new Map(graphNodes.map((n) => [n.id, n]));
const node = (id: string) => nodes.get(id)!;

const request: ImpactRequest = {
  nodeId: "dato-reclamo",
  change: { kind: "campo", detail: "Se elimina el campo region" },
};
const result: ImpactResult = {
  nodeId: "dato-reclamo",
  severity: "alto",
  affected: {
    consumidores: [node("cons-mesa"), node("cons-portal")],
    apis: [node("api-reclamos")],
    flujos: [node("flujo-reclamos")],
    sistemas: [node("sis-cloudsql")],
    reportes: [node("rep-reclamos")],
  },
  paths: [
    ["dato-reclamo", "sis-cloudsql", "flujo-reclamos", "api-reclamos", "cons-mesa"],
    ["dato-reclamo", "rep-reclamos"],
  ],
};

describe("resultado de la simulación de impacto", () => {
  it("muestra la severidad, los grupos afectados y las rutas", async () => {
    const onExportCsv = vi.fn();
    const onPrint = vi.fn();
    render(
      <ImpactResultPanel
        request={request}
        result={result}
        nodes={nodes}
        onExportCsv={onExportCsv}
        onPrint={onPrint}
      />,
    );

    expect(screen.getByTestId("impact-severity")).toHaveTextContent("Impacto alto");
    expect(screen.getByTestId("impact-severity")).toHaveAttribute("data-severity", "alto");
    expect(screen.getByTestId("impact-total")).toHaveTextContent("6 activos afectados en 2 rutas.");
    expect(screen.getByText(/Cambio de un campo en/)).toHaveTextContent(
      "Tabla RECLAMO (Dato): Se elimina el campo region",
    );

    const consumers = within(screen.getByTestId("impact-group-consumidores"));
    expect(consumers.getByRole("heading")).toHaveTextContent("Consumidores (2)");
    expect(consumers.getByText("Mesa de Ayuda Ciudadana")).toBeInTheDocument();
    expect(consumers.getByText("Portal de Trámites SUBTEL")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("impact-group-reportes")).getByText("Reporte mensual de reclamos"),
    ).toBeInTheDocument();

    const paths = screen.getAllByTestId("impact-path");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toHaveTextContent(
      "Tabla RECLAMO → Cloud SQL Reclamos (GCP) → Ingreso de reclamos → Reclamos 2.1.0 → Mesa de Ayuda Ciudadana",
    );

    await userEvent.click(screen.getByRole("button", { name: "Exportar CSV" }));
    await userEvent.click(screen.getByRole("button", { name: "Vista para imprimir" }));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it("informa cuando el cambio no afecta a otros activos", () => {
    const empty: ImpactResult = { nodeId: "cons-mesa", severity: "bajo", affected: {}, paths: [] };
    render(
      <ImpactResultPanel
        request={{ nodeId: "cons-mesa", change: { kind: "retiro" } }}
        result={empty}
        nodes={nodes}
      />,
    );
    expect(screen.getByTestId("impact-severity")).toHaveTextContent("Impacto bajo");
    expect(screen.getByTestId("impact-total")).toHaveTextContent(
      "El cambio no afecta a otros activos registrados.",
    );
    expect(within(screen.getByTestId("impact-group-apis")).getByText("Ninguno")).toBeInTheDocument();
    expect(screen.queryByTestId("impact-path")).not.toBeInTheDocument();
  });

  it("la versión impresa no tiene botones", () => {
    render(
      <ImpactResultPanel
        request={request}
        result={result}
        nodes={nodes}
        onExportCsv={() => undefined}
        printable
      />,
    );
    expect(screen.getByTestId("impact-report-print")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("destaca nodos y aristas de las rutas y exporta el reporte en CSV", () => {
    const highlight = impactHighlight(result);
    expect(highlight.nodes.has("dato-reclamo")).toBe(true);
    expect(highlight.nodes.has("cons-portal")).toBe(true);
    expect(highlight.edges.has("api-reclamos->cons-mesa")).toBe(true);
    expect(highlight.edges.has("cons-mesa->api-reclamos")).toBe(true);

    const csv = impactCsv(request, result, nodes);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Sección,Grupo,Identificador,Nombre o detalle,Tipo");
    expect(csv).toContain("Activo afectado,Consumidores,cons-mesa,Mesa de Ayuda Ciudadana,Consumidor");
    expect(csv).toContain("Severidad,Impacto alto");
    expect(lines.filter((l) => l.startsWith("Ruta de impacto"))).toHaveLength(2);
  });
});
