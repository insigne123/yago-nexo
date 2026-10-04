import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SlaClockRow } from "../lib/types";
import { SlaClock, SlaClocks } from "./SlaClock";

const NOW = new Date("2026-10-05T13:00:00Z");

const base: SlaClockRow = {
  id: "c1",
  ticket_id: "t1",
  metric: "acuse",
  calendar: "24x7",
  target_minutes: 60,
  started_at: "2026-10-05T12:30:00Z",
  due_at: "2026-10-05T13:30:00Z",
  met_at: null,
  breached_at: null,
  paused_seconds: 0,
  paused_since: null,
  remaining_seconds_at_pause: null,
  status: "en_curso",
  notified_50_at: null,
  notified_80_at: null,
  notified_100_at: null,
};

describe("reloj SLA en pantalla", () => {
  it("muestra el indicador de pausa y el tiempo congelado", () => {
    render(<SlaClock clock={{ ...base, status: "pausado", remaining_seconds_at_pause: 1500 }} now={NOW} />);
    const group = screen.getByRole("group", { name: /Acuse: reloj en pausa, quedan 25 minutos/ });
    expect(group).toHaveAttribute("data-estado", "en_pausa");
    expect(screen.getByText("PAUSA")).toBeInTheDocument();
    expect(screen.getByText("En pausa · quedan 25 min")).toBeInTheDocument();
  });

  it("marca en rojo un plazo vencido", () => {
    render(<SlaClock clock={{ ...base, due_at: "2026-10-05T12:00:00Z" }} now={NOW} />);
    const group = screen.getByRole("group", { name: /plazo vencido hace 1 hora/ });
    expect(group).toHaveAttribute("data-tono", "peligro");
    expect(group.className).toContain("text-red-800");
    expect(screen.getByText("Vencido hace 1 h 00 min")).toBeInTheDocument();
  });

  it("ordena acuse, diagnóstico y solución", () => {
    render(
      <SlaClocks
        clocks={[
          { ...base, id: "s", metric: "solucion", due_at: "2026-10-05T16:30:00Z" },
          { ...base, id: "a", metric: "acuse" },
          { ...base, id: "d", metric: "diagnostico", due_at: "2026-10-05T14:30:00Z" },
        ]}
        now={NOW}
      />,
    );
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label")?.split(":")[0])).toEqual([
      "Acuse",
      "Diagnóstico",
      "Solución",
    ]);
  });
});
