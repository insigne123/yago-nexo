import { Cable, Database, FileText, Server, Users, Workflow, type LucideIcon } from "lucide-react";
import type { GraphNodeType } from "../../api/types";
import { seriesColor, type VizPalette } from "../../components/charts/palette";

/** Tipo de nodo: ícono y posición fija en la paleta categórica (la identidad nunca va solo en color). */
export const NODE_META: Record<GraphNodeType, { label: string; icon: LucideIcon; slot: number }> = {
  api: { label: "API", icon: Cable, slot: 0 },
  flujo: { label: "Flujo de integración", icon: Workflow, slot: 1 },
  sistema: { label: "Sistema", icon: Server, slot: 2 },
  dato: { label: "Dato", icon: Database, slot: 3 },
  consumidor: { label: "Consumidor", icon: Users, slot: 4 },
  reporte: { label: "Reporte", icon: FileText, slot: 5 },
};

export function nodeColor(palette: VizPalette, type: GraphNodeType): string {
  return seriesColor(palette, NODE_META[type].slot);
}
