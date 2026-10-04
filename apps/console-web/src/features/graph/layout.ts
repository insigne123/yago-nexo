import type { GraphEdge, GraphNode, GraphNodeType } from "../../api/types";

/**
 * Disposición en capas por tipo de nodo, de izquierda a derecha. Los consumidores van antes de
 * las APIs que llaman, para que las aristas "consume" no crucen todo el grafo; los reportes,
 * después de los datos que leen.
 */
export const LAYER_ORDER: readonly GraphNodeType[] = [
  "consumidor",
  "api",
  "flujo",
  "sistema",
  "dato",
  "reporte",
];

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  columnGap?: number;
  rowGap?: number;
  order?: readonly GraphNodeType[];
  /** Pasadas del ordenamiento por baricentro (reduce cruces de aristas). */
  sweeps?: number;
}

export function layeredLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: LayoutOptions = {},
): Map<string, Point> {
  const order = options.order ?? LAYER_ORDER;
  const columnGap = options.columnGap ?? 280;
  const rowGap = options.rowGap ?? 84;
  const sweeps = options.sweeps ?? 4;

  const buckets = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const index = order.indexOf(node.type);
    const layer = index === -1 ? order.length : index;
    const bucket = buckets.get(layer) ?? [];
    bucket.push(node);
    buckets.set(layer, bucket);
  }
  const layers = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, list]) => [...list].sort((a, b) => a.label.localeCompare(b.label, "es")));

  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = neighbors.get(a) ?? new Set<string>();
    set.add(b);
    neighbors.set(a, set);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const position = new Map<string, number>();
  const refresh = (layer: GraphNode[]) => layer.forEach((n, i) => position.set(n.id, i));
  layers.forEach(refresh);

  const barycenter = (node: GraphNode, reference: Set<string>): number => {
    const linked = [...(neighbors.get(node.id) ?? [])].filter((id) => reference.has(id));
    if (linked.length === 0) return position.get(node.id) ?? 0;
    return linked.reduce((sum, id) => sum + (position.get(id) ?? 0), 0) / linked.length;
  };

  const reorder = (layer: GraphNode[] | undefined, reference: GraphNode[] | undefined) => {
    if (!layer || !reference) return;
    const ids = new Set(reference.map((n) => n.id));
    const scores = new Map(layer.map((n) => [n.id, barycenter(n, ids)]));
    layer.sort((a, b) => (scores.get(a.id) ?? 0) - (scores.get(b.id) ?? 0));
    refresh(layer);
  };

  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let i = 1; i < layers.length; i++) reorder(layers[i], layers[i - 1]);
    for (let i = layers.length - 2; i >= 0; i--) reorder(layers[i], layers[i + 1]);
  }

  const tallest = Math.max(0, ...layers.map((l) => l.length));
  const result = new Map<string, Point>();
  layers.forEach((layer, column) => {
    const offset = ((tallest - layer.length) * rowGap) / 2;
    layer.forEach((node, row) => result.set(node.id, { x: column * columnGap, y: offset + row * rowGap }));
  });
  return result;
}
