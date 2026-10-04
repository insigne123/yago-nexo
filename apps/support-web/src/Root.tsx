import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { loadRuntimeConfig, RuntimeConfigError, type RuntimeConfig } from "./config/runtime-config";
import { createSupabase, RuntimeConfigContext, SupabaseContext } from "./lib/supabase";

interface Ready {
  config: RuntimeConfig;
  supabase: SupabaseClient;
  queryClient: QueryClient;
}

function ConfigErrorScreen({ error }: { error: RuntimeConfigError | Error }) {
  const pending = error instanceof RuntimeConfigError && error.kind === "pendiente";
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-xl font-bold text-slate-900">
        {pending
          ? "La Mesa de soporte Nexo no está configurada"
          : "No se pudo iniciar la Mesa de soporte Nexo"}
      </h1>
      <p className="mt-3 text-sm text-slate-700" role="alert">
        {error.message}
      </p>
      <p className="mt-3 text-sm text-slate-700">
        El archivo <code>/config.json</code> debe tener <code>supabaseUrl</code>, <code>supabaseAnonKey</code>{" "}
        (clave publicable) y <code>environmentLabel</code>. Vea apps/support-web/README.md.
      </p>
    </main>
  );
}

/** Carga /config.json y monta los proveedores (Supabase, TanStack Query, sesión y rutas). */
export function Root() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    loadRuntimeConfig()
      .then((config) => {
        if (!active) return;
        const queryClient = new QueryClient({
          defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
        });
        setReady({ config, supabase: createSupabase(config), queryClient });
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <ConfigErrorScreen error={error} />;
  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-600" role="status">
        Cargando…
      </main>
    );
  }
  return (
    <RuntimeConfigContext.Provider value={ready.config}>
      <SupabaseContext.Provider value={ready.supabase}>
        <QueryClientProvider client={ready.queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </QueryClientProvider>
      </SupabaseContext.Provider>
    </RuntimeConfigContext.Provider>
  );
}
