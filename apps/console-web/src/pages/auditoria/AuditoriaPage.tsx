import { Download, FlaskConical, Search, ShieldCheck, Undo2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { authorizedFetch } from "../../api/client";
import { describeError } from "../../api/errors";
import { useAuditEvents, useVerifyAudit, type AuditFilters } from "../../api/queries";
import type { AuditEvent } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatusBadge } from "../../components/StatusBadge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Input";
import { DataTable, type Column } from "../../components/ui/Table";
import { toast } from "../../components/ui/toast-store";
import { useRuntime } from "../../config/RuntimeContext";
import { ChainVerificationBanner } from "../../features/audit/ChainVerificationBanner";
import { toCsv } from "../../lib/csv";
import { downloadCsv } from "../../lib/download";
import { fileTimestamp, formatDateTime, shortHash } from "../../lib/format";

interface Draft {
  from: string;
  to: string;
  actor: string;
  action: string;
  limit: string;
}

const EMPTY: Draft = { from: "", to: "", actor: "", action: "", limit: "200" };

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const columns: Column<AuditEvent>[] = [
  {
    id: "seq",
    header: "N.º",
    align: "right",
    sortValue: (e) => e.seq,
    cell: (e) => <span className="tabular">{e.seq ?? "—"}</span>,
  },
  {
    id: "ts",
    header: "Fecha y hora",
    sortValue: (e) => e.ts,
    cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.ts)}</span>,
  },
  {
    id: "actor",
    header: "Actor",
    sortValue: (e) => e.actor,
    cell: (e) => (
      <div>
        <p className="text-fg">{e.actor ?? "—"}</p>
        <p className="text-xs text-fg-muted">{e.actorType === "tecnico" ? "Identidad técnica" : "Usuario"}</p>
      </div>
    ),
  },
  {
    id: "action",
    header: "Acción",
    sortValue: (e) => e.action,
    cell: (e) => (
      <div>
        <code className="font-mono text-xs text-fg">{e.action ?? "—"}</code>
        {e.resource && <p className="font-mono text-xs break-all text-fg-muted">{e.resource}</p>}
      </div>
    ),
  },
  {
    id: "result",
    header: "Resultado",
    sortValue: (e) => e.result,
    cell: (e) => <StatusBadge kind="audit" status={e.result} />,
  },
  {
    id: "ip",
    header: "IP de origen",
    cell: (e) => <span className="font-mono text-xs">{e.sourceIp ?? "—"}</span>,
  },
  {
    id: "hash",
    header: "Hash",
    cell: (e) => (
      <code className="font-mono text-xs text-fg-muted" title={e.hash}>
        {shortHash(e.hash)}
      </code>
    ),
  },
];

export default function AuditoriaPage() {
  const { mock } = useRuntime();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filters, setFilters] = useState<AuditFilters>({ limit: 200 });
  const events = useAuditEvents(filters);
  const verify = useVerifyAudit();
  const [verifiedAt, setVerifiedAt] = useState<string | undefined>(undefined);
  const [tampering, setTampering] = useState(false);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilters({
      from: toIso(draft.from),
      to: toIso(draft.to),
      actor: draft.actor.trim() || undefined,
      action: draft.action.trim() || undefined,
      limit: Number(draft.limit) || 200,
    });
  };

  const runVerify = () =>
    verify.mutate(undefined, {
      onSuccess: () => setVerifiedAt(new Date().toISOString()),
    });

  const exportCsv = () => {
    const rows = events.data ?? [];
    const csv = toCsv(rows, [
      { header: "seq", value: (e) => e.seq },
      { header: "ts", value: (e) => e.ts },
      { header: "fuente", value: (e) => e.source },
      { header: "actor", value: (e) => e.actor },
      { header: "tipo_actor", value: (e) => e.actorType },
      { header: "accion", value: (e) => e.action },
      { header: "recurso", value: (e) => e.resource },
      { header: "resultado", value: (e) => e.result },
      { header: "ip_origen", value: (e) => e.sourceIp },
      { header: "correlacion", value: (e) => e.correlationId },
      { header: "hash_previo", value: (e) => e.prevHash },
      { header: "hash", value: (e) => e.hash },
    ]);
    downloadCsv(`auditoria-${fileTimestamp()}.csv`, csv);
  };

  // Solo en modo simulado: altera o restaura un evento para demostrar la detección (BT-032).
  const mockTool = async (tool: "tamper" | "restore") => {
    setTampering(true);
    try {
      const response = await authorizedFetch(`__mock/audit/${tool}`, { method: "POST" });
      const body = (await response.json()) as { seq?: number; message?: string };
      toast.warning(
        tool === "tamper" ? "Evento alterado (solo modo simulado)" : "Evento restaurado (solo modo simulado)",
        body.message ?? (body.seq ? `Evento número ${body.seq}.` : undefined),
      );
      verify.reset();
      await events.refetch();
    } catch (error) {
      const { title, description } = describeError(error);
      toast.error(title, description);
    } finally {
      setTampering(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Auditoría"
        reference="BT-031 · BT-032"
        description="Eventos de auditoría con identidad, fecha y hora, acción, resultado e IP de origen. Cada evento lleva un número de secuencia y un hash encadenado con el anterior: si alguien altera, borra o reordena un evento, la verificación lo detecta."
        actions={
          <>
            <Button
              icon={<Download className="size-4" aria-hidden="true" />}
              onClick={exportCsv}
              disabled={!events.data?.length}
              data-testid="btn-export-audit"
            >
              Exportar CSV
            </Button>
            <GuardedButton
              permission="audit:verify"
              variant="primary"
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              loading={verify.isPending}
              onClick={runVerify}
              data-testid="btn-verify-audit"
            >
              Verificar integridad
            </GuardedButton>
          </>
        }
      />

      {verify.data && (
        <div className="mb-4">
          <ChainVerificationBanner result={verify.data} verifiedAt={verifiedAt} />
        </div>
      )}

      {mock && (
        <Card
          className="mb-4 border-dashed"
          title="Herramientas del modo simulado"
          description="Disponibles solo con datos simulados, para demostrar que la verificación detecta una alteración."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<FlaskConical className="size-4" aria-hidden="true" />}
              loading={tampering}
              onClick={() => void mockTool("tamper")}
              data-testid="btn-mock-tamper"
            >
              Simular alteración de un evento
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Undo2 className="size-4" aria-hidden="true" />}
              onClick={() => void mockTool("restore")}
              data-testid="btn-mock-restore"
            >
              Restaurar el evento
            </Button>
          </div>
        </Card>
      )}

      <form
        onSubmit={apply}
        className="mb-4 grid gap-3 rounded-lg border border-line bg-surface p-4 md:grid-cols-3 xl:grid-cols-6"
        aria-label="Filtros de auditoría"
      >
        <Field id="audit-from" label="Desde">
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          )}
        </Field>
        <Field id="audit-to" label="Hasta">
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          )}
        </Field>
        <Field id="audit-actor" label="Actor">
          {(control) => (
            <Input
              {...control}
              value={draft.actor}
              onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
              placeholder="usuario o identidad"
              data-testid="audit-filter-actor"
            />
          )}
        </Field>
        <Field id="audit-action" label="Acción">
          {(control) => (
            <Input
              {...control}
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
              placeholder="por ejemplo rollout.approve"
              data-testid="audit-filter-action"
            />
          )}
        </Field>
        <Field id="audit-limit" label="Máximo de eventos">
          {(control) => (
            <Select
              {...control}
              value={draft.limit}
              onChange={(e) => setDraft({ ...draft, limit: e.target.value })}
            >
              <option value="50">50</option>
              <option value="200">200</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
            </Select>
          )}
        </Field>
        <div className="flex items-end gap-2">
          <Button
            type="submit"
            variant="primary"
            icon={<Search className="size-4" aria-hidden="true" />}
            data-testid="btn-apply-audit-filters"
          >
            Buscar
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY);
              setFilters({ limit: 200 });
            }}
          >
            Limpiar
          </Button>
        </div>
      </form>

      {events.isError ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <DataTable
          rows={events.data}
          columns={columns}
          rowKey={(e) => e.id ?? String(e.seq)}
          caption="Eventos de auditoría"
          loading={events.isLoading}
          testId="table-audit"
          rowTestId={(e) => `audit-row-${e.seq}`}
          initialSort={{ id: "seq", direction: "desc" }}
          emptyTitle="No hay eventos que coincidan con los filtros"
        />
      )}
    </>
  );
}
