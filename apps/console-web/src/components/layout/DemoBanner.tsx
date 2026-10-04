import { FlaskConical } from "lucide-react";
import { formatClock } from "../../lib/format";
import { useNow } from "../../lib/useNow";

interface DemoBannerProps {
  environmentLabel: string;
  version: string;
  mock: boolean;
}

/**
 * Franja superior para demostraciones grabadas: ambiente, versión y fecha y hora local que se
 * actualiza cada segundo (los videos de Playwright la usan como prueba de fecha y versión).
 */
export function DemoBanner({ environmentLabel, version, mock }: DemoBannerProps) {
  const now = useNow();
  return (
    <div
      data-testid="demo-banner"
      className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-banner px-4 py-1 text-xs text-banner-fg"
    >
      <span data-testid="demo-banner-text" className="tabular">
        {environmentLabel} · Nexo {version} · {formatClock(new Date(now))}
      </span>
      {mock && (
        <span data-testid="demo-banner-mock" className="inline-flex items-center gap-1 font-medium">
          <FlaskConical className="size-3.5" aria-hidden="true" />
          Datos simulados (sin conexión a sistemas reales)
        </span>
      )}
    </div>
  );
}
