import { CircleAlert, Lock, RefreshCw } from "lucide-react";
import { ApiError, describeError } from "../api/errors";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";

/** Estado de error de una consulta, con reintento. Un 403 se explica como falta de permiso. */
export function QueryError({
  error,
  onRetry,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const { title, description } = describeError(error);
  return (
    <EmptyState
      compact={compact}
      tone="bad"
      icon={forbidden ? <Lock className="size-7" /> : <CircleAlert className="size-7" />}
      title={forbidden ? "Sin acceso a esta información" : title}
      description={description}
      action={
        onRetry && !forbidden ? (
          <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={onRetry}>
            Reintentar
          </Button>
        ) : undefined
      }
    />
  );
}
