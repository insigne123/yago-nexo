/// <reference types="node" />
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureApi } from "../../api/client";
import { createQueryClient } from "../../api/queryClient";
import { findMockUser, mockAccessToken } from "../../auth/mockUsers";
import { createSession, SessionContext } from "../../auth/session";
import { RuntimeContext } from "../../config/RuntimeContext";
import { parseRuntimeConfig } from "../../config/runtime";
import { createHandlers } from "../../mocks/handlers";
import { MockStore } from "../../mocks/store";
import ContinuidadPage from "./ContinuidadPage";

const BASE = "http://consola.test/api/v1";
let now = Date.parse("2026-10-04T12:00:00.000Z");
const store = new MockStore({ now: () => now, baseUrl: BASE });
const server = setupServer(...createHandlers(store, { baseUrl: BASE, latency: 0 }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  now = Date.parse("2026-10-04T12:00:00.000Z");
  store.reset();
});

function token(username: string): string {
  const user = findMockUser(username);
  if (!user) throw new Error(`usuario ${username}`);
  return mockAccessToken(user, Math.floor(now / 1000));
}

async function post(path: string, username: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token(username)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Deja el sitio de respaldo activo (caída simulada del primario) para que haya un retorno posible. */
async function operateOnBackup(): Promise<void> {
  await post("/__mock/continuity/outage", "carla.operacion");
  now += 15_000;
}

const runtime = { config: parseRuntimeConfig({ auth: { provider: "mock" } }), mock: true };

function renderAs(username: string) {
  const user = findMockUser(username);
  if (!user) throw new Error(`usuario ${username}`);
  configureApi({ baseUrl: BASE, getToken: async () => token(username) });
  const session = createSession({
    id: `mock-${user.username}`,
    username: user.username,
    name: user.name,
    email: user.email,
    roles: [...user.roles],
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <RuntimeContext.Provider value={runtime}>
        <SessionContext.Provider value={session}>
          <ContinuidadPage />
        </SessionContext.Provider>
      </RuntimeContext.Provider>
    </QueryClientProvider>,
  );
}

describe("Continuidad: modo de conmutación", () => {
  it("se muestra el modo de la instalación y no se puede cambiar desde la Consola", async () => {
    renderAs("admin.nexo");
    const mode = await screen.findByTestId("continuity-mode");
    expect(mode).toHaveTextContent("Automático");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/Lo fija NEXO_CONTINUITY_AUTOMATICO en la instalación/)).toBeInTheDocument();
    expect(screen.queryByText(/mismo procedimiento/)).not.toBeInTheDocument();
    expect(screen.queryByText(/procedimiento manual/)).not.toBeInTheDocument();
  });

  it("en una instalación manual lo dice sin prometer un procedimiento", async () => {
    store.setInstalledMode("manual");
    renderAs("admin.nexo");
    expect(await screen.findByTestId("continuity-mode")).toHaveTextContent("Manual");
    expect(screen.getByText(/no conmutan solos/)).toBeInTheDocument();
  });
});

describe("Continuidad: retorno al sitio principal con dos personas", () => {
  it("la operadora solicita el retorno con un motivo y no puede aprobarlo", async () => {
    await operateOnBackup();
    renderAs("carla.operacion");
    await waitFor(() =>
      expect(screen.getByTestId("btn-request-failback")).not.toHaveAttribute("aria-disabled"),
    );
    await userEvent.click(screen.getByTestId("btn-request-failback"));
    const dialog = await screen.findByTestId("failback-request-dialog");
    // El diálogo describe el paso del operador: el retorno no copia datos.
    expect(dialog).toHaveTextContent("no copia datos");
    expect(dialog).toHaveTextContent("pg_basebackup");
    await userEvent.type(
      within(dialog).getByTestId("failback-request-dialog-reason"),
      "Primario restablecido",
    );
    await userEvent.click(within(dialog).getByTestId("failback-request-dialog-confirm"));

    const pending = await screen.findByTestId("pending-failback");
    expect(pending).toHaveTextContent("solicitado por carla.operacion");
    expect(pending).toHaveTextContent("Motivo: Primario restablecido");
    const approve = screen.getByTestId("btn-approve-failback");
    expect(approve).toHaveAttribute("data-blocked", "permiso");
    expect(approve).toHaveAccessibleDescription(/continuity:failback:approve/);
    expect(screen.queryByTestId("btn-request-failback")).not.toBeInTheDocument();
  });

  it("quien solicitó no puede aprobar su propia solicitud (cuatro ojos)", async () => {
    await operateOnBackup();
    await post("/continuity/failback/requests", "luis.aprobador", { reason: "Primario restablecido" });
    renderAs("luis.aprobador");
    await screen.findByTestId("pending-failback");
    const approve = screen.getByTestId("btn-approve-failback");
    expect(approve).toHaveAttribute("data-blocked", "regla");
    expect(approve).toHaveAccessibleDescription(/cuatro ojos/);
  });

  it("otra persona aprueba y el historial muestra a quien solicitó y a quien aprobó", async () => {
    await operateOnBackup();
    await post("/continuity/failback/requests", "carla.operacion", { reason: "Primario restablecido" });
    renderAs("luis.aprobador");
    await screen.findByTestId("pending-failback");
    await waitFor(() =>
      expect(screen.getByTestId("btn-approve-failback")).not.toHaveAttribute("aria-disabled"),
    );
    await userEvent.click(screen.getByTestId("btn-approve-failback"));
    const dialog = await screen.findByTestId("failback-dialog");
    expect(dialog).toHaveTextContent("Solicitado por carla.operacion");
    await userEvent.click(within(dialog).getByTestId("failback-dialog-confirm"));

    await waitFor(() => expect(screen.queryByTestId("pending-failback")).not.toBeInTheDocument());
    const events = await screen.findByTestId("failover-events");
    await waitFor(() => expect(events).toHaveTextContent("Solicitó carla.operacion · Aprobó luis.aprobador"));
  });

  it("el RPO se informa como no medido, nunca como 0", async () => {
    renderAs("carla.operacion");
    const rpo = await screen.findByTestId("failover-rpo-fo-0001");
    expect(screen.getByTestId("failover-rpo-fo-0003")).toHaveTextContent("RPO: no medido");
    expect(rpo).toHaveTextContent("RPO: no medido");
    expect(screen.queryByText(/RPO estimado/)).not.toBeInTheDocument();
  });

  it("en la demo, la caída simulada del primario lleva al respaldo y habilita la solicitud de retorno", async () => {
    renderAs("carla.operacion");
    await screen.findByTestId("active-site");
    await userEvent.click(screen.getByTestId("btn-mock-outage"));
    now += 15_000;
    await waitFor(
      () => expect(screen.getByTestId("btn-request-failback")).not.toHaveAttribute("aria-disabled"),
      { timeout: 4000 },
    );
    expect(screen.getByTestId("active-site")).toHaveTextContent("El retorno no se ha solicitado");
  });

  it("sin conmutación previa no hay retorno que solicitar", async () => {
    renderAs("carla.operacion");
    await screen.findByTestId("active-site");
    const request = screen.getByTestId("btn-request-failback");
    expect(request).toHaveAttribute("data-blocked", "regla");
    expect(request).toHaveAccessibleDescription(/ya está activo/);
  });
});
