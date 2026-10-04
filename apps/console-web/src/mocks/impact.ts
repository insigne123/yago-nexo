import type { GraphEdge, GraphNode, ImpactChangeKind, ImpactResult } from "../api/types";

/**
 * Simulación de impacto sobre el grafo (BT-024). Un nodo depende de otro cuando lo consume,
 * lo llama, lo lee o escribe en él; un reporte depende de los datos que transforma. El cambio
 * se propaga a todo lo que depende, directa o indirectamente, del nodo modificado.
 */

const USES = new Set<GraphEdge["relation"]>(["consume", "llama", "lee", "escribe", "publica"]);

function dependentsIndex(edges: readonly GraphEdge[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const add = (of: string, dependent: string) => index.set(of, [...(index.get(of) ?? []), dependent]);
  for (const e of edges) {
    if (USES.has(e.relation)) add(e.to, e.from);
    else if (e.relation === "transforma") add(e.from, e.to);
  }
  return index;
}

/** Lo que el nodo alimenta aguas abajo (un cambio de fuente también mueve sus datos y reportes). */
function downstreamIndex(edges: readonly GraphEdge[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const e of edges) {
    if (e.relation === "escribe" || e.relation === "transforma")
      index.set(e.from, [...(index.get(e.from) ?? []), e.to]);
  }
  return index;
}

export function simulateImpact(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  nodeId: string,
  kind: ImpactChangeKind,
): ImpactResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dependents = dependentsIndex(edges);
  const downstream = downstreamIndex(edges);
  const parent = new Map<string, string>();
  const visited = new Set<string>([nodeId]);
  const queue = [nodeId];

  const visit = (from: string, next: string) => {
    if (visited.has(next)) return;
    visited.add(next);
    parent.set(next, from);
    queue.push(next);
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const d of dependents.get(current) ?? []) visit(current, d);
    const node = byId.get(current);
    if (kind === "fuente" && (node?.type === "sistema" || node?.type === "dato")) {
      for (const d of downstream.get(current) ?? []) visit(current, d);
    }
  }
  visited.delete(nodeId);

  const affected = [...visited].map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n));
  const of = (type: GraphNode["type"]) => affected.filter((n) => n.type === type);

  // Una ruta por cada hoja afectada (consumidor o reporte), desde el cambio hacia afuera.
  const leaves = affected.filter((n) => n.type === "consumidor" || n.type === "reporte");
  const paths = leaves.map((leaf) => {
    const path = [leaf.id];
    let cursor = parent.get(leaf.id);
    while (cursor) {
      path.unshift(cursor);
      cursor = parent.get(cursor);
    }
    return path;
  });

  const consumers = of("consumidor");
  const apis = of("api");
  const reports = of("reporte");
  const external = consumers.filter(
    (c) => c.meta?.audience === "operadores" || c.meta?.audience === "publica",
  ).length;
  const personal = apis.some((a) => a.meta?.classification === "datos_personales");
  let severity: ImpactResult["severity"] = "bajo";
  if (
    (kind === "retiro" && consumers.length > 0) ||
    consumers.length >= 4 ||
    external >= 3 ||
    (personal && consumers.length > 0)
  ) {
    severity = "alto";
  } else if (consumers.length > 0 || reports.length > 0) {
    severity = "medio";
  }

  return {
    nodeId,
    affected: {
      consumidores: consumers,
      apis,
      flujos: of("flujo"),
      sistemas: of("sistema"),
      reportes: reports,
    },
    paths,
    severity,
  };
}
