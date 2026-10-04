import { CircleCheck, Download, Printer, TriangleAlert, X } from "lucide-react";
import type { GraphNode, ImpactRequest, ImpactResult, ImpactSeverity } from "../../api/types";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { CHANGE_KIND_LABELS, NODE_TYPE_LABELS, SEVERITY_LABELS, labelOf } from "../../lib/labels";
import { IMPACT_GROUPS, affectedNodes, pathLabel, totalAffected } from "./impact";

const SEVERITY_TONE: Record<ImpactSeverity, BadgeTone> = { bajo: "ok", medio: "warn", alto: "bad" };

export function SeverityBadge({ severity }: { severity: ImpactSeverity | undefined }) {
  if (!severity) return <Badge data-testid="impact-severity">Sin clasificar</Badge>;
  const Icon = severity === "bajo" ? CircleCheck : TriangleAlert;
  return (
    <Badge
      tone={SEVERITY_TONE[severity]}
      data-testid="impact-severity"
      data-severity={severity}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
    >
      {labelOf(SEVERITY_LABELS, severity)}
    </Badge>
  );
}

interface ImpactResultPanelProps {
  request: ImpactRequest;
  result: ImpactResult;
  nodes: ReadonlyMap<string, GraphNode>;
  onExportCsv?: () => void;
  onPrint?: () => void;
  onClear?: () => void;
  /** Versión para imprimir: sin botones. */
  printable?: boolean;
}

/** Resultado de "Simular cambio": severidad, activos afectados por grupo y rutas de propagación. */
export function ImpactResultPanel({
  request,
  result,
  nodes,
  onExportCsv,
  onPrint,
  onClear,
  printable = false,
}: ImpactResultPanelProps) {
  const source = nodes.get(request.nodeId);
  const total = totalAffected(result);
  const paths = result.paths ?? [];
  const headingId = printable ? "titulo-impacto-impreso" : "titulo-impacto";

  return (
    <section aria-labelledby={headingId} data-testid={printable ? "impact-report-print" : "impact-result"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold text-fg">
            Resultado de la simulación
            <SeverityBadge severity={result.severity} />
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {labelOf(CHANGE_KIND_LABELS, request.change.kind)} en{" "}
            <strong className="font-semibold text-fg">{source?.label ?? request.nodeId}</strong>
            {source ? ` (${labelOf(NODE_TYPE_LABELS, source.type)})` : ""}
            {request.change.detail ? `: ${request.change.detail}` : "."}
          </p>
          <p className="mt-1 text-sm text-fg" data-testid="impact-total" aria-live="polite">
            {total === 0
              ? "El cambio no afecta a otros activos registrados."
              : `${total} ${total === 1 ? "activo afectado" : "activos afectados"} en ${paths.length} ${paths.length === 1 ? "ruta" : "rutas"}.`}
          </p>
        </div>
        {!printable && (
          <div className="flex flex-wrap gap-2 print:hidden">
            {onExportCsv && (
              <Button
                size="sm"
                icon={<Download className="size-4" aria-hidden="true" />}
                onClick={onExportCsv}
                data-testid="btn-export-impact-csv"
              >
                Exportar CSV
              </Button>
            )}
            {onPrint && (
              <Button
                size="sm"
                icon={<Printer className="size-4" aria-hidden="true" />}
                onClick={onPrint}
                data-testid="btn-print-impact"
              >
                Vista para imprimir
              </Button>
            )}
            {onClear && (
              <Button
                size="sm"
                variant="ghost"
                icon={<X className="size-4" aria-hidden="true" />}
                onClick={onClear}
                data-testid="btn-clear-impact"
              >
                Limpiar
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {IMPACT_GROUPS.map((group) => {
          const items = affectedNodes(result, group.key);
          return (
            <div
              key={group.key}
              className="rounded-md border border-line p-3"
              data-testid={`impact-group-${group.key}`}
            >
              <h3 className="text-sm font-semibold text-fg">
                {group.label} <span className="font-normal text-fg-muted">({items.length})</span>
              </h3>
              {items.length === 0 ? (
                <p className="mt-1 text-sm text-fg-subtle">Ninguno</p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {items.map((node) => (
                    <li key={node.id} className="text-sm text-fg">
                      {node.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {paths.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-fg">Rutas de impacto</h3>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-fg">
            {paths.map((path, index) => (
              <li key={`${index}-${path.join(">")}`} data-testid="impact-path">
                {pathLabel(path, nodes)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
