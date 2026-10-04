import { ShieldCheck, ShieldX } from "lucide-react";
import type { ChainVerification } from "../../api/types";
import { formatDateTime, formatNumber } from "../../lib/format";

const REASONS: Record<string, string> = {
  hash: "El contenido de ese evento no coincide con su hash: fue modificado después de registrarse.",
  secuencia: "Falta un evento o la secuencia está fuera de orden (posible eliminación).",
  encadenamiento: "El hash previo de ese evento no coincide con el hash del evento anterior.",
};

interface ChainVerificationBannerProps {
  result: ChainVerification;
  verifiedAt?: string;
}

/** Resultado de GET /audit-events/verify (BT-032), destacado: íntegra o rota en el evento N. */
export function ChainVerificationBanner({ result, verifiedAt }: ChainVerificationBannerProps) {
  const when = verifiedAt ? (
    <p className="mt-1 text-xs text-fg-muted">Verificado el {formatDateTime(verifiedAt)}</p>
  ) : null;
  if (result.ok) {
    return (
      <div
        role="status"
        data-testid="audit-verification"
        data-ok="true"
        className="flex items-start gap-3 rounded-lg border-2 border-ok/50 bg-ok-soft p-4"
      >
        <ShieldCheck className="mt-0.5 size-7 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <p className="text-base font-semibold text-ok">Cadena de auditoría íntegra</p>
          <p className="mt-1 text-sm text-fg">
            Se verificaron {formatNumber(result.count ?? 0)} eventos
            {result.lastSeq !== undefined ? `; el último es el número ${formatNumber(result.lastSeq)}` : ""}.
            Ningún evento fue alterado, eliminado ni reordenado.
          </p>
          {when}
        </div>
      </div>
    );
  }
  const reason = result.reason ? (REASONS[result.reason] ?? `Motivo informado: ${result.reason}.`) : "";
  return (
    <div
      role="alert"
      data-testid="audit-verification"
      data-ok="false"
      data-broken-at={result.brokenAt}
      className="flex items-start gap-3 rounded-lg border-2 border-bad/60 bg-bad-soft p-4"
    >
      <ShieldX className="mt-0.5 size-7 shrink-0 text-bad" aria-hidden="true" />
      <div>
        <p className="text-base font-semibold text-bad">
          Cadena rota en el evento número{" "}
          {result.brokenAt !== undefined ? formatNumber(result.brokenAt) : "desconocido"}
        </p>
        <p className="mt-1 text-sm text-fg">{reason}</p>
        <p className="mt-1 text-sm text-fg-muted">
          {formatNumber(result.count ?? 0)} eventos verificados correctamente antes de la falla. Informe al
          equipo de seguridad y preserve el respaldo del SIEM.
        </p>
        {when}
      </div>
    </div>
  );
}
