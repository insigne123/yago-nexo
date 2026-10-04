import { CircleAlert } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";

/** Error al cargar o mostrar una página (por ejemplo, un fragmento que ya no existe tras una actualización). */
export function RouteError() {
  const error = useRouteError();
  const chunk =
    error instanceof Error &&
    /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(error.message);
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <div className="px-4 py-16">
      <EmptyState
        tone="bad"
        icon={<CircleAlert className="size-7" />}
        title={chunk ? "Hay una versión nueva de la Consola" : "No se pudo mostrar esta página"}
        description={chunk ? "Recargue la página para obtener la versión actual." : detail}
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            Recargar
          </Button>
        }
      />
    </div>
  );
}
