import type { Permission } from "@nexo/shared/browser";
import { requiredPermissionText } from "../auth/permissions";
import { useSession } from "../auth/session";
import { Button, type ButtonProps } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";

interface GuardedButtonProps extends ButtonProps {
  /** Permiso exigido para la acción. */
  permission?: Permission;
  /** Alternativa: basta con cualquiera de estos permisos. */
  anyOf?: readonly Permission[];
  /** Otro motivo de bloqueo (por ejemplo la regla de cuatro ojos o el estado del recurso). */
  blockedReason?: string | null;
  /** Oculta el botón en vez de deshabilitarlo cuando falta el permiso. */
  hideWhenDenied?: boolean;
}

/**
 * Botón que refleja la matriz rol-permiso: sin permiso queda deshabilitado (aria-disabled) con
 * un tooltip que explica qué permiso falta. La API vuelve a verificar siempre (no basta la UI).
 */
export function GuardedButton({
  permission,
  anyOf,
  blockedReason,
  hideWhenDenied = false,
  ...props
}: GuardedButtonProps) {
  const session = useSession();
  const required: readonly Permission[] = permission ? [permission] : (anyOf ?? []);
  const allowed = required.length === 0 || session.canAny(required);
  if (!allowed && hideWhenDenied) return null;
  const reason = allowed ? blockedReason || null : requiredPermissionText(required);
  if (!reason) return <Button {...props} />;
  return (
    <Tooltip content={reason}>
      {(trigger) => (
        <Button {...props} {...trigger} aria-disabled="true" data-blocked={allowed ? "regla" : "permiso"} />
      )}
    </Tooltip>
  );
}
