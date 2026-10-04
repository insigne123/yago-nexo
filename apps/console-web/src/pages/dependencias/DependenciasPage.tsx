import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ExternalLink, FlaskConical, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useGraph, useImpactSimulation } from "../../api/queries";
import type { GraphEdge, GraphNode, ImpactRequest, ImpactResult } from "../../api/types";
import { useVizPalette } from "../../components/charts/palette";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { GraphNodeCard, type NexoFlowNode, type NodeVisualState } from "../../features/graph/GraphNodeCard";
import { LAYER_ORDER, layeredLayout } from "../../features/graph/layout";
import { NODE_META, nodeColor } from "../../features/graph/nodeTypes";
import { ImpactDialog } from "../../features/impact/ImpactDialog";
import { ImpactResultPanel } from "../../features/impact/ImpactResultPanel";
import { edgeKey, impactCsv, impactHighlight } from "../../features/impact/impact";
import { downloadCsv } from "../../lib/download";
import { fileTimestamp, formatDateTime } from "../../lib/format";
import { EDGE_SOURCE_LABELS, NODE_TYPE_LABELS, RELATION_LABELS, labelOf } from "../../lib/labels";
import { useRuntime } from "../../config/RuntimeContext";

const nodeTypes = { nexo: GraphNodeCard };

const ARIA_LABELS = {
  "node.a11yDescription.default": "Presione Enter o Espacio para seleccionar el nodo.",
  "node.a11yDescription.keyboardDisabled": "Presione Enter o Espacio para seleccionar el nodo.",
  "edge.a11yDescription.default": "Arista del grafo de dependencias.",
  "controls.ariaLabel": "Controles del grafo",
  "controls.zoomIn.ariaLabel": "Acercar",
  "controls.zoomOut.ariaLabel": "Alejar",
  "controls.fitView.ariaLabel": "Ajustar a la vista",
  "controls.interactive.ariaLabel": "Activar o desactivar la interacción",
  "minimap.ariaLabel": "Minimapa",
  "handle.ariaLabel": "Conector",
};

interface Simulation {
  request: ImpactRequest;
  result: ImpactResult;
  at: string;
}

function NodePanel({
  node,
  edges,
  nodes,
  onClose,
  onSimulate,
}: {
  node: GraphNode;
  edges: readonly GraphEdge[];
  nodes: ReadonlyMap<string, GraphNode>;
  onClose: () => void;
  onSimulate: () => void;
}) {
  const outgoing = edges.filter((e) => e.from === node.id);
  const incoming = edges.filter((e) => e.to === node.id);
  const meta = Object.entries(node.meta ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && typeof v !== "object",
  );
  const Icon = NODE_META[node.type].icon;
  const catalogId = node.type === "api" ? String(node.meta?.apiId ?? node.id) : null;
  return (
    <aside aria-label={`Detalle de ${node.label}`} className="flex flex-col gap-4" data-testid="node-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <Icon className="size-3.5" aria-hidden="true" />
            {NODE_META[node.type].label}
          </p>
          <h2 className="text-base font-semibold text-fg">{node.label}</h2>
          <code className="font-mono text-xs break-all text-fg-subtle">{node.id}</code>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-fg-muted hover:bg-subtle">
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Cerrar detalle</span>
        </button>
      </div>
      {meta.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {meta.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-fg-muted">{key}</dt>
              <dd className="break-words text-fg">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div>
        <h3 className="text-sm font-semibold text-fg">Depende de ({outgoing.length})</h3>
        <ul className="mt-1 space-y-1 text-sm">
          {outgoing.length === 0 && <li className="text-fg-subtle">Ninguno</li>}
          {outgoing.map((e) => (
            <li key={`${e.to}-${e.relation}`}>
              <span className="text-fg-muted">{labelOf(RELATION_LABELS, e.relation)}</span>{" "}
              {nodes.get(e.to)?.label ?? e.to}
              {e.source && (
                <span className="block text-xs text-fg-subtle">{labelOf(EDGE_SOURCE_LABELS, e.source)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-fg">Lo usan ({incoming.length})</h3>
        <ul className="mt-1 space-y-1 text-sm">
          {incoming.length === 0 && <li className="text-fg-subtle">Ninguno</li>}
          {incoming.map((e) => (
            <li key={`${e.from}-${e.relation}`}>
              {nodes.get(e.from)?.label ?? e.from}{" "}
              <span className="text-fg-muted">{labelOf(RELATION_LABELS, e.relation)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <GuardedButton
          permission="impact:simulate"
          variant="primary"
          size="sm"
          icon={<FlaskConical className="size-4" aria-hidden="true" />}
          onClick={onSimulate}
          data-testid="btn-simulate-change"
        >
          Simular cambio
        </GuardedButton>
        {catalogId && (
          <Link
            to={`/catalogo/${encodeURIComponent(catalogId)}`}
            className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            Ver ficha
          </Link>
        )}
      </div>
    </aside>
  );
}

export default function DependenciasPage() {
  const { config } = useRuntime();
  const graph = useGraph();
  const simulate = useImpactSimulation();
  const palette = useVizPalette();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("nodo");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [simulation, setSimulation] = useState<Simulation | null>(null);

  const nodes = useMemo(() => graph.data?.nodes ?? [], [graph.data]);
  const edges = useMemo(() => graph.data?.edges ?? [], [graph.data]);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const positions = useMemo(() => layeredLayout(nodes, edges, { rowGap: 70 }), [nodes, edges]);
  const highlight = useMemo(() => (simulation ? impactHighlight(simulation.result) : null), [simulation]);
  const selected = selectedId ? nodeMap.get(selectedId) : undefined;

  const select = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("nodo", id);
        else next.delete("nodo");
        return next;
      },
      { replace: true },
    );

  const flowNodes = useMemo<NexoFlowNode[]>(
    () =>
      nodes.map((node) => {
        let state: NodeVisualState = "normal";
        if (highlight) {
          if (node.id === simulation?.request.nodeId) state = "source";
          else state = highlight.nodes.has(node.id) ? "affected" : "dimmed";
        } else if (node.id === selectedId) state = "selected";
        return {
          id: node.id,
          type: "nexo",
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          data: { node, color: nodeColor(palette, node.type), state },
          draggable: false,
          connectable: false,
          // El minimapa usa las dimensiones del nodo entregado; sin onNodesChange no recibe las medidas.
          initialWidth: 210,
          initialHeight: 54,
          ariaLabel: `${NODE_TYPE_LABELS[node.type]}: ${node.label}`,
        };
      }),
    [nodes, positions, palette, highlight, simulation, selectedId],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const onPath = highlight?.edges.has(edgeKey(edge.from, edge.to)) ?? false;
        const dimmed = Boolean(highlight) && !onPath;
        const color = onPath ? palette.critical : palette.axis;
        return {
          id: `${edge.from}->${edge.to}:${edge.relation}`,
          source: edge.from,
          target: edge.to,
          type: "smoothstep",
          animated: onPath,
          label: onPath ? labelOf(RELATION_LABELS, edge.relation) : undefined,
          labelStyle: { fill: palette.text, fontSize: 11 },
          labelBgStyle: { fill: palette.surface },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          style: { stroke: color, strokeWidth: onPath ? 2.5 : 1.25, opacity: dimmed ? 0.15 : 1 },
          focusable: false,
        };
      }),
    [edges, highlight, palette],
  );

  const onNodeClick: NodeMouseHandler<NexoFlowNode> = (_event, node) => select(node.id);

  const runSimulation = (request: ImpactRequest) => {
    simulate.mutate(request, {
      onSuccess: (result) => {
        setSimulation({ request, result, at: new Date().toISOString() });
        setDialogOpen(false);
      },
    });
  };

  const exportCsv = () => {
    if (!simulation) return;
    downloadCsv(
      `impacto-${simulation.request.nodeId}-${fileTimestamp()}.csv`,
      impactCsv(simulation.request, simulation.result, nodeMap),
    );
  };

  const typeCounts = LAYER_ORDER.map((type) => ({
    type,
    count: nodes.filter((n) => n.type === type).length,
  }));

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title="Dependencias e impacto"
          reference="BT-024"
          description="Grafo de API → flujo → sistema → dato → reporte, con los consumidores de cada API. Seleccione un nodo para ver sus conexiones o simule un cambio para conocer su alcance antes de aplicarlo."
          actions={
            <GuardedButton
              permission="impact:simulate"
              variant="primary"
              icon={<FlaskConical className="size-4" aria-hidden="true" />}
              onClick={() => setDialogOpen(true)}
              disabled={nodes.length === 0}
              data-testid="btn-open-simulation"
            >
              Simular cambio
            </GuardedButton>
          }
        />

        {graph.isError ? (
          <QueryError error={graph.error} onRetry={() => void graph.refetch()} />
        ) : graph.isLoading ? (
          <Skeleton className="h-[560px]" />
        ) : nodes.length === 0 ? (
          <EmptyState
            title="El grafo de dependencias está vacío"
            description="Sincronice el catálogo o registre dependencias."
          />
        ) : (
          <>
            <ul
              className="mb-3 flex flex-wrap gap-x-4 gap-y-2"
              aria-label="Leyenda de tipos de nodo"
              data-testid="graph-legend"
            >
              {typeCounts.map(({ type, count }) => {
                const Icon = NODE_META[type].icon;
                return (
                  <li key={type} className="flex items-center gap-1.5 text-sm text-fg-muted">
                    <span
                      className="inline-block size-3 rounded-sm"
                      style={{ backgroundColor: nodeColor(palette, type) }}
                      aria-hidden="true"
                    />
                    <Icon className="size-3.5" aria-hidden="true" />
                    {NODE_TYPE_LABELS[type]} ({count})
                  </li>
                );
              })}
            </ul>
            <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
              <div
                className="h-[640px] overflow-hidden rounded-lg border border-line bg-surface"
                data-testid="graph-canvas"
              >
                <ReactFlow<NexoFlowNode, Edge>
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  onNodeClick={onNodeClick}
                  onNodesChange={(changes) => {
                    // Selección con teclado (Enter o Espacio sobre un nodo enfocado).
                    for (const change of changes)
                      if (change.type === "select" && change.selected) select(change.id);
                  }}
                  onPaneClick={() => select(null)}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  fitView
                  fitViewOptions={{ padding: 0.08 }}
                  minZoom={0.2}
                  maxZoom={1.75}
                  colorMode={palette.dark ? "dark" : "light"}
                  ariaLabelConfig={ARIA_LABELS}
                  aria-label="Grafo de dependencias"
                >
                  <Background color={palette.grid} gap={24} />
                  <Controls showInteractive={false} />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(n) => (n as NexoFlowNode).data.color}
                    maskColor={palette.dark ? "rgb(0 0 0 / 0.5)" : "rgb(240 242 245 / 0.7)"}
                  />
                </ReactFlow>
              </div>
              <Card>
                {selected ? (
                  <NodePanel
                    node={selected}
                    edges={edges}
                    nodes={nodeMap}
                    onClose={() => select(null)}
                    onSimulate={() => setDialogOpen(true)}
                  />
                ) : (
                  <div className="space-y-3 text-sm text-fg-muted">
                    <p>
                      Seleccione un nodo en el grafo o en la lista para ver de qué depende y quién lo usa.
                    </p>
                    <details>
                      <summary className="cursor-pointer font-medium text-fg">
                        Lista de nodos (alternativa al grafo)
                      </summary>
                      <div className="mt-2 max-h-96 space-y-3 overflow-y-auto">
                        {LAYER_ORDER.map((type) => {
                          const group = nodes.filter((n) => n.type === type);
                          if (group.length === 0) return null;
                          return (
                            <div key={type}>
                              <p className="text-xs font-semibold text-fg-muted uppercase">
                                {NODE_TYPE_LABELS[type]}
                              </p>
                              <ul>
                                {group.map((n) => (
                                  <li key={n.id}>
                                    <button
                                      type="button"
                                      onClick={() => select(n.id)}
                                      className="text-left text-accent hover:underline"
                                    >
                                      {n.label}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
      </div>

      {simulation && (
        // Al imprimir solo queda este reporte (el resto de la página es print:hidden).
        <section className="mt-6" aria-label="Reporte de impacto">
          <div className="hidden print:block">
            <h1 className="text-lg font-semibold">Reporte de impacto · Consola Nexo</h1>
            <p className="mb-4 text-sm">
              {config.environmentLabel} · Nexo {config.version} · Simulado el {formatDateTime(simulation.at)}
            </p>
          </div>
          <Card>
            <ImpactResultPanel
              request={simulation.request}
              result={simulation.result}
              nodes={nodeMap}
              onExportCsv={exportCsv}
              onPrint={() => window.print()}
              onClear={() => setSimulation(null)}
            />
          </Card>
        </section>
      )}

      <ImpactDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        nodes={nodes}
        defaultNodeId={selectedId}
        pending={simulate.isPending}
        onSubmit={runSimulation}
      />
    </>
  );
}
