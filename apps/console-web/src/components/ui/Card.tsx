import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../../lib/cx";

interface CardProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sin relleno interno (para tablas a todo el ancho). */
  flush?: boolean;
}

export function Card({
  title,
  description,
  actions,
  flush = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      className={cx("rounded-lg border border-line bg-surface shadow-xs print:shadow-none", className)}
      {...rest}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}
