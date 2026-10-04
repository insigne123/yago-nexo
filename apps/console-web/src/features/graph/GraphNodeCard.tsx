import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "../../api/types";
import { cx } from "../../lib/cx";
import { NODE_META } from "./nodeTypes";

export type NodeVisualState = "normal" | "selected" | "source" | "affected" | "dimmed";

export type NexoFlowNode = Node<{ node: GraphNode; color: string; state: NodeVisualState }, "nexo">;

const STATE_CLASS: Record<NodeVisualState, string> = {
  normal: "border-line",
  selected: "border-accent ring-2 ring-accent",
  source: "border-bad ring-2 ring-bad",
  affected: "border-bad",
  dimmed: "border-line opacity-30",
};

/** Nodo del grafo: franja de color por tipo, ícono, tipo en texto y nombre. */
export function GraphNodeCard({ data }: NodeProps<NexoFlowNode>) {
  const meta = NODE_META[data.node.type];
  const Icon = meta.icon;
  return (
    <div
      data-testid={`graph-node-${data.node.id}`}
      data-state={data.state}
      className={cx(
        "w-[210px] rounded-md border bg-surface px-3 py-2 text-left shadow-xs transition-opacity",
        STATE_CLASS[data.state],
      )}
      style={{ borderLeftWidth: 5, borderLeftColor: data.color }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{meta.label}</span>
        {data.state === "source" && <span className="ml-auto font-semibold text-bad">Origen del cambio</span>}
        {data.state === "affected" && <span className="ml-auto font-semibold text-bad">Afectado</span>}
      </div>
      <p className="mt-0.5 truncate text-sm font-medium text-fg" title={data.node.label}>
        {data.node.label}
      </p>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0 }} />
    </div>
  );
}
