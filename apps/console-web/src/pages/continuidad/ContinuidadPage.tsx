import { useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Clock,
  FlaskConical,
  LoaderCircle,
  Play,
  Send,
  Server,
  Undo2,
  Vote,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  keys,
  useApproveFailback,
  useContinuity,
  useFailoverEvents,
  useRefreshWhenFinished,
  useRejectFailback,
  useRequestFailback,
  useStartDrill,
} from "../../api/queries";
import { authorizedFetch } from "../../api/client";
import { describeError } from "../../api/errors";
import type { FailbackRequest, FailoverEvent, SiteHealth } from "../../api/types";
import { useSession } from "../../auth/session";
import { GuardedButton } from "../../components/GuardedButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryError } from "../../components/QueryError";
import { ReasonDialog } from "../../components/ReasonDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/toast-store";
import { useRuntime } from "../../config/RuntimeContext";
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
            {event.requestedBy ? ` · Solicitó ${event.requestedBy}` : ""}
            {event.approvedBy ? ` · Aprobó ${event.approvedBy}` : ""}
          </p>
        </div>
        <StatusBadge kind="job" status={event.status} testId={`failover-status-${event.id}`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone={rtoTone(event.rtoSeconds, rtoObjetivoMin)} data-testid={`failover-rto-${event.id}`}>
          RTO medido{" "}
          {event.rtoSeconds !== undefined
            ? formatDuration(event.rtoSeconds)
            : live
              ? "en medición"
              : "no registrado"}
          {rtoObjetivoMin !== undefined ? ` · objetivo ${rtoObjetivoMin} min` : ""}
        </Badge>
        {/* El agente registra el rezago de replicación en bytes de WAL (en los pasos), no el RPO en tiempo. */}
        <Badge tone="neutral" data-testid={`failover-rpo-${event.id}`}>
          RPO: no medido
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

function PendingFailbackCard({ request, now }: { request: FailbackRequest; now: number }) {
  return (
    <section
      aria-label="Solicitud de retorno pendiente"
      className="mb-6 rounded-lg border border-warn/40 bg-surface p-4"
      data-testid="pending-failback"
    >
      <p className="text-sm font-semibold text-fg">
        Retorno al sitio principal solicitado por {request.requestedBy}
      </p>
      <p className="mt-1 text-xs text-fg-muted">
        {request.fromSite} → {request.toSite} · Solicitado{" "}
        <time dateTime={request.requestedAt}>{formatRelative(request.requestedAt, now)}</time> · Vence{" "}
        <time dateTime={request.expiresAt} data-testid="pending-failback-expires">
          {formatDateTime(request.expiresAt)}
        </time>
      </p>
      <p className="mt-2 text-sm text-fg">Motivo: {request.reason}</p>
      <p className="mt-2 text-xs text-fg-muted">
        Debe aprobarlo otra persona con el rol aprobador. Si nadie lo aprueba antes del vencimiento, la
        solicitud vence y hay que pedirla de nuevo.
      </p>
    </section>
  );
}

export default function ContinuidadPage() {
  const events = useFailoverEvents();
  const anyLive = (events.data ?? []).some((e) => e.status === "en_curso");
  const state = useContinuity(anyLive);
  useRefreshWhenFinished(anyLive, keys.continuityAll, keys.overview);
  const session = useSession();
  const drill = useStartDrill();
  const requestFailback = useRequestFailback();
  const approveFailback = useApproveFailback();
  const rejectFailback = useRejectFailback();
  const now = useNow();
  const [failbackDialog, setFailbackDialog] = useState<"solicitar" | "aprobar" | "rechazar" | null>(null);
  const { mock } = useRuntime();
  const queryClient = useQueryClient();
  const [simulating, setSimulating] = useState(false);

  // Solo en modo simulado: provoca la caída del sitio principal para que los agentes conmuten (demo).
  const simulateOutage = async () => {
    setSimulating(true);
    try {
      await authorizedFetch("__mock/continuity/outage", { method: "POST" });
      toast.warning(
        "Caída del sitio principal simulada (solo modo simulado)",
        "Los agentes votan y, con quórum, conmutan al sitio de respaldo.",
      );
      await queryClient.invalidateQueries({ queryKey: keys.continuityAll });
    } catch (error) {
      const { title, description } = describeError(error);
      toast.error(title, description);
    } finally {
      setSimulating(false);
    }
  };

  const s = state.data;
  const primary = s?.sites?.find((site) => site.role === "primario");
  const activeSite = s?.sites?.find((site) => site.id === s.activeSite);
  const onPrimary = !primary || s?.activeSite === primary.id;
  const healthyVotes = (s?.sites ?? []).filter((site) => site.vote === "primario_sano").length;
  const downVotes = (s?.sites ?? []).filter((site) => site.vote === "primario_caido").length;
  const pendingFailback = s?.pendingFailback;
  const requestedBySelf = pendingFailback ? session.isSelf(pendingFailback.requestedBy) : false;
  const closeFailback = () => setFailbackDialog(null);
  const sortedEvents = [...(events.data ?? [])].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );

  return (
    <>
      <PageHeader
        title="Continuidad operacional"
        reference="D-05 · BT-036"
        description="Agentes en el CPD, en Google Cloud y en un sitio testigo votan la salud del sitio principal. Se conmuta solo si 2 de 3 votos coinciden (evita que ambos sitios queden activos). El retorno lo solicita una persona y lo aprueba otra."
        actions={
          <>
            <GuardedButton
              permission="continuity:drill"
              icon={<Play className="size-4" aria-hidden="true" />}
              blockedReason={
                anyLive
                  ? "Hay una conmutación o simulacro en curso."
                  : !onPrimary
                    ? "El sitio principal no está activo: primero se solicita y se aprueba el retorno."
                    : null
              }
              loading={drill.isPending}
              onClick={() => drill.mutate()}
              data-testid="btn-start-drill"
            >
              Iniciar simulacro
            </GuardedButton>
            {pendingFailback ? (
              <>
                <GuardedButton
                  permission="continuity:failback:approve"
                  icon={<X className="size-4" aria-hidden="true" />}
                  onClick={() => setFailbackDialog("rechazar")}
                  data-testid="btn-reject-failback"
                >
                  Rechazar retorno
                </GuardedButton>
                <GuardedButton
                  permission="continuity:failback:approve"
                  variant="primary"
                  icon={<Undo2 className="size-4" aria-hidden="true" />}
                  blockedReason={
                    requestedBySelf
                      ? "Regla de cuatro ojos: usted solicitó este retorno; debe aprobarlo otra persona."
                      : anyLive
                        ? "Espere a que termine la operación en curso."
                        : null
                  }
                  onClick={() => setFailbackDialog("aprobar")}
                  data-testid="btn-approve-failback"
                >
                  Aprobar retorno
                </GuardedButton>
              </>
            ) : (
              <GuardedButton
                permission="continuity:failback:request"
                variant="primary"
                icon={<Send className="size-4" aria-hidden="true" />}
                blockedReason={
                  onPrimary
                    ? "El sitio principal ya está activo: no hay retorno que solicitar."
                    : anyLive
                      ? "Espere a que termine la operación en curso."
                      : null
                }
                onClick={() => setFailbackDialog("solicitar")}
                data-testid="btn-request-failback"
              >
                Solicitar retorno
              </GuardedButton>
            )}
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
                  {pendingFailback
                    ? "Operando en el sitio de respaldo. Retorno solicitado, falta la aprobación."
                    : "Operando en el sitio de respaldo. El retorno no se ha solicitado."}
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
              <p className="mt-1 text-xs text-fg-muted">
                Cada conmutación registra el RTO medido. El RPO no se mide en esta versión: se registra el
                rezago de replicación (bytes de WAL sin aplicar) en los pasos.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium text-fg-muted">Modo de conmutación</p>
              <p className="mt-1 text-xl font-semibold text-fg" data-testid="continuity-mode">
                {s.mode === "automatico" ? "Automático" : "Manual"}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                {s.mode === "automatico"
                  ? "El agente del sitio de respaldo conmuta solo cuando 2 de 3 votos indican que el primario cayó."
                  : "Los agentes votan y la Consola muestra el quórum, pero no conmutan solos."}{" "}
                Lo fija NEXO_CONTINUITY_AUTOMATICO en la instalación de los agentes; la Consola solo lo
                muestra.
              </p>
            </div>
          </section>

          {pendingFailback && <PendingFailbackCard request={pendingFailback} now={now} />}

          {mock && (
            <Card
              className="mb-6 border-dashed"
              title="Herramientas del modo simulado"
              description="Disponibles solo con datos simulados. En una instalación, la conmutación automática la deciden los agentes de continuidad con quórum de 2 de 3."
            >
              <Button
                size="sm"
                icon={<FlaskConical className="size-4" aria-hidden="true" />}
                loading={simulating}
                disabled={!onPrimary || anyLive}
                onClick={() => void simulateOutage()}
                data-testid="btn-mock-outage"
              >
                Simular la caída del sitio principal
              </Button>
            </Card>
          )}

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

      <ReasonDialog
        open={failbackDialog === "solicitar"}
        onClose={closeFailback}
        title="Solicitar el retorno al sitio principal"
        description={
          <>
            <span className="block">
              El retorno reapunta el DNS al sitio principal y fija el sitio activo; no copia datos ni promueve
              bases. Antes de solicitarlo, el operador confirma que la base del sitio principal tiene los
              cambios hechos en el respaldo (la reconstruye desde el respaldo con pg_basebackup, según el
              procedimiento del motor de base de datos). Después del retorno reconstruye la réplica del
              respaldo desde el primario: hasta entonces el paso «Re-sincronizar la réplica» queda pendiente.
            </span>
            <span className="mt-2 block">
              La solicitud la aprueba otra persona con el rol aprobador y vence si nadie la aprueba a tiempo.
            </span>
          </>
        }
        confirmLabel="Solicitar retorno"
        minLength={5}
        pending={requestFailback.isPending}
        testId="failback-request-dialog"
        onConfirm={(reason) => requestFailback.mutate(reason, { onSuccess: closeFailback })}
      />

      <ReasonDialog
        open={failbackDialog === "aprobar" && Boolean(pendingFailback)}
        onClose={closeFailback}
        title="Aprobar el retorno al sitio principal"
        description={
          pendingFailback
            ? `Solicitado por ${pendingFailback.requestedBy}: «${pendingFailback.reason}». Al aprobar, los agentes de continuidad reapuntan el tráfico al sitio principal. La solicitud y la aprobación quedan en la auditoría.`
            : undefined
        }
        confirmLabel="Aprobar retorno"
        minLength={0}
        pending={approveFailback.isPending}
        testId="failback-dialog"
        onConfirm={(reason) =>
          pendingFailback &&
          approveFailback.mutate(
            { id: pendingFailback.id, reason: reason || undefined },
            { onSuccess: closeFailback },
          )
        }
      />

      <ReasonDialog
        open={failbackDialog === "rechazar" && Boolean(pendingFailback)}
        onClose={closeFailback}
        title="Rechazar la solicitud de retorno"
        description="La solicitud queda rechazada y el tráfico sigue en el sitio de respaldo. El motivo queda en la auditoría."
        confirmLabel="Rechazar"
        confirmVariant="danger"
        minLength={5}
        pending={rejectFailback.isPending}
        testId="failback-reject-dialog"
        onConfirm={(reason) =>
          pendingFailback &&
          rejectFailback.mutate({ id: pendingFailback.id, reason }, { onSuccess: closeFailback })
        }
      />
    </>
  );
}
