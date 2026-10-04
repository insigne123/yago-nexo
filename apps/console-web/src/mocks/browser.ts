import { setupWorker } from "msw/browser";
import type { RuntimeConfig } from "../config/runtime";
import { createHandlers } from "./handlers";
import { MockStore } from "./store";

/**
 * Arranca el modo de datos simulados: Mock Service Worker intercepta las llamadas a la API
 * de la Consola y responde desde el almacén en memoria (persistido en la pestaña).
 */
export async function startMockWorker(config: RuntimeConfig): Promise<MockStore> {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "El modo simulado necesita service workers: abra la Consola con HTTPS o desde localhost.",
    );
  }
  const store = new MockStore({ storage: window.sessionStorage, baseUrl: config.apiBaseUrl });
  const rolesClaimPaths =
    config.auth.provider === "oidc"
      ? [config.auth.oidc.rolesClaimPath]
      : config.auth.provider === "supabase"
        ? [config.auth.supabase.rolesClaimPath]
        : [];
  const worker = setupWorker(...createHandlers(store, { baseUrl: config.apiBaseUrl, rolesClaimPaths }));
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledRequest: "bypass",
    quiet: true,
  });
  // Temporizador del simulador: los despliegues, simulacros, escaneos y exportaciones avanzan solos.
  window.setInterval(() => store.tick(), 1000);
  return store;
}
