import { useRuntime } from "../../config/RuntimeContext";
import { useAuthProvider, useAuthSnapshot } from "../AuthContext";
import { MockLogin } from "./MockLogin";
import { OidcLogin } from "./OidcLogin";
import { SupabaseLogin } from "./SupabaseLogin";

/** Pantalla de ingreso según el proveedor configurado en /config.json. */
export function LoginScreen() {
  const provider = useAuthProvider();
  const snapshot = useAuthSnapshot();
  const { config } = useRuntime();
  const error = snapshot.status === "anonymous" ? snapshot.error : undefined;

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-10 sm:py-16" id="contenido">
      <div className={provider.kind === "mock" ? "w-full max-w-5xl" : "w-full max-w-xl"}>
        <div className="mb-8 flex flex-col items-center text-center">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="mb-3 size-12" />
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Consola Nexo</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Gobierno, operación y cumplimiento de APIs · {config.environmentLabel}
          </p>
        </div>
        {provider.kind === "mock" && <MockLogin provider={provider} />}
        {provider.kind === "oidc" && config.auth.provider === "oidc" && (
          <OidcLogin provider={provider} error={error} authority={config.auth.oidc.authority} />
        )}
        {provider.kind === "supabase" && <SupabaseLogin provider={provider} snapshot={snapshot} />}
        <p className="mt-10 text-center text-xs text-fg-subtle">
          Yago Nexo {config.version} · Basado en WSO2 (Apache 2.0). WSO2 es marca de WSO2 LLC.
        </p>
      </div>
    </main>
  );
}
