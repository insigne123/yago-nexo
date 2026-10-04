import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cx } from "../../lib/cx";
import { toastStore, type ToastVariant } from "./toast-store";

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

const ACCENT: Record<ToastVariant, string> = {
  success: "text-ok",
  error: "text-bad",
  warning: "text-warn",
  info: "text-accent",
};

/** Avisos flotantes. Los errores se anuncian como alerta; el resto, como estado. */
export function Toaster() {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
  return (
    <section
      aria-label="Avisos"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(26rem,calc(100%-2rem))] flex-col gap-2 print:hidden"
    >
      {items.map((item) => {
        const Icon = ICONS[item.variant];
        return (
          <div
            key={item.id}
            role={item.variant === "error" ? "alert" : "status"}
            data-testid="toast"
            data-variant={item.variant}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface p-3 shadow-lg"
          >
            <Icon className={cx("mt-0.5 size-5 shrink-0", ACCENT[item.variant])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg">{item.title}</p>
              {item.description && <p className="mt-0.5 text-sm text-fg-muted">{item.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => toastStore.dismiss(item.id)}
              className="rounded p-0.5 text-fg-muted hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Cerrar aviso</span>
            </button>
          </div>
        );
      })}
    </section>
  );
}
