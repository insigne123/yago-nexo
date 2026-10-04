import type { GraphNode, ImpactRequest, ImpactResult } from "../../api/types";
import { toCsv } from "../../lib/csv";
import { CHANGE_KIND_LABELS, NODE_TYPE_LABELS, SEVERITY_LABELS, labelOf } from "../../lib/labels";

export const IMPACT_GROUPS = [
  { key: "consumidores", label: "Consumidores" },
  { key: "apis", label: "APIs" },
  { key: "flujos", label: "Flujos" },
  { key: "sistemas", label: "Sistemas" },
  { key: "reportes", label: "Reportes" },
] as const;

export type ImpactGroupKey = (typeof IMPACT_GROUPS)[number]["key"];

export const edgeKey = (from: string, to: string) => `${from}->${to}`;

export function affectedNodes(result: ImpactResult, key: ImpactGroupKey): GraphNode[] {
  return result.affected?.[key] ?? [];
}

export function totalAffected(result: ImpactResult): number {
  return IMPACT_GROUPS.reduce((sum, g) => sum + affectedNodes(result, g.key).length, 0);
}

/** Nodos y aristas a destacar en el grafo: el origen, los afectados y las rutas. */
export function impactHighlight(result: ImpactResult): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const group of IMPACT_GROUPS) for (const n of affectedNodes(result, group.key)) nodes.add(n.id);
  for (const path of result.paths ?? []) {
    for (const id of path) nodes.add(id);
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      edges.add(edgeKey(a, b));
      edges.add(edgeKey(b, a));
    }
  }
  if (result.nodeId) nodes.add(result.nodeId);
  return { nodes, edges };
}

export function pathLabel(path: readonly string[], nodes: ReadonlyMap<string, GraphNode>): string {
  return path.map((id) => nodes.get(id)?.label ?? id).join(" → ");
}

/** Reporte de impacto en CSV: activos afectados por grupo y rutas de propagación. */
export function impactCsv(
  request: ImpactRequest,
  result: ImpactResult,
  nodes: ReadonlyMap<string, GraphNode>,
): string {
  const source = nodes.get(request.nodeId);
  type Row = { seccion: string; grupo: string; id: string; nombre: string; tipo: string };
  const rows: Row[] = [
    {
      seccion: "Cambio simulado",
      grupo: labelOf(CHANGE_KIND_LABELS, request.change.kind),
      id: request.nodeId,
      nombre: source?.label ?? request.nodeId,
      tipo: request.change.detail ?? "",
    },
    {
      seccion: "Severidad",
      grupo: result.severity ? labelOf(SEVERITY_LABELS, result.severity) : "Sin clasificar",
      id: "",
      nombre: `${totalAffected(result)} activos afectados`,
      tipo: "",
    },
  ];
  for (const group of IMPACT_GROUPS) {
    for (const n of affectedNodes(result, group.key)) {
      rows.push({
        seccion: "Activo afectado",
        grupo: group.label,
        id: n.id,
        nombre: n.label,
        tipo: labelOf(NODE_TYPE_LABELS, n.type),
      });
    }
  }
  (result.paths ?? []).forEach((path, i) => {
    rows.push({
      seccion: "Ruta de impacto",
      grupo: `Ruta ${i + 1}`,
      id: path.join(" > "),
      nombre: pathLabel(path, nodes),
      tipo: "",
    });
  });
  return toCsv(rows, [
    { header: "Sección", value: (r) => r.seccion },
    { header: "Grupo", value: (r) => r.grupo },
    { header: "Identificador", value: (r) => r.id },
    { header: "Nombre o detalle", value: (r) => r.nombre },
    { header: "Tipo", value: (r) => r.tipo },
  ]);
}
