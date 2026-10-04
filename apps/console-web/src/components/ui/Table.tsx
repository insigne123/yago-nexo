import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

export function TableContainer({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cx("overflow-x-auto rounded-lg border border-line bg-surface", className)} {...rest} />
  );
}

interface TableProps extends ComponentPropsWithoutRef<"table"> {
  caption?: string;
}

export function Table({ caption, className, children, ...rest }: TableProps) {
  return (
    <table className={cx("w-full border-collapse text-left text-sm", className)} {...rest}>
      {caption && <caption className="sr-only">{caption}</caption>}
      {children}
    </table>
  );
}

export function THead(props: ComponentPropsWithoutRef<"thead">) {
  return <thead className="border-b border-line bg-subtle text-xs text-fg-muted" {...props} />;
}

export function TBody(props: ComponentPropsWithoutRef<"tbody">) {
  return <tbody className="divide-y divide-line" {...props} />;
}

export function Tr({ className, ...rest }: ComponentPropsWithoutRef<"tr">) {
  return <tr className={cx("align-top", className)} {...rest} />;
}

export function Th({ className, ...rest }: ComponentPropsWithoutRef<"th">) {
  return <th scope="col" className={cx("px-3 py-2 font-semibold whitespace-nowrap", className)} {...rest} />;
}

export function Td({ className, ...rest }: ComponentPropsWithoutRef<"td">) {
  return <td className={cx("px-3 py-2.5", className)} {...rest} />;
}

export type SortValue = string | number | boolean | null | undefined;

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Si se define, la columna se puede ordenar. */
  sortValue?: (row: T) => SortValue;
  align?: "left" | "right" | "center";
  className?: string;
  /** Oculta la columna al imprimir (acciones). */
  printHidden?: boolean;
}

interface DataTableProps<T> {
  rows: readonly T[] | undefined;
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  loading?: boolean;
  testId?: string;
  rowTestId?: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  initialSort?: { id: string; direction: "asc" | "desc" };
  rowClassName?: (row: T) => string | undefined;
}

function compare(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/** Tabla con ordenamiento accesible (aria-sort), estado de carga y estado vacío. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  loading = false,
  testId,
  rowTestId,
  emptyTitle = "Sin resultados",
  emptyDescription,
  initialSort,
  rowClassName,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);

  const column = sort ? columns.find((c) => c.id === sort.id) : undefined;
  const sortFn = column?.sortValue;
  const data = rows ?? [];
  const sorted =
    sort && sortFn
      ? [...data].sort((a, b) => compare(sortFn(a), sortFn(b)) * (sort.direction === "asc" ? 1 : -1))
      : data;

  const toggle = (id: string) => {
    setSort((current) =>
      current?.id === id
        ? { id, direction: current.direction === "asc" ? "desc" : "asc" }
        : { id, direction: "asc" },
    );
  };

  return (
    <TableContainer>
      <Table caption={caption} data-testid={testId}>
        <THead>
          <tr>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              return (
                <Th
                  key={c.id}
                  aria-sort={c.sortValue ? (ariaSort ?? "none") : undefined}
                  className={cx(ALIGN[c.align ?? "left"], c.printHidden && "print:hidden")}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className="inline-flex items-center gap-1 rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {c.header}
                      {active ? (
                        sort.direction === "asc" ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3.5 opacity-50 print:hidden" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </Th>
              );
            })}
          </tr>
        </THead>
        <TBody>
          {loading && data.length === 0
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={`skeleton-${i}`}>
                  {columns.map((c) => (
                    <Td key={c.id}>
                      <Skeleton className="h-4 w-full max-w-40" />
                    </Td>
                  ))}
                </tr>
              ))
            : sorted.map((row) => (
                <Tr key={rowKey(row)} data-testid={rowTestId?.(row)} className={rowClassName?.(row)}>
                  {columns.map((c) => (
                    <Td
                      key={c.id}
                      className={cx(ALIGN[c.align ?? "left"], c.className, c.printHidden && "print:hidden")}
                    >
                      {c.cell(row)}
                    </Td>
                  ))}
                </Tr>
              ))}
        </TBody>
      </Table>
      {!loading && data.length === 0 && (
        <EmptyState compact title={emptyTitle} description={emptyDescription} />
      )}
    </TableContainer>
  );
}
