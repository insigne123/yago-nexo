import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import type { OidcAuthProvider } from "../oidc";

/** Ingreso con el Keycloak institucional (Authorization Code + PKCE). */
export function OidcLogin({
  provider,
  error,
  authority,
}: {
  provider: OidcAuthProvider;
  error?: string;
  authority: string;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  let host = authority;
  try {
    host = new URL(authority).host;
  } catch {
    // Se muestra tal cual.
  }

  const login = async () => {
    setRedirecting(true);
    setFailure(null);
    try {
      await provider.login();
    } catch (e) {
      setRedirecting(false);
      setFailure(
        `No se pudo contactar al proveedor de identidad (${host}). ${e instanceof Error ? e.message : ""}`.trim(),
      );
    }
  };

  const message = failure ?? error;
  return (
    <div
      className="mx-auto max-w-md rounded-lg border border-line bg-surface p-6 shadow-xs"
      data-testid="oidc-login"
    >
      <h2 className="text-base font-semibold text-fg">Iniciar sesión</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Use su cuenta institucional. Será redirigido al servicio de identidad ({host}) y volverá a la Consola
        al terminar.
      </p>
      {message && (
        <p role="alert" className="mt-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          {message}
        </p>
      )}
      <Button
        variant="primary"
        className="mt-5 w-full"
        icon={<KeyRound className="size-4" aria-hidden="true" />}
        loading={redirecting}
        onClick={() => void login()}
        data-testid="btn-oidc-login"
      >
        Ingresar con la cuenta institucional
      </Button>
    </div>
  );
}
