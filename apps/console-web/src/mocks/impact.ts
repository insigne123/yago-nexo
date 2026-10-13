import {
  impactOf,
  type GraphEdge as ProductEdge,
  type GraphNode as ProductNode,
} from "@nexo/console-api/impacto";
import type { GraphEdge, GraphNode, ImpactChangeKind, ImpactResult } from "../api/types";

/**
 * Simulación de impacto de la demo (BT-024) con el MISMO motor que la API de la Consola:
 * impactOf de apps/console-api/src/modules/catalog-graph.ts (se importa el código fuente, no una copia).
 * Las aristas van de quien depende (from) hacia lo que usa (to), igual que en nexo.graph_edge, y el
 * cambio se propaga a todo lo que depende, directa o indirectamente, del nodo modificado.
 */
export function simulateImpact(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  nodeId: string,
  kind: ImpactChangeKind,
): ImpactResult {
  const result = impactOf(
    nodes.map((n) => ({ ...n, label: n.label ?? n.id }) as ProductNode),
    edges.map((e) => ({ ...e, source: e.source ?? "manual" }) as ProductEdge),
    nodeId,
    kind,
  );
  return { nodeId, ...result } as ImpactResult;
}
