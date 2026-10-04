import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useDeadLetters, useReprocessDeadLetter } from "../../api/queries";
import type { DeadLetter } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { ReasonDialog } from "../../components/ReasonDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { Field, Select } from "../../components/ui/Input";
import { DataTable, type Column } from "../../components/ui/Table";
import { formatDateTime, formatNumber, plural } from "../../lib/format";

type StatusFilter = "" | NonNullable<DeadLetter["status"]>;

export default function MensajesFallidosPage() {
  const letters = useDeadLetters();
  const reprocess = useReprocessDeadLetter();
  const [status, setStatus] = useState<StatusFilter>("pendiente");
  const [selected, setSelected] = useState<DeadLetter | null>(null);
  const rows = (letters.data ?? []).filter((d) => !status || d.status === status);
  const pending = (letters.data ?? []).filter((d) => d.status === "pendiente").length;

  const columns: Column<DeadLetter>[] = [
    {
      id: "id",
      header: "Mensaje",
      sortValue: (d) => d.id,
      cell: (d) => (
        <div>
          <code className="font-mono text-xs">{d.id}</code>
          <p className="text-xs text-fg-muted">{d.queue}</p>
        </div>
      ),
    },
    { id: "flow", header: "Flujo", sortValue: (d) => d.flow, cell: (d) => d.flow ?? "—" },
    {
      id: "error",
      header: "Error",
      cell: (d) => <p className="max-w-72 text-sm text-fg">{d.error ?? "—"}</p>,
    },
    {
      id: "attempts",
      header: "Intentos",
      align: "right",
      sortValue: (d) => d.attempts,
      cell: (d) => formatNumber(d.attempts),
    },
    {
      id: "first",
      header: "Primer fallo",
      sortValue: (d) => d.firstFailedAt,
      cell: (d) => formatDateTime(d.firstFailedAt),
    },
    {
      id: "status",
      header: "Estado",
      sortValue: (d) => d.status,
      cell: (d) => (
        <div className="space-y-1">
          <StatusBadge kind="deadLetter" status={d.status} testId={`dlq-status-${d.id}`} />
          {d.reprocessedBy && <p className="text-xs text-fg-muted">Por {d.reprocessedBy}</p>}
        </div>
      ),
    },
    {
      id: "payload",
      header: "Contenido (enmascarado)",
      cell: (d) =>
        d.payloadPreview ? (
          <details className="max-w-80">
            <summary className="cursor-pointer text-xs text-accent">Ver contenido</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap text-fg">
              {d.payloadPreview}
            </pre>
          </details>
        ) : (
          "—"
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Acciones</span>,
      printHidden: true,
      cell: (d) =>
        d.status === "pendiente" ? (
          <GuardedButton
            permission="dlq:reprocess:approve"
            size="sm"
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
            onClick={() => setSelected(d)}
            data-testid={`btn-reprocess-${d.id}`}
          >
            Reprocesar
          </GuardedButton>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Mensajes fallidos"
        reference="BT-051"
        description={`Cola de mensajes que Micro Integrator no pudo procesar tras agotar sus reintentos: ${plural(pending, "pendiente", "pendientes")}. El reproceso lo autoriza un aprobador, con motivo, y queda auditado.`}
      />
      <Field id="filtro-dlq" label="Estado" className="mb-3 w-56">
        {(control) => (
          <Select
            {...control}
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            data-testid="dlq-filter-status"
          >
            <option value="">Todos</option>
            <option value="pendiente">Pendientes</option>
            <option value="reprocesado">Reprocesados</option>
            <option value="descartado">Descartados</option>
          </Select>
        )}
      </Field>
      {letters.isError ? (
        <QueryError error={letters.error} onRetry={() => void letters.refetch()} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(d) => d.id ?? `${d.queue}-${d.firstFailedAt}`}
          caption="Mensajes fallidos"
          loading={letters.isLoading}
          testId="table-dead-letters"
          rowTestId={(d) => `dlq-row-${d.id}`}
          initialSort={{ id: "first", direction: "desc" }}
          emptyTitle="No hay mensajes con este estado"
        />
      )}
      <ReasonDialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Reprocesar mensaje"
        description="El mensaje vuelve a la cola de entrada del flujo. La deduplicación por clave evita procesarlo dos veces."
        confirmLabel="Reprocesar"
        minLength={10}
        pending={reprocess.isPending}
        testId="reprocess-dialog"
        onConfirm={(reason) =>
          selected?.id &&
          reprocess.mutate({ id: selected.id, reason }, { onSuccess: () => setSelected(null) })
        }
      >
        {selected && (
          <div className="space-y-1 rounded-md bg-subtle p-3 text-sm">
            <p>
              <span className="text-fg-muted">Mensaje:</span>{" "}
              <code className="font-mono text-xs">{selected.id}</code> ({selected.flow})
            </p>
            <p>
              <span className="text-fg-muted">Error:</span> {selected.error}
            </p>
            <p className="text-xs text-fg-muted">Su nombre y el motivo quedan en la auditoría (BT-031).</p>
          </div>
        )}
      </ReasonDialog>
    </>
  );
}
