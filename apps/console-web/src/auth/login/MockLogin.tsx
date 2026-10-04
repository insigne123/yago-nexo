import { ROLE_DESCRIPTIONS } from "@nexo/shared/browser";
import { FlaskConical, LogIn, RotateCcw } from "lucide-react";
import { useState } from "react";
import { authorizedFetch } from "../../api/client";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { toast } from "../../components/ui/toast-store";
import type { MockAuthProvider } from "../mock";
import type { MockUser } from "../mockUsers";
import { roleLabel } from "../permissions";

function UserCard({ user, onSelect }: { user: MockUser; onSelect: () => void }) {
  const role = user.roles[0];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-testid={user.testCase ? `mock-login-${user.username}` : `mock-login-${role}`}
        className="flex h-full w-full flex-col gap-1.5 rounded-lg border border-line bg-surface p-4 text-left shadow-xs transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          {user.roles.map((r) => (
            <Badge key={r} tone="accent">
              {roleLabel(r)}
            </Badge>
          ))}
        </span>
        <span className="text-sm font-semibold text-fg">{user.name}</span>
        <span className="font-mono text-xs text-fg-muted">{user.username}</span>
        <span className="text-xs text-fg-muted">
          {user.testCase ?? (role ? ROLE_DESCRIPTIONS[role] : "")}
          {user.organization ? ` Organización: ${user.organization}.` : ""}
        </span>
        <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-accent">
          <LogIn className="size-3.5" aria-hidden="true" />
          Ingresar como {user.name}
        </span>
      </button>
    </li>
  );
}

/** Selector de usuario de demostración (un usuario por rol). Solo con datos simulados. */
export function MockLogin({ provider }: { provider: MockAuthProvider }) {
  const [resetting, setResetting] = useState(false);
  const standard = provider.users.filter((u) => !u.testCase);
  const tests = provider.users.filter((u) => u.testCase);

  const reset = async () => {
    setResetting(true);
    try {
      await authorizedFetch("__mock/reset", { method: "POST" });
      toast.success(
        "Datos de demostración restablecidos",
        "Se volvió al estado inicial del laboratorio simulado.",
      );
    } catch {
      toast.error("No se pudieron restablecer los datos simulados");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="mock-login">
      <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm text-fg">
        <FlaskConical className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
        <p>
          Modo de demostración: no se usa un proveedor de identidad real y los datos son simulados. Elija un
          usuario para ver la Consola con los permisos de su rol.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Usuarios de demostración">
        {standard.map((user) => (
          <UserCard key={user.username} user={user} onSelect={() => provider.loginAs(user.username)} />
        ))}
      </ul>
      {tests.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-fg">Casos de prueba</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Usuarios de prueba">
            {tests.map((user) => (
              <UserCard key={user.username} user={user} onSelect={() => provider.loginAs(user.username)} />
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw className="size-4" aria-hidden="true" />}
          loading={resetting}
          onClick={() => void reset()}
          data-testid="btn-mock-reset"
        >
          Restablecer datos de demostración
        </Button>
      </div>
    </div>
  );
}
