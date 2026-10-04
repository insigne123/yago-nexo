import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleMinus,
  CircleX,
  Clock,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";

interface StatusSpec {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
  spin?: boolean;
}

const S = (label: string, tone: BadgeTone, icon: LucideIcon, spin = false): StatusSpec => ({
  label,
  tone,
  icon,
  spin,
});

/** Diccionarios de estados del contrato con su texto en español, tono e ícono. */
export const STATUS: Record<string, Record<string, StatusSpec>> = {
  rollout: {
    pendiente_aprobacion: S("Pendiente de aprobación", "warn", Clock),
    en_curso: S("En curso", "accent", LoaderCircle, true),
    completado: S("Completado", "ok", CircleCheck),
    revertido: S("Revertido", "bad", RotateCcw),
    abortado: S("Abortado", "neutral", Ban),
  },
  anomaly: {
    abierta: S("Abierta", "warn", TriangleAlert),
    bloqueo_propuesto: S("Bloqueo propuesto", "warn", ShieldAlert),
    bloqueada: S("Bloqueada", "bad", Ban),
    descartada: S("Descartada", "neutral", CircleMinus),
    resuelta: S("Resuelta", "ok", CircleCheck),
  },
  finding: {
    nuevo: S("Nuevo", "warn", TriangleAlert),
    gobernado: S("Gobernado", "ok", CircleCheck),
    riesgo_aceptado: S("Riesgo aceptado", "neutral", ShieldAlert),
    en_migracion: S("En migración", "accent", RotateCcw),
    descartado: S("Descartado", "neutral", CircleMinus),
  },
  site: {
    ok: S("Operativo", "ok", CircleCheck),
    degradado: S("Degradado", "warn", TriangleAlert),
    caido: S("Caído", "bad", CircleX),
    desconocido: S("Sin datos", "neutral", CircleQuestionMark),
  },
  check: {
    ok: S("OK", "ok", CircleCheck),
    falla: S("Falla", "bad", CircleX),
    desconocido: S("Sin datos", "neutral", CircleQuestionMark),
  },
  scan: {
    en_curso: S("En curso", "accent", LoaderCircle, true),
    terminado: S("Terminado", "ok", CircleCheck),
    fallido: S("Fallido", "bad", CircleX),
  },
  job: {
    en_curso: S("En curso", "accent", LoaderCircle, true),
    listo: S("Listo", "ok", CircleCheck),
    completado: S("Completado", "ok", CircleCheck),
    fallido: S("Fallido", "bad", CircleX),
  },
  deadLetter: {
    pendiente: S("Pendiente", "warn", Clock),
    reprocesado: S("Reprocesado", "ok", CircleCheck),
    descartado: S("Descartado", "neutral", CircleMinus),
  },
  audit: {
    exito: S("Éxito", "ok", CircleCheck),
    rechazado: S("Rechazado", "warn", Ban),
    error: S("Error", "bad", CircleX),
  },
  apiState: {
    CREATED: S("Borrador", "neutral", CircleDashed),
    PROTOTYPED: S("Prototipo", "neutral", CircleDashed),
    PUBLISHED: S("Publicada", "ok", CircleCheck),
    BLOCKED: S("Bloqueada", "bad", Ban),
    DEPRECATED: S("Deprecada", "warn", TriangleAlert),
    RETIRED: S("Retirada", "neutral", CircleMinus),
  },
  decision: {
    avanzar: S("Avanzar", "ok", CircleCheck),
    revertir: S("Revertir", "bad", RotateCcw),
    pendiente: S("Evaluando", "accent", LoaderCircle, true),
  },
  block: {
    activo: S("Activo", "bad", Ban),
    liberado: S("Liberado", "neutral", CircleMinus),
  },
  step: {
    ok: S("OK", "ok", CircleCheck),
    en_curso: S("En curso", "accent", LoaderCircle, true),
    fallido: S("Falló", "bad", CircleX),
    omitido: S("Omitido", "neutral", CircleMinus),
  },
};

export type StatusKind = keyof typeof STATUS;

interface StatusBadgeProps {
  kind: StatusKind;
  status: string | undefined | null;
  testId?: string;
}

export function statusLabel(kind: StatusKind, status: string | undefined | null): string {
  if (!status) return "Sin estado";
  return STATUS[kind]?.[status]?.label ?? status;
}

export function StatusBadge({ kind, status, testId }: StatusBadgeProps) {
  const spec = status ? STATUS[kind]?.[status] : undefined;
  if (!spec) {
    return (
      <Badge tone="neutral" data-testid={testId} data-status={status ?? ""}>
        {status ?? "Sin estado"}
      </Badge>
    );
  }
  const Icon = spec.icon;
  return (
    <Badge
      tone={spec.tone}
      data-testid={testId}
      data-status={status ?? ""}
      icon={
        <Icon className={spec.spin ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} aria-hidden="true" />
      }
    >
      {spec.label}
    </Badge>
  );
}
