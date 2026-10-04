import { Download, PackageOpen } from "lucide-react";
import { useState } from "react";
import { authorizedFetch } from "../../api/client";
import { describeError } from "../../api/errors";
import { useCreateExport, useExportJob } from "../../api/queries";
import type { ExportJob } from "../../api/types";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { StatusBadge } from "../../components/StatusBadge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { DataTable, type Column } from "../../components/ui/Table";
import { toast } from "../../components/ui/toast-store";
import { downloadBlob } from "../../lib/download";
import { formatDateTime } from "../../lib/format";

type ManifestItem = NonNullable<NonNullable<ExportJob["manifest"]>["items"]>[number];

const STORAGE_KEY = "nexo-exportaciones";

function readHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeHistory(ids: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, 10)));
  } catch {
    // Sin almacenamiento: el historial dura lo que dure la página.
  }
}

const itemColumns: Column<ManifestItem>[] = [
  { id: "tipo", header: "Tipo", sortValue: (i) => i.tipo, cell: (i) => i.tipo ?? "—" },
  { id: "nombre", header: "Nombre", sortValue: (i) => i.nombre, cell: (i) => i.nombre ?? "—" },
  {
    id: "archivo",
    header: "Archivo",
    cell: (i) => <code className="font-mono text-xs break-all">{i.archivo ?? "—"}</code>,
  },
  {
    id: "sha256",
    header: "SHA-256",
    cell: (i) => (
      <code className="block max-w-[22rem] font-mono text-[11px] break-all text-fg-muted">
        {i.sha256 ?? "—"}
      </code>
    ),
  },
];

function filenameFrom(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

export default function ExportacionPage() {
  const create = useCreateExport();
  const [history, setHistory] = useState<string[]>(readHistory);
  const [currentId, setCurrentId] = useState<string | null>(() => readHistory()[0] ?? null);
  const job = useExportJob(currentId);
  const [downloading, setDownloading] = useState(false);

  const start = () =>
    create.mutate(undefined, {
      onSuccess: (created) => {
        if (!created.id) return;
        const next = [created.id, ...history.filter((h) => h !== created.id)];
        setHistory(next);
        writeHistory(next);
        setCurrentId(created.id);
      },
    });

  const download = async (data: ExportJob) => {
    if (!data.downloadUrl) return;
    setDownloading(true);
    try {
      const response = await authorizedFetch(data.downloadUrl);
      const blob = await response.blob();
      downloadBlob(filenameFrom(response, `nexo-export-${data.id ?? "paquete"}.json`), blob);
    } catch (error) {
      const { title, description } = describeError(error);
      toast.error(title, description);
    } finally {
      setDownloading(false);
    }
  };

  const data = job.data;

  return (
    <>
      <PageHeader
        title="Exportación"
        reference="BT-049 · BT-060"
        description="Genera un paquete con las APIs, contratos, políticas, flujos y metadatos de la plataforma, con un manifiesto de versiones y huellas SHA-256 para verificar su integridad. Es la base del plan de salida y de la reconstrucción automática."
        actions={
          <GuardedButton
            permission="export:create"
            variant="primary"
            icon={<PackageOpen className="size-4" aria-hidden="true" />}
            loading={create.isPending}
            onClick={start}
            data-testid="btn-create-export"
          >
            Generar paquete
          </GuardedButton>
        }
      />

      {!currentId ? (
        <EmptyState
          icon={<PackageOpen className="size-7" />}
          title="Aún no ha generado paquetes en esta sesión"
          description="El paquete se arma en segundo plano; esta página muestra el avance y el manifiesto cuando esté listo."
        />
      ) : job.isError ? (
        <QueryError error={job.error} onRetry={() => void job.refetch()} />
      ) : (
        <Card
          title={`Paquete ${currentId}`}
          description={data?.createdAt ? `Solicitado el ${formatDateTime(data.createdAt)}` : undefined}
          actions={
            data?.status === "listo" && data.downloadUrl ? (
              <Button
                variant="primary"
                icon={<Download className="size-4" aria-hidden="true" />}
                loading={downloading}
                onClick={() => void download(data)}
                data-testid="btn-download-export"
              >
                Descargar paquete
              </Button>
            ) : undefined
          }
          data-testid="export-job"
        >
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <StatusBadge kind="job" status={data?.status ?? "en_curso"} testId="export-status" />
            {data?.manifest?.version && (
              <span className="text-sm text-fg-muted">Manifiesto versión {data.manifest.version}</span>
            )}
            {data?.status === "en_curso" && (
              <span className="text-sm text-fg-muted">Revisando el avance cada 2 segundos…</span>
            )}
          </div>
          {data?.status === "listo" && (
            <DataTable
              rows={data.manifest?.items ?? []}
              columns={itemColumns}
              rowKey={(i) => `${i.tipo}-${i.archivo}`}
              caption="Manifiesto del paquete exportado"
              testId="table-export-manifest"
              emptyTitle="El manifiesto no tiene elementos"
            />
          )}
          {data?.status === "fallido" && (
            <p className="text-sm text-bad">
              La exportación falló. Revise los registros de la API y vuelva a intentarlo.
            </p>
          )}
        </Card>
      )}

      {history.length > 1 && (
        <Card title="Paquetes de esta sesión" className="mt-6">
          <ul className="flex flex-wrap gap-2">
            {history.map((id) => (
              <li key={id}>
                <Button
                  size="sm"
                  variant={id === currentId ? "primary" : "secondary"}
                  onClick={() => setCurrentId(id)}
                >
                  {id}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
