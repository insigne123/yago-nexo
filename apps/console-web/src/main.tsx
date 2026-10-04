import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { configureApi } from "./api/client";
import { createQueryClient } from "./api/queryClient";
import { App } from "./App";
import { createAuthProvider } from "./auth/create";
import { FullPageMessage } from "./components/layout/FullPageMessage";
import { ConfigError, loadRuntimeConfig, resolveMockMode } from "./config/runtime";
import "./styles.css";

// La política de seguridad de contenido no permite 'unsafe-eval': zod sin compilación JIT.
z.config({ jitless: true });

function StartupError({ error }: { error: unknown }) {
  const details = error instanceof ConfigError ? error.details : [];
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex min-h-screen flex-col">
      <FullPageMessage
        error
        message="No se pudo iniciar la Consola Nexo"
        detail={
          <>
            <p>{message}</p>
            {details.length > 0 && (
              <ul className="mt-2 list-disc text-left">
                {details.map((d) => (
                  <li key={d}>
                    <code className="font-mono text-xs">{d}</code>
                  </li>
                ))}
              </ul>
            )}
          </>
        }
        action={
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium hover:bg-subtle"
          >
            Reintentar
          </button>
        }
      />
    </div>
  );
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("Falta el elemento #root");
  const root = createRoot(container);
  const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

  try {
    const config = await loadRuntimeConfig();

    // Iframe de renovación silenciosa de OIDC: se atiende sin montar la aplicación.
    if (config.auth.provider === "oidc") {
      const { completeSilentRenew, isSilentCallback } = await import("./auth/oidc");
      if (isSilentCallback(window.location.pathname)) {
        await completeSilentRenew(config.auth.oidc);
        return;
      }
    }

    const mock = resolveMockMode(config, window.location, window.sessionStorage);
    if (mock) {
      const { startMockWorker } = await import("./mocks/browser");
      await startMockWorker(config);
    }

    const provider = await createAuthProvider(config);
    configureApi({
      baseUrl: config.apiBaseUrl,
      getToken: () => provider.getAccessToken(),
      onUnauthorized: () => provider.handleUnauthorized(),
    });
    await provider.init();
    render(<App config={config} provider={provider} mock={mock} queryClient={createQueryClient()} />);
  } catch (error) {
    console.error(error);
    render(<StartupError error={error} />);
  }
}

void bootstrap();
