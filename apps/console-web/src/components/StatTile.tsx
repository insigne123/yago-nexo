import type { ReactNode } from "react";
import { Skeleton } from "./ui/Skeleton";

interface StatTileProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  testId?: string;
}

/** Indicador: etiqueta, valor (cifras proporcionales) y detalle opcional. */
export function StatTile({ label, value, detail, icon, loading = false, testId }: StatTileProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-fg-muted">
        <span>{label}</span>
        {icon && (
          <span className="text-fg-subtle" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <div className="mt-1.5 text-2xl font-semibold text-fg">{value}</div>
      )}
      {detail && !loading && <div className="mt-1 text-xs text-fg-muted">{detail}</div>}
    </div>
  );
}
