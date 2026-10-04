import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, LogOut, Menu, X } from "lucide-react";
import { useState } from "react";
import { useAuthProvider } from "../../auth/AuthContext";
import { roleLabel } from "../../auth/permissions";
import { useSession } from "../../auth/session";
import { useRuntime } from "../../config/RuntimeContext";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

interface HeaderProps {
  menuOpen: boolean;
  onToggleMenu: () => void;
}

export function Header({ menuOpen, onToggleMenu }: HeaderProps) {
  const { config, mock } = useRuntime();
  const session = useSession();
  const provider = useAuthProvider();
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);

  const logout = async () => {
    setLeaving(true);
    try {
      await provider.logout();
    } finally {
      // No se conservan datos de un usuario para el siguiente.
      queryClient.clear();
      setLeaving(false);
    }
  };

  return (
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 print:hidden">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleMenu}
          aria-expanded={menuOpen}
          aria-controls="menu-lateral"
          className="rounded-md p-1.5 text-fg-muted hover:bg-subtle lg:hidden"
        >
          {menuOpen ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
          <span className="sr-only">{menuOpen ? "Cerrar menú" : "Abrir menú"}</span>
        </button>
        <span data-testid="environment-label" className="text-sm font-medium text-fg">
          {config.environmentLabel}
        </span>
        {mock && (
          <Badge
            tone="warn"
            icon={<FlaskConical className="size-3.5" aria-hidden="true" />}
            data-testid="mock-badge"
          >
            Datos simulados
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right leading-tight">
          <p data-testid="current-user" className="text-sm font-medium text-fg">
            {session.user.name}
          </p>
          <p data-testid="current-roles" className="text-xs text-fg-muted">
            <span className="sr-only">Roles: </span>
            {session.roles.map(roleLabel).join(", ") || "Sin roles"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logout()}
          loading={leaving}
          icon={<LogOut className="size-4" aria-hidden="true" />}
          data-testid="btn-logout"
        >
          Cerrar sesión
        </Button>
      </div>
    </header>
  );
}
