import { describe, expect, it } from "vitest";
import { describeClock, formatDuration, formatDurationLong, isBreached, nextDue } from "./sla";
import type { SlaClockRow } from "./types";

const NOW = new Date("2026-10-05T13:00:00Z"); // lunes 05-10-2026 10:00 en Santiago

function clock(overrides: Partial<SlaClockRow> = {}): SlaClockRow {
  return {
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
    ...overrides,
  };
}

describe("formato de duraciones", () => {
  it("usa la unidad más útil", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(12 * 60 + 59)).toBe("12 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 05 min");
    expect(formatDuration(2 * 86400 + 4 * 3600 + 30 * 60)).toBe("2 d 4 h");
    expect(formatDuration(86400)).toBe("1 d");
    expect(formatDuration(-90)).toBe("1 min");
  });

  it("tiene una versión larga para lectores de pantalla", () => {
    expect(formatDurationLong(3600 + 60)).toBe("1 hora y 1 minuto");
    expect(formatDurationLong(2 * 86400 + 3 * 3600)).toBe("2 días y 3 horas");
    expect(formatDurationLong(30)).toBe("30 segundos");
  });
});

describe("estado de un reloj", () => {
  it("en curso muestra cuánto queda", () => {
    const view = describeClock(clock(), NOW);
    expect(view.state).toBe("corriendo");
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Quedan 30 min");
    expect(view.remainingSeconds).toBe(1800);
    expect(view.ariaLabel).toContain("Acuse: quedan 30 minutos");
  });

  it("pasa a alerta al acercarse al vencimiento o cuando sd_tick avisó el 80 %", () => {
    expect(describeClock(clock({ due_at: "2026-10-05T13:10:00Z" }), NOW).tone).toBe("alerta");
    expect(
      describeClock(
        clock({
          calendar: "habil",
          target_minutes: 480,
          due_at: "2026-10-06T21:00:00Z",
          notified_80_at: "2026-10-05T12:00:00Z",
        }),
        NOW,
      ).tone,
    ).toBe("alerta");
  });

  it("en pausa congela lo que quedaba (con la indicación de horas hábiles)", () => {
    const view = describeClock(
      clock({
        status: "pausado",
        paused_since: "2026-10-05T12:50:00Z",
        remaining_seconds_at_pause: 40 * 60,
        calendar: "habil",
      }),
      NOW,
    );
    expect(view.state).toBe("en_pausa");
    expect(view.tone).toBe("pausa");
    expect(view.label).toBe("En pausa · quedan 40 min hábiles");
    expect(view.ariaLabel).toContain("reloj en pausa");
    // El tiempo no avanza mientras está en pausa.
    expect(
      describeClock(
        clock({ status: "pausado", remaining_seconds_at_pause: 2400 }),
        new Date("2026-10-06T00:00:00Z"),
      ).label,
    ).toBe("En pausa · quedan 40 min");
  });

  it("vencido se muestra en rojo aunque sd_tick todavía no lo haya marcado", () => {
    const view = describeClock(clock({ due_at: "2026-10-05T12:45:00Z" }), NOW);
    expect(view.state).toBe("vencido");
    expect(view.tone).toBe("peligro");
    expect(view.label).toBe("Vencido hace 15 min");
    expect(isBreached([clock({ due_at: "2026-10-05T12:45:00Z" })], NOW)).toBe(true);
  });

  it("incumplido sin cumplir sigue vencido; cumplido tarde y a tiempo se distinguen", () => {
    expect(describeClock(clock({ status: "incumplido", due_at: "2026-10-05T12:00:00Z" }), NOW).label).toBe(
      "Vencido hace 1 h 00 min",
    );
    expect(describeClock(clock({ status: "cumplido", met_at: "2026-10-05T12:40:00Z" }), NOW).state).toBe(
      "cumplido",
    );
    const late = describeClock(
      clock({ status: "incumplido", met_at: "2026-10-05T12:50:00Z", breached_at: "2026-10-05T12:45:00Z" }),
      NOW,
    );
    expect(late.state).toBe("cumplido_tarde");
    expect(late.tone).toBe("peligro");
  });

  it("sin plazo comprometido (S4: diagnóstico y solución)", () => {
    const view = describeClock(
      clock({ metric: "diagnostico", status: "no_aplica", target_minutes: null, due_at: null }),
      NOW,
    );
    expect(view.state).toBe("sin_plazo");
    expect(view.label).toBe("Sin plazo comprometido");
  });

  it("el próximo vencimiento ignora relojes en pausa o cumplidos", () => {
    const clocks = [
      clock({ id: "a", due_at: "2026-10-05T15:00:00Z" }),
      clock({ id: "b", due_at: "2026-10-05T14:00:00Z", status: "pausado" }),
      clock({ id: "c", due_at: "2026-10-05T13:59:00Z", status: "cumplido", met_at: "2026-10-05T12:59:00Z" }),
    ];
    expect(nextDue(clocks)).toBe("2026-10-05T15:00:00Z");
    expect(nextDue([])).toBeNull();
  });
});
