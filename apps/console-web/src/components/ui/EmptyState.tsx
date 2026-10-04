import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  tone?: "neutral" | "bad";
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  compact = false,
  tone = "neutral",
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 px-4 py-8" : "gap-2 rounded-lg border border-dashed border-line-strong px-6 py-12",
      )}
    >
      <div className={cx("mb-1", tone === "bad" ? "text-bad" : "text-fg-subtle")} aria-hidden="true">
        {icon ?? <Inbox className="size-7" />}
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description && <div className="max-w-md text-sm text-fg-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
