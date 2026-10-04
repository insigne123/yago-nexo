import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { RouterProvider } from "react-router/dom";
import { useMe } from "./api/queries";
import { AuthContext, useAuthSnapshot } from "./auth/AuthContext";
import type { AnyAuthProvider } from "./auth/create";
import { LoginScreen } from "./auth/login/LoginScreen";
import { createSession, SessionContext } from "./auth/session";
import type { AuthUser } from "./auth/types";
import { DemoBanner } from "./components/layout/DemoBanner";
import { FullPageMessage } from "./components/layout/FullPageMessage";
import { Toaster } from "./components/ui/Toast";
import { toast } from "./components/ui/toast-store";
import { RuntimeContext } from "./config/RuntimeContext";
import type { RuntimeConfig } from "./config/runtime";
import { getRouter } from "./router";

function SessionGate({ user }: { user: AuthUser }) {
  const me = useMe(user.id);
  const session = useMemo(() => createSession(user, me.data ?? null), [user, me.data]);

  useEffect(() => {
    if (me.isError) {
      toast.warning(
        "Permisos calculados desde los roles",
        "No se pudo consultar GET /me; la Consola usa los roles del token. La API valida cada acción igualmente.",
      );
    }
  }, [me.isError]);

  if (me.isPending) return <FullPageMessage message="Cargando sus permisos…" />;
  return (
    <SessionContext.Provider value={session}>
      <RouterProvider router={getRouter()} />
    </SessionContext.Provider>
  );
}

function AuthGate() {
  const snapshot = useAuthSnapshot();
  if (snapshot.status === "loading") return <FullPageMessage message="Verificando la sesión…" />;
  if (snapshot.status !== "authenticated") return <LoginScreen />;
  return <SessionGate key={snapshot.user.id} user={snapshot.user} />;
}

interface AppProps {
  config: RuntimeConfig;
  provider: AnyAuthProvider;
  mock: boolean;
  queryClient: QueryClient;
}

export function App({ config, provider, mock, queryClient }: AppProps) {
  const runtime = useMemo(() => ({ config, mock }), [config, mock]);
  return (
    <RuntimeContext.Provider value={runtime}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={provider}>
          <div className="flex min-h-screen flex-col">
            {config.demoBanner && (
              <DemoBanner environmentLabel={config.environmentLabel} version={config.version} mock={mock} />
            )}
            <AuthGate />
          </div>
          <Toaster />
        </AuthContext.Provider>
      </QueryClientProvider>
    </RuntimeContext.Provider>
  );
}
