import type { RuntimeConfig } from "../config/runtime";
import type { MockAuthProvider } from "./mock";
import type { OidcAuthProvider } from "./oidc";
import type { SupabaseAuthProvider } from "./supabase";

export type AnyAuthProvider = MockAuthProvider | OidcAuthProvider | SupabaseAuthProvider;

/** Carga solo la librería del proveedor configurado (oidc-client-ts o supabase-js). */
export async function createAuthProvider(config: RuntimeConfig): Promise<AnyAuthProvider> {
  const auth = config.auth;
  switch (auth.provider) {
    case "oidc": {
      const { OidcAuthProvider } = await import("./oidc");
      return new OidcAuthProvider(auth.oidc);
    }
    case "supabase": {
      const { SupabaseAuthProvider } = await import("./supabase");
      return new SupabaseAuthProvider(auth.supabase);
    }
    case "mock": {
      const { MockAuthProvider } = await import("./mock");
      return new MockAuthProvider();
    }
  }
}
