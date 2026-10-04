import { describe, expect, it } from "vitest";
import { sortQueue } from "./queue";
import type { SlaClockRow, TicketWithClocks } from "./types";

function ticket(
  id: string,
  severity: TicketWithClocks["severity"],
  due: string | null,
  created: string,
): TicketWithClocks {
  const clocks: SlaClockRow[] = due
    ? [
        {
          id: `${id}-c`,
          ticket_id: id,
          metric: "acuse",
          calendar: "24x7",
          target_minutes: 60,
          started_at: created,
          due_at: due,
          met_at: null,
          breached_at: null,
          paused_seconds: 0,
          paused_since: null,
          remaining_seconds_at_pause: null,
          status: "en_curso",
          notified_50_at: null,
          notified_80_at: null,
          notified_100_at: null,
        },
      ]
    : [];
  return { id, severity, created_at: created, clocks } as unknown as TicketWithClocks;
}

describe("orden de la bandeja", () => {
  const tickets = [
    ticket("a", "S3", "2026-10-06T12:00:00Z", "2026-10-05T10:00:00Z"),
    ticket("b", "S1", "2026-10-05T14:00:00Z", "2026-10-05T13:00:00Z"),
    ticket("c", "S2", null, "2026-10-05T09:00:00Z"),
    ticket("d", "S4", "2026-10-05T13:30:00Z", "2026-10-05T08:00:00Z"),
  ];

  it("por vencimiento: primero el plazo más próximo; sin plazos corriendo al final", () => {
    expect(sortQueue(tickets, "vencimiento").map((t) => t.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("por severidad y por recepción", () => {
    expect(sortQueue(tickets, "severidad").map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
    expect(sortQueue(tickets, "recepcion").map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
  });
});
