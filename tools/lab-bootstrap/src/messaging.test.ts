import { afterEach, describe, expect, it, vi } from "vitest";
import { POLITICA_FALLIDOS, ensureMessaging } from "./messaging.js";

afterEach(() => vi.unstubAllGlobals());

describe("topología de mensajería del laboratorio", () => {
  it("aplica a la cola de fallidos una política sin límite de entregas (1-06)", async () => {
    const llamadas: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string }) => {
      llamadas.push({ method: init.method, url, body: JSON.parse(init.body) });
      return new Response(null, { status: 201 });
    });
    await ensureMessaging(() => {});
    const politica = llamadas.find((l) => l.url.includes("/policies/"));
    expect(politica?.method).toBe("PUT");
    expect(politica?.url).toMatch(/\/policies\/%2F\/nexo-fallidos-sin-limite-de-entregas$/);
    expect(politica?.body).toEqual({
      pattern: "^solicitudes\\.dlq$",
      "apply-to": "quorum_queues",
      priority: 10,
      definition: { "delivery-limit": -1 },
    });
    // La política se aplica después de declarar la cola de fallidos.
    const iCola = llamadas.findIndex((l) => l.url.endsWith("/queues/%2F/solicitudes.dlq"));
    expect(iCola).toBeGreaterThan(-1);
    expect(llamadas.indexOf(politica!)).toBeGreaterThan(iCola);
  });

  it("el patrón de la política alcanza solo a la cola de fallidos", () => {
    const re = new RegExp(POLITICA_FALLIDOS.cuerpo.pattern);
    expect(re.test("solicitudes.dlq")).toBe(true);
    for (const otra of [
      "solicitudes.nuevas",
      "solicitudes.reintento.1",
      "solicitudesXdlq",
      "solicitudes.dlq.copia",
    ])
      expect(re.test(otra)).toBe(false);
  });
});
