import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

interface FullPageMessageProps {
  message: string;
  detail?: ReactNode;
  error?: boolean;
  action?: ReactNode;
}

/** Mensaje a pantalla completa para el arranque (carga de configuración, sesión) y errores fatales. */
export function FullPageMessage({ message, detail, error = false, action }: FullPageMessageProps) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center"
      role={error ? "alert" : "status"}
      aria-live="polite"
    >
      {error ? (
        <CircleAlert className="size-8 text-bad" aria-hidden="true" />
      ) : (
        <LoaderCircle className="size-7 text-accent motion-safe:animate-spin" aria-hidden="true" />
      )}
      <p className={error ? "text-base font-semibold text-fg" : "text-sm text-fg-muted"}>{message}</p>
      {detail && <div className="max-w-xl text-sm text-fg-muted">{detail}</div>}
      {action}
    </div>
  );
}
