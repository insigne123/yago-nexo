import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DirectoryEntry, PauseRow, RemoteAccessRow, TicketDetail } from "../../lib/types";
import { ORG_SUBTEL, renderWithProviders, sessionFor } from "../../test/render";
import { PausesPanel } from "./PausesPanel";
import { RemoteAccessPanel } from "./RemoteAccessPanel";
import { TicketActions } from "./TicketActions";
import { Timeline } from "./Timeline";

const NOW = new Date("2026-10-05T13:00:00Z");

const pause: PauseRow = {
  id: "p1",
  ticket_id: "t1",
  reason: "infraestructura_subtel",
  justification: "Servidor de SUBTEL en mantención programada.",
  started_at: "2026-10-05T12:40:00Z",
  ended_at: null,
  created_by: "usuario-agente",
  ended_by: null,
  remote_access_request_id: null,
  subtel_ack_status: null,
  subtel_ack_by: null,
  subtel_ack_at: null,
  subtel_ack_note: null,
};

const remote: RemoteAccessRow = {
  id: "r1",
  ticket_id: "t1",
  scope: "gw-02 por SSH durante 2 horas",
  justification: "Revisar los registros del nodo caído.",
  status: "pendiente",
  requested_by: "usuario-agente",
  requested_at: "2026-10-05T12:45:00Z",
  decided_by: null,
  decided_at: null,
  decision_note: null,
  enabled_at: null,
  revoked_at: null,
  session_log_ref: null,
};

const ticket: TicketDetail = {
  id: "t1",
  number: "SD-2026-0001",
  org_id: ORG_SUBTEL,
  title: "Gateways de producción responden 5xx",
  description: "Todo caído",
  severity: "S1",
  classification_answers: null,
  classification_rule: "Servicio productivo caído y sin alternativa operativa",
  classification_source: "asistente",
  category: null,
  component: null,
  environment: "prod",
  status: "nuevo",
  intake_status: "aceptado",
  channel: "web",
  channel_sender: null,
  reporter_id: "usuario-reportante",
  assignee_id: null,
  created_by: "usuario-reportante",
  is_security_incident: false,
  escalation_level: 1,
  sla_started_at: "2026-10-05T12:30:00Z",
  acknowledged_at: null,
  diagnosed_at: null,
  workaround_at: null,
  resolved_at: null,
  closed_at: null,
  created_at: "2026-10-05T12:30:00Z",
  updated_at: "2026-10-05T12:30:00Z",
  clocks: [],
  org: { id: ORG_SUBTEL, name: "SUBTEL (demo)" },
  pauses: [pause],
  remote: [remote],
};

const staff: DirectoryEntry[] = [
  {
    user_id: "usuario-agente",
    display_name: "Agente de turno",
    org_id: "yago",
    org_name: "Yago",
    role: "agente",
    email: null,
    phone_e164: null,
    is_staff: true,
  },
];

describe("lo que ve cada perfil en la ficha del ticket", () => {
  it("el reportante no ve controles de estado, asignación, pausa ni escalamiento", () => {
    renderWithProviders(
      <TicketActions ticket={ticket} ctx={sessionFor("reportante")} staff={staff} />,
      sessionFor("reportante"),
    );
    expect(screen.queryByText("Ficha de trabajo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cambiar estado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Asignar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reanudar reloj|Pausar reloj/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Escalar" })).not.toBeInTheDocument();
  });

  it("el agente ve la ficha de trabajo completa", () => {
    renderWithProviders(
      <TicketActions ticket={ticket} ctx={sessionFor("agente")} staff={staff} />,
      sessionFor("agente"),
    );
    expect(screen.getByText("Ficha de trabajo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar estado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Asignar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tomar el ticket" })).toBeInTheDocument();
    // Hay una pausa abierta: el agente puede reanudar.
    expect(screen.getByRole("button", { name: "Reanudar reloj" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escalar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marcar como incidente de seguridad" })).toBeInTheDocument();
    expect(screen.getByText("Hay una solicitud de acceso remoto pendiente de SUBTEL.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Cambiar estado" })).toHaveDisplayValue("Acusado");
  });

  it("solo la contraparte acusa pausas y habilita el acceso remoto", () => {
    const { unmount } = renderWithProviders(
      <>
        <PausesPanel ticket={ticket} ctx={sessionFor("contraparte")} now={NOW} />
        <RemoteAccessPanel ticket={ticket} ctx={sessionFor("contraparte")} />
      </>,
      sessionFor("contraparte"),
    );
    expect(screen.getByRole("button", { name: "Acusar pausa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Objetar pausa" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Habilitar acceso" })).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <>
        <PausesPanel ticket={ticket} ctx={sessionFor("reportante")} now={NOW} />
        <RemoteAccessPanel ticket={ticket} ctx={sessionFor("reportante")} />
      </>,
      sessionFor("reportante"),
    );
    expect(screen.getByText("Servidor de SUBTEL en mantención programada.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acusar pausa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Habilitar acceso" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revocar acceso" })).not.toBeInTheDocument();
  });

  it("el agente no acusa pausas en nombre de SUBTEL, pero puede revocar el acceso", () => {
    renderWithProviders(
      <>
        <PausesPanel ticket={ticket} ctx={sessionFor("agente")} now={NOW} />
        <RemoteAccessPanel ticket={ticket} ctx={sessionFor("agente")} />
      </>,
      sessionFor("agente"),
    );
    expect(screen.queryByRole("button", { name: "Acusar pausa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Habilitar acceso" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revocar acceso" })).toBeInTheDocument();
  });

  it("solo el personal de Yago puede escribir notas internas", () => {
    const { unmount } = renderWithProviders(
      <Timeline ticket={ticket} events={[]} ctx={sessionFor("reportante")} />,
      sessionFor("reportante"),
    );
    expect(screen.getByLabelText("Comentario")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Nota interna \(no visible para SUBTEL\)/)).not.toBeInTheDocument();
    unmount();
    renderWithProviders(
      <Timeline ticket={ticket} events={[]} ctx={sessionFor("agente")} />,
      sessionFor("agente"),
    );
    expect(screen.getByLabelText(/Nota interna \(no visible para SUBTEL\)/)).toBeInTheDocument();
  });
});
