import type { SupabaseClient } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTicket } from "../../lib/api";
import type * as queries from "../../lib/queries";
import { ORG_CLIENTE, renderWithProviders, sessionFor } from "../../test/render";
import { NewTicketPage } from "./NewTicketPage";

// El directorio y las organizaciones llegan vacíos (sin red).
vi.mock("../../lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof queries>()),
  useDirectory: () => ({ data: [] }),
  useOrganizations: () => ({ data: [] }),
}));

const ANSWERS = {
  esConsultaOCambio: false,
  servicioProductivoCaido: true,
  existeAlternativa: false,
  degradacionOSeguridad: false,
  soloNoProductivoOMenor: false,
};

describe("ticket telefónico: hora real de la llamada", () => {
  it("el agente registra la hora real de la llamada; por omisión, la de ahora", async () => {
    renderWithProviders(<NewTicketPage />, sessionFor("agente"));
    const canal = screen.getByRole("combobox", { name: /¿Cómo llegó el ticket\?/ });
    expect(canal).toHaveDisplayValue("Llamada al teléfono de turno");
    const hora = screen.getByLabelText(/Hora real de la llamada/);
    expect(hora).toHaveAttribute("type", "datetime-local");
    expect((hora as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(screen.getByText(/El reloj del SLA parte a esta hora/)).toBeInTheDocument();

    await userEvent.selectOptions(canal, "web");
    expect(screen.queryByLabelText(/Hora real de la llamada/)).not.toBeInTheDocument();
  });

  it("el cliente no ve el canal ni la hora de la llamada", () => {
    renderWithProviders(<NewTicketPage />, sessionFor("reportante"));
    expect(screen.queryByRole("combobox", { name: /¿Cómo llegó el ticket\?/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Hora real de la llamada/)).not.toBeInTheDocument();
  });

  it("createTicket envía el canal telefónico y la hora de la llamada solo cuando corresponde", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const builder = {
      insert: vi.fn((row: Record<string, unknown>) => {
        inserted.push(row);
        return builder;
      }),
      select: vi.fn(() => builder),
      single: vi.fn(() => Promise.resolve({ data: { id: "t1", number: "SD-2026-0001" }, error: null })),
    };
    const supabase = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
    const base = {
      orgId: ORG_CLIENTE,
      title: "Gateway caído",
      description: "Todo responde 502 desde las 03:10.",
      environment: "prod" as const,
      category: null,
      component: null,
      isSecurityIncident: false,
      answers: ANSWERS,
    };
    await createTicket(supabase, { ...base, phoneCallAt: "2026-10-13T06:10:00.000Z" });
    await createTicket(supabase, base);
    expect(inserted[0]).toMatchObject({ channel: "telefono", call_received_at: "2026-10-13T06:10:00.000Z" });
    expect(inserted[1]).not.toHaveProperty("channel");
    expect(inserted[1]).not.toHaveProperty("call_received_at");
  });
});
