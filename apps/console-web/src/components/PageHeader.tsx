import { useEffect, type ReactNode } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Consola Nexo`;
  }, [title]);
}

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Código de requisito o capacidad (D-01, BT-021…), visible como referencia. */
  reference?: string;
  breadcrumb?: ReactNode;
}

export function PageHeader({ title, description, actions, reference, breadcrumb }: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-fg-muted print:hidden">{breadcrumb}</div>}
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight text-fg">
          {title}
          {reference && (
            <span className="rounded border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted">
              {reference}
            </span>
          )}
        </h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </div>
  );
}
