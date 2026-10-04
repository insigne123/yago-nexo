import type { Permission } from "@nexo/shared/browser";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { requiredPermissionText, roleLabel } from "../auth/permissions";
import { useSession } from "../auth/session";
import { EmptyState } from "./ui/EmptyState";

interface GateProps {
  /** Basta con cualquiera de estos permisos. */
  anyOf: readonly Permission[];
  children: ReactNode;
  fallback?: ReactNode;
}

/** Muestra el contenido solo si el usuario tiene alguno de los permisos. */
export function PermissionGate({ anyOf, children, fallback = null }: GateProps) {
  const session = useSession();
  return <>{anyOf.length === 0 || session.canAny(anyOf) ? children : fallback}</>;
}

export function NoAccess({ permissions }: { permissions: readonly Permission[] }) {
  const session = useSession();
  return (
    <div className="py-10" data-testid="no-access">
      <EmptyState
        icon={<Lock className="size-7" />}
        title="Su rol no tiene acceso a esta sección"
        description={
          <>
            <p>{requiredPermissionText(permissions)}</p>
            <p className="mt-1">
              Roles actuales: {session.roles.map(roleLabel).join(", ") || "ninguno"}. Si necesita acceso,
              solicítelo al administrador de la plataforma.
            </p>
          </>
        }
      />
    </div>
  );
}

/** Protege una página completa: sin permiso muestra el aviso en lugar del contenido. */
export function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: readonly Permission[];
  children: ReactNode;
}) {
  return (
    <PermissionGate anyOf={anyOf} fallback={<NoAccess permissions={anyOf} />}>
      {children}
    </PermissionGate>
  );
}
