/**
 * Funciones puras del catálogo: completitud de la ficha (BT-018), analizador de flujos del Integrador
 * y análisis de impacto sobre el grafo de dependencias (BT-022, BT-024).
 */
export type Row = Record<string, unknown>;

export interface GraphNode {
  id: string;
  type: "api" | "flujo" | "sistema" | "dato" | "consumidor" | "reporte";
  label: string;
  meta?: Record<string, unknown>;
}

/** Arista de quien depende (from) hacia lo que usa (to). */
export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  source: string;
}

/** Los 8 campos que exige BT-018 para cada API del catálogo. */
const REQUIRED_FIELDS = [
  ["purpose", "propósito"],
  ["owner_team", "propietario"],
  ["contract_ref", "contrato"],
  ["version", "versión"],
  ["auth_type", "autenticación"],
  ["consumers_count", "consumidores"],
  ["dependencies_count", "dependencias"],
  ["state", "estado"],
] as const;

export function completeness(r: Row): { pct: number; missing: string[] } {
  const missing: string[] = [];
  for (const [col, label] of REQUIRED_FIELDS) {
    const v = r[col];
    const present = typeof v === "number" ? v > 0 : v !== null && v !== undefined && String(v).trim() !== "";
    if (!present) missing.push(label);
  }
  return { pct: Math.round(((REQUIRED_FIELDS.length - missing.length) / REQUIRED_FIELDS.length) * 100), missing };
}


export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
}

type FlowDependency = { id: string; label: string; relation: "llama" | "publica" | "escribe"; meta: Record<string, unknown> };

/**
 * Analizador de flujos MI: lee la configuración Synapse del flujo y deriva los sistemas y colas que usa.
 * `addresses` traduce cada endpoint con nombre a su dirección real, para unir el flujo con el sistema de destino.
 */
export function flowDependencies(xml: string, addresses: ReadonlyMap<string, string> = new Map()): FlowDependency[] {
  const deps = new Map<string, FlowDependency>();
  for (const m of xml.matchAll(/<endpoint key="([^"]+)"/g)) {
    const key = m[1]!;
    const address = addresses.get(key);
    if (/^Cola/i.test(key) || address?.startsWith("rabbitmq:")) {
      deps.set("sistema:rabbitmq", { id: "sistema:rabbitmq", label: "RabbitMQ (colas de mensajería)", relation: "publica", meta: { endpoint: key } });
      continue;
    }
    const host = address ? hostOf(address) : undefined;
    const id = `sistema:${host ?? key}`;
    deps.set(id, { id, label: host ? `${host} (${key})` : key, relation: "llama", meta: { endpoint: key, ...(address ? { url: address } : {}) } });
  }
  if (/<(dblookup|dbreport)\b/i.test(xml)) {
    deps.set("sistema:postgres-integracion", { id: "sistema:postgres-integracion", label: "PostgreSQL de integración (idempotencia)", relation: "escribe", meta: {} });
  }
  return [...deps.values()];
}

/**
 * Todo lo que depende, directa o indirectamente, del nodo que cambia. Las aristas van de quien depende
 * hacia lo que usa, así que se recorren al revés (BFS), guardando el camino para explicar cada afectado.
 */
export function impactOf(nodes: GraphNode[], edges: GraphEdge[], nodeId: string, kind: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dependents = new Map<string, string[]>();
  for (const e of edges) {
    const list = dependents.get(e.to) ?? [];
    list.push(e.from);
    dependents.set(e.to, list);
  }
  const visited = new Map<string, string[]>([[nodeId, [nodeId]]]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const dep of dependents.get(cur) ?? []) {
      if (!visited.has(dep)) {
        visited.set(dep, [...visited.get(cur)!, dep]);
        queue.push(dep);
      }
    }
  }
  visited.delete(nodeId);
  const affected = { consumidores: [] as GraphNode[], apis: [] as GraphNode[], flujos: [] as GraphNode[], sistemas: [] as GraphNode[], reportes: [] as GraphNode[] };
  for (const id of visited.keys()) {
    const n = byId.get(id);
    if (!n) continue;
    const bucket = n.type === "consumidor" ? "consumidores" : n.type === "api" ? "apis" : n.type === "flujo" ? "flujos" : n.type === "reporte" ? "reportes" : "sistemas";
    affected[bucket].push(n);
  }
  const consumers = affected.consumidores.length;
  const severity: "alto" | "medio" | "bajo" = kind === "retiro" || consumers >= 3 ? "alto" : consumers > 0 ? "medio" : "bajo";
  return { affected, paths: [...visited.values()], severity };
}
