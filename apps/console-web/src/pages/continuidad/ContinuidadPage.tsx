import { CircleCheck, CircleX, Clock, LoaderCircle, Play, Server, ShieldCheck, Undo2, Vote } from "lucide-react";
import { useState } from "react";
import {
  keys,
  useApproveFailback,
  useContinuity,
  useFailoverEvents,
  useRefreshWhenFinished,
  useSetContinuityMode,
  useStartDrill,
} from "../../api/queries";
import type { ContinuityMode, FailoverEvent, SiteHealth } from "../../api/types";
import { requiredPermissionText } from "../../auth/permissions";
import { useSession } from "../../auth/session";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { ReasonDialog } from "../../components/ReasonDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/Input";
import { Skeleton } from "../../components/ui/Skeleton";
import { formatDateTime, formatDuration, formatRelative, formatTime } from "../../lib/format";
import {
  CHECK_LABELS,
  FAILOVER_KIND_LABELS,
  FAILOVER_TRIGGER_LABELS,
  SITE_ROLE_LABELS,
  VOTE_LABELS,
  labelOf,
} from "../../lib/labels";
import { useNow } from "../../lib/useNow";

const VOTE_TONE: Record<string, BadgeTone> = {
  primario_sano: "ok",
  primario_caido: "bad",
  sin_voto: "neutral",
};

function SiteCard({ site, active, now }: { site: SiteHealth; active: boolean; now: number }) {
  const checks = Object.entries(site.checks ?? {}) as Array<[keyof typeof CHECK_LABELS, string | undefined]>;
  return (
    <Card data-testid={`continuity-site-${site.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">
            {labelOf(SITE_ROLE_LABELS, site.role)}
          </p>
          <h2 className="text-sm font-semibold text-fg">{site.name ?? site.id}</h2>
        </div>
        <Server className="size-5 text-fg-subtle" aria-hidden="true" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {active && (
          <Badge tone="accent" data-testid={`site-active-${site.id}`}>
            Sitio activo
          </Badge>
        )}
        <Badge
          tone={VOTE_TONE[site.vote ?? "sin_voto"] ?? "neutral"}
          icon={<Vote className="size-3.5" aria-hidden="true" />}
          data-testid={`site-vote-${site.id}`}
          data-vote={site.vote}
        >
          Voto: {labelOf(VOTE_LABELS, site.vote)}
        </Badge>
      </div>
      <ul className="mt-3 space-y-1.5">
        {checks.map(([key, status]) => (
          <li key={key} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-fg-muted">{CHECK_LABELS[key] ?? key}</span>
            <StatusBadge kind="check" status={status} testId={`check-${site.id}-${key}`} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-fg-subtle">
        Último reporte: <time dateTime={site.lastSeen}>{formatRelative(site.lastSeen, now)}</time>
      </p>
    </Card>
  );
}

function rtoTone(seconds: number | undefined, objectiveMin: number | undefined): BadgeTone {
  if (seconds === undefined || objectiveMin === undefined) return "neutral";
  return seconds <= objectiveMin * 60 ? "ok" : "bad";
}

function StepIcon({ status }: { status?: string }) {
  if (status === "ok" || status === "completado")
    return <CircleCheck className="size-4 text-ok" aria-hidden="true" />;
  if (status === "fallido" || status === "falla")
    return <CircleX className="size-4 text-bad" aria-hidden="true" />;
  if (status === "pendiente") return <Clock className="size-4 text-warn" aria-label="Pendiente" />;
  return <LoaderCircle className="size-4 text-accent motion-safe:animate-spin" aria-hidden="true" />;
}

function EventCard({
  event,
  rtoObjetivoMin,
  rpoObjetivoMin,
}: {
  event: FailoverEvent;
  rtoObjetivoMin?: number;
  rpoObjetivoMin?: number;
}) {
  const live = event.status === "en_curso";
  return (
    <li className="rounded-lg border border-line bg-surface p-4" data-testid={`failover-event-${event.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-fg">
            {labelOf(FAILOVER_KIND_LABELS, event.kind)}: {event.from ?? "—"} → {event.to ?? "—"}
          </h3>
          <p className="text-xs text-fg-muted">
            {labelOf(FAILOVER_TRIGGER_LABELS, event.trigger)} · Inicio {formatDateTime(event.startedAt)}
            {event.finishedAt ? ` · Término ${formatDateTime(event.finishedAt)}` : ""}
            {event.approvedBy ? ` · Aprobó ${event.approvedBy}` : ""}
          </p>
        </div>
        <StatusBadge kind="job" status={event.status} testId={`failover-status-${event.id}`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone={rtoTone(event.rtoSeconds, rtoObjetivoMin)} data-testid={`failover-rto-${event.id}`}>
          RTO medido{" "}
          {event.rtoSeconds !== undefined ? formatDuration(event.rtoSeconds) : live ? "en medición" : "no registrado"}
          {rtoObjetivoMin !== undefined ? ` · objetivo ${rtoObjetivoMin} min` : ""}
        </Badge>
        <Badge tone={rtoTone(event.rpoSecondsEstimated, rpoObjetivoMin)}>
          RPO estimado{" "}
          {event.rpoSecondsEstimated !== undefined ? formatDuration(event.rpoSecondsEstimated) : "—"}
          {rpoObjetivoMin !== undefined ? ` · objetivo ${rpoObjetivoMin} min` : ""}
        </Badge>
      </div>
      {(event.steps?.length ?? 0) > 0 && (
        <ol
          className="mt-3 space-y-1.5"
          aria-live={live ? "polite" : undefined}
          data-testid={`failover-steps-${event.id}`}
        >
          {(event.steps ?? []).map((step, index) => (
            <li key={`${step.name}-${index}`} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5">
                <StepIcon status={step.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-fg">{step.name}</span>
                {step.detail && <span className="block text-xs text-fg-muted">{step.detail}</span>}
              </span>
              <time className="shrink-0 text-xs text-fg-subtle tabular" dateTime={step.ts}>
                {formatTime(step.ts)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export default function ContinuidadPage() {
  const events = useFailoverEvents();
  const anyLive = (events.data ?? []).some((e) => e.status === "en_curso");
  const state = useContinuity(anyLive);
  useRefreshWhenFinished(anyLive, keys.continuityAll, keys.overview);
  const session = useSession();
  const setMode = useSetContinuityMode();
  const drill = useStartDrill();
  const failback = useApproveFailback();
  const now = useNow();
  const [pendingMode, setPendingMode] = useState<ContinuityMode | null>(null);
  const [failbackOpen, setFailbackOpen] = useState(false);

  const s = state.data;
  const primary = s?.sites?.find((site) => site.role === "primario");
  const activeSite = s?.sites?.find((site) => site.id === s.activeSite);
  const onPrimary = !primary || s?.activeSite === primary.id;
  const healthyVotes = (s?.sites ?? []).filter((site) => site.vote === "primario_sano").length;
  const downVotes = (s?.sites ?? []).filter((site) => site.vote === "primario_caido").length;
  const canWriteMode = session.can("admin:settings:write");
  const sortedEvents = [...(events.data ?? [])].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );

  return (
    <>
      <PageHeader
        title="Continuidad operacional"
        reference="D-05 · BT-036"
        description="Agentes en el CPD, en Google Cloud y en un sitio testigo votan la salud del sitio principal. Se conmuta solo si 2 de 3 votos coinciden (evita que ambos sitios queden activos). El retorno es guiado y requiere aprobación."
        actions={
          <>
            <GuardedButton
              permission="continuity:drill"
              icon={<Play className="size-4" aria-hidden="true" />}
              blockedReason={
                anyLive
                  ? "Hay una conmutación o simulacro en curso."
                  : !onPrimary
                    ? "El sitio principal no está activo: primero apruebe el retorno."
                    : null
              }
              loading={drill.isPending}
              onClick={() => drill.mutate()}
              data-testid="btn-start-drill"
            >
              Iniciar simulacro
            </GuardedButton>
            <GuardedButton
              permission="continuity:failback:approve"
              variant="primary"
              icon={<Undo2 className="size-4" aria-hidden="true" />}
              blockedReason={
                onPrimary
                  ? "El sitio principal ya está activo: no hay retorno pendiente."
                  : anyLive
                    ? "Espere a que termine la operación en curso."
                    : null
              }
              onClick={() => setFailbackOpen(true)}
              data-testid="btn-approve-failback"
            >
              Aprobar retorno
            </GuardedButton>
          </>
        }
      />

      {state.isError ? (
        <QueryError error={state.error} onRetry={() => void state.refetch()} />
      ) : state.isLoading || !s ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <>
          <section aria-label="Resumen de continuidad" className="mb-6 grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-line bg-surface p-4" data-testid="active-site">
              <p className="text-xs font-medium text-fg-muted">Sitio activo</p>
              <p className="mt-1 text-xl font-semibold text-fg">{activeSite?.name ?? s.activeSite ?? "—"}</p>
              {!onPrimary && (
                <p className="mt-1 text-xs font-medium text-warn">
                  Operando en el sitio de respaldo. Retorno pendiente.
                </p>
              )}
            </div>
            <div className="rounded-lg border border-line bg-surface p-4" data-testid="quorum">
              <p className="text-xs font-medium text-fg-muted">Quórum</p>
              <p className="mt-1 text-xl font-semibold text-fg">{s.quorum ?? "2 de 3"}</p>
              <p className="mt-1 text-xs text-fg-muted">
                {healthyVotes} {healthyVotes === 1 ? "voto" : "votos"} «primario sano» · {downVotes} «primario
                caído»
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium text-fg-muted">Objetivos</p>
              <p className="mt-1 text-sm text-fg">
                RTO {s.rtoObjetivoMin ?? "—"} min · RPO {s.rpoObjetivoMin ?? "—"} min
              </p>
              <p className="mt-1 text-xs text-fg-muted">Cada conmutación registra el RTO y el RPO medidos.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="mb-2 text-xs font-medium text-fg-muted" id="modo-label">
                Modo de conmutación
              </p>
              <SegmentedControl<ContinuityMode>
                name="continuity-mode"
                label="Modo de conmutación"
                value={s.mode ?? "manual"}
                options={[
                  { value: "manual", label: "Manual" },
                  { value: "automatico", label: "Automático" },
                ]}
                onChange={(mode) => setPendingMode(mode)}
                disabled={!canWriteMode || setMode.isPending}
                describedBy="modo-ayuda"
                testId="continuity-mode"
              />
              <p id="modo-ayuda" className="mt-1.5 text-xs text-fg-muted">
                {canWriteMode
                  ? "Manual (BT-036) y automático (D-05) usan el mismo procedimiento."
                  : requiredPermissionText(["admin:settings:write"])}
              </p>
            </div>
          </section>

          <div className="mb-6 grid gap-4 md:grid-cols-3">
            {(s.sites ?? []).map((site) => (
              <SiteCard key={site.id} site={site} active={site.id === s.activeSite} now={now} />
            ))}
          </div>
        </>
      )}

      <h2 className="mb-3 text-base font-semibold text-fg">Historial de conmutaciones y simulacros</h2>
      {events.isError ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} />
      ) : events.isLoading ? (
        <Skeleton className="h-40" />
      ) : sortedEvents.length === 0 ? (
        <EmptyState title="Sin conmutaciones registradas" />
      ) : (
        <ol className="space-y-3" data-testid="failover-events">
          {sortedEvents.map((event) => (
            <EventCard
              key={event.id ?? event.startedAt}
              event={event}
              rtoObjetivoMin={s?.rtoObjetivoMin}
              rpoObjetivoMin={s?.rpoObjetivoMin}
            />
          ))}
        </ol>
      )}

      <Dialog
        open={pendingMode !== null}
        onClose={() => setPendingMode(null)}
        title={pendingMode === "automatico" ? "Activar el modo automático" : "Activar el modo manual"}
        description={
          pendingMode === "automatico"
            ? "Con el modo automático, Nexo conmuta al sitio de respaldo sin intervención cuando 2 de 3 votos indican que el primario cayó."
            : "Con el modo manual, la conmutación requiere que un operador la ejecute siguiendo el procedimiento."
        }
        testId="mode-dialog"
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setPendingMode(null)}>Cancelar</Button>
          <Button
            variant="primary"
            icon={<ShieldCheck className="size-4" aria-hidden="true" />}
            loading={setMode.isPending}
            onClick={() =>
              pendingMode && setMode.mutate(pendingMode, { onSuccess: () => setPendingMode(null) })
            }
            data-testid="btn-confirm-mode"
          >
            Confirmar
          </Button>
        </div>
      </Dialog>

      <ReasonDialog
        open={failbackOpen}
        onClose={() => setFailbackOpen(false)}
        title="Aprobar el retorno al sitio principal"
        description="Se sincronizan los datos, se congela la escritura en el respaldo y se devuelve el tráfico al CPD. Quien inició la conmutación no puede aprobar el retorno."
        confirmLabel="Aprobar retorno"
        minLength={10}
        pending={failback.isPending}
        testId="failback-dialog"
        onConfirm={(reason) => failback.mutate(reason, { onSuccess: () => setFailbackOpen(false) })}
      />
    </>
  );
}
