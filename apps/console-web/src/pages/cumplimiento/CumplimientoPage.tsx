import {
  FOUR_EYES_ACTIONS,
  permissionMatrix,
  ROLE_DESCRIPTIONS,
  ROLES,
  type Role,
} from "@nexo/shared/browser";
import { Check, Info, Minus, Printer } from "lucide-react";
import { useMemo } from "react";
import { useRoleMatrix, useTlsChannels } from "../../api/queries";
import type { TlsChannel } from "../../api/types";
import { permissionLabel, roleLabel } from "../../auth/permissions";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  DataTable,
  Table,
  TableContainer,
  TBody,
  Td,
  Th,
  THead,
  type Column,
} from "../../components/ui/Table";
import { useRuntime } from "../../config/RuntimeContext";
import { formatDateTime } from "../../lib/format";
import { useNow } from "../../lib/useNow";

interface MatrixRow {
  permission: string;
  grants: Record<Role, boolean>;
}

const truthy = (v: unknown) =>
  v === true || v === 1 || (typeof v === "string" && /^(true|s[ií]|x|1)$/i.test(v.trim()));

/** Acepta la forma de permissionMatrix() y variantes razonables (permiso/permission/key). */
export function normalizeMatrix(rows: ReadonlyArray<Record<string, unknown>>): MatrixRow[] {
  const result: MatrixRow[] = [];
  for (const row of rows) {
    const key = row.permission ?? row.permiso ?? row.key;
    if (typeof key !== "string") continue;
    const grants = Object.fromEntries(ROLES.map((role) => [role, truthy(row[role])])) as Record<
      Role,
      boolean
    >;
    result.push({ permission: key, grants });
  }
  return result;
}

const tlsColumns: Column<TlsChannel>[] = [
  {
    id: "canal",
    header: "Canal",
    sortValue: (c) => c.canal,
    cell: (c) => <span className="font-medium text-fg">{c.canal ?? "—"}</span>,
  },
  { id: "origen", header: "Origen", cell: (c) => c.origen ?? "—" },
  { id: "destino", header: "Destino", cell: (c) => c.destino ?? "—" },
  { id: "protocolo", header: "Protocolo", cell: (c) => c.protocolo ?? "—" },
  {
    id: "versiones",
    header: "Versiones",
    cell: (c) => (
      <div className="flex flex-wrap gap-1">
        {(c.versiones ?? []).map((v) => (
          <Badge key={v} tone={/1\.[01]$|ssl/i.test(v) ? "bad" : "neutral"}>
            {v}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: "cifrado",
    header: "Cifrado",
    cell: (c) => <span className="font-mono text-xs break-all">{c.cifrado ?? "—"}</span>,
  },
  {
    id: "verificado",
    header: "Verificado",
    sortValue: (c) => c.verificado,
    cell: (c) => formatDateTime(c.verificado),
  },
];

export default function CumplimientoPage() {
  const { config } = useRuntime();
  const matrix = useRoleMatrix();
  const tls = useTlsChannels();
  const now = useNow();

  const fromApi = useMemo(() => (matrix.data ? normalizeMatrix(matrix.data) : []), [matrix.data]);
  const fallback = matrix.isError || (matrix.isSuccess && fromApi.length === 0);
  const rows = useMemo(
    () =>
      fallback ? normalizeMatrix(permissionMatrix() as unknown as Array<Record<string, unknown>>) : fromApi,
    [fallback, fromApi],
  );

  return (
    <>
      <div className="hidden print:block">
        <p className="text-lg font-semibold">Consola Nexo · Matrices de cumplimiento</p>
        <p className="mb-4 text-sm">
          {config.environmentLabel} · Nexo {config.version} · Generado el {formatDateTime(now)}
        </p>
      </div>
      <PageHeader
        title="Cumplimiento"
        reference="BT-026 · BT-028"
        description="Matrices generadas desde la configuración vigente: permisos por rol (mínimo privilegio y segregación de funciones) y canales cifrados observados."
        actions={
          <Button
            icon={<Printer className="size-4" aria-hidden="true" />}
            onClick={() => window.print()}
            data-testid="btn-print-compliance"
          >
            Imprimir
          </Button>
        }
      />

      <Card
        title="Matriz rol-permiso"
        description="Cada acción de la Consola y de la API se autoriza con esta matriz. Toda acción rechazada queda auditada."
        className="mb-6 break-inside-avoid"
        flush
      >
        {fallback && (
          <p
            className="flex items-start gap-2 border-b border-line bg-warn-soft px-4 py-2 text-sm text-fg"
            data-testid="matrix-fallback"
          >
            <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
            La API no entregó la matriz; se muestra la definida en el código de Nexo (@nexo/shared), que es la
            misma que aplica la API.
          </p>
        )}
        {matrix.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-64" />
          </div>
        ) : (
          <TableContainer className="rounded-none border-0">
            <Table caption="Matriz de permisos por rol" data-testid="table-role-matrix">
              <THead>
                <tr>
                  <Th>Permiso</Th>
                  {ROLES.map((role) => (
                    <Th key={role} className="text-center">
                      {roleLabel(role)}
                    </Th>
                  ))}
                </tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <tr key={row.permission}>
                    <Th scope="row" className="font-normal">
                      <span className="block text-sm text-fg">{permissionLabel(row.permission)}</span>
                      <code className="font-mono text-xs text-fg-muted">{row.permission}</code>
                    </Th>
                    {ROLES.map((role) => (
                      <Td key={role} className="text-center">
                        {row.grants[role] ? (
                          <Check className="mx-auto size-4 text-ok" aria-label="Sí" />
                        ) : (
                          <Minus className="mx-auto size-4 text-fg-subtle" aria-label="No" />
                        )}
                      </Td>
                    ))}
                  </tr>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="Roles" className="break-inside-avoid">
          <dl className="space-y-2.5">
            {ROLES.map((role) => (
              <div key={role}>
                <dt className="text-sm font-semibold text-fg">{roleLabel(role)}</dt>
                <dd className="text-sm text-fg-muted">{ROLE_DESCRIPTIONS[role]}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Acciones con regla de cuatro ojos" className="break-inside-avoid">
          <p className="mb-2 text-sm text-fg-muted">
            Quien inicia la acción no puede aprobarla. La API lo verifica en cada solicitud.
          </p>
          <ul className="space-y-1.5">
            {FOUR_EYES_ACTIONS.map((p) => (
              <li key={p} className="text-sm">
                <span className="text-fg">{permissionLabel(p)}</span>{" "}
                <code className="font-mono text-xs text-fg-muted">{p}</code>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <h2 className="mb-3 text-base font-semibold text-fg">Canales cifrados (TLS) observados</h2>
      {tls.isError ? (
        <QueryError error={tls.error} onRetry={() => void tls.refetch()} />
      ) : (
        <DataTable
          rows={tls.data}
          columns={tlsColumns}
          rowKey={(c) => `${c.canal}-${c.origen}-${c.destino}`}
          caption="Matriz de canales y configuración criptográfica"
          loading={tls.isLoading}
          testId="table-tls"
          emptyTitle="Sin canales registrados"
        />
      )}
    </>
  );
}
