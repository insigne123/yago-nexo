import { SEVERITY_NAME, STATUS_LABEL } from "../lib/labels";
import type { Severity, TicketStatus } from "../lib/types";

const SEVERITY_CLASS: Record<Severity, string> = {
  S1: "bg-red-700 text-white",
  S2: "bg-orange-600 text-white",
  S3: "bg-blue-700 text-white",
  S4: "bg-slate-600 text-white",
};

export function SeverityBadge({ severity, long = false }: { severity: Severity; long?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-bold ${SEVERITY_CLASS[severity]}`}
      title={`Severidad ${severity}: ${SEVERITY_NAME[severity]}`}
    >
      {long ? `${severity} · ${SEVERITY_NAME[severity]}` : severity}
    </span>
  );
}

const STATUS_CLASS: Record<TicketStatus, string> = {
  nuevo: "bg-amber-100 text-amber-900 ring-amber-300",
  acusado: "bg-sky-100 text-sky-900 ring-sky-300",
  en_diagnostico: "bg-indigo-100 text-indigo-900 ring-indigo-300",
  solucion_temporal: "bg-violet-100 text-violet-900 ring-violet-300",
  resuelto: "bg-emerald-100 text-emerald-900 ring-emerald-300",
  cerrado: "bg-slate-100 text-slate-700 ring-slate-300",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ring-1 ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutro",
}: {
  children: string;
  tone?: "neutro" | "alerta" | "peligro" | "info";
}) {
  const classes = {
    neutro: "bg-slate-100 text-slate-700",
    alerta: "bg-amber-100 text-amber-900",
    peligro: "bg-red-100 text-red-900",
    info: "bg-blue-100 text-blue-900",
  };
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${classes[tone]}`}>
      {children}
    </span>
  );
}
