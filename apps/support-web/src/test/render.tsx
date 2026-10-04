import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { AuthContext, type AuthState } from "../auth/session";
import type { SessionContext } from "../lib/permissions";
import { RuntimeConfigContext, SupabaseContext } from "../lib/supabase";

/** Cliente de Supabase falso: las pruebas de interfaz no llaman a la red. */
export function fakeSupabase(): SupabaseClient {
  const result = Promise.resolve({ data: [], error: null });
  const builder: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "neq",
    "order",
    "limit",
    "lt",
    "gt",
    "insert",
    "update",
    "delete",
    "single",
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder["then"] = result.then.bind(result);
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  } as unknown as SupabaseClient;
}

export const ORG_SUBTEL = "11111111-1111-4111-8111-111111111111";
export const ORG_YAGO = "22222222-2222-4222-8222-222222222222";

export function sessionFor(role: "reportante" | "contraparte" | "agente" | "supervisor"): SessionContext {
  const staff = role === "agente" || role === "supervisor";
  return {
    userId: `usuario-${role}`,
    email: `${role}@ejemplo.invalid`,
    mfaOk: true,
    isStaff: staff,
    isSupervisor: role === "supervisor",
    memberships: [
      {
        orgId: staff ? ORG_YAGO : ORG_SUBTEL,
        orgName: staff ? "Yago" : "SUBTEL (demo)",
        orgSlug: staff ? "yago" : "subtel-demo",
        isProvider: staff,
        role,
        displayName: `Persona ${role}`,
      },
    ],
  };
}

export function renderWithProviders(ui: ReactElement, ctx: SessionContext | null = null): RenderResult {
  const auth: AuthState = {
    status: ctx ? "lista" : "sin_sesion",
    session: null,
    factorId: null,
    ctx,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
    signOut: vi.fn(() => Promise.resolve()),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <RuntimeConfigContext.Provider
      value={{
        supabaseUrl: "https://ejemplo.supabase.co",
        supabaseAnonKey: "clave-publicable-de-prueba",
        environmentLabel: "pruebas",
      }}
    >
      <SupabaseContext.Provider value={fakeSupabase()}>
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={auth}>
            <MemoryRouter>{ui}</MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      </SupabaseContext.Provider>
    </RuntimeConfigContext.Provider>,
  );
}
