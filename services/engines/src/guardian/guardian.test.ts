import { describe as suite, expect, it } from "vitest";
import { detect, isBusinessHours, mad, median, zThreshold, type WindowSample } from "./detect.js";
import { buildQuery, parseSeries } from "./series.js";

const w = (value: number, calls = value, errors = 0): WindowSample => ({ value, calls, errors });

suite("estadística robusta", () => {
  it("mediana y MAD no se dejan arrastrar por un pico aislado", () => {
    const xs = [10, 12, 11, 9, 10, 500];
    expect(median(xs)).toBe(10.5);
    expect(mad(xs)).toBe(1);
  });

  it("más sensibilidad, umbral más bajo", () => {
    expect(zThreshold(10)).toBe(2);
    expect(zThreshold(1)).toBeGreaterThan(zThreshold(5));
  });
});

suite("detección por métrica", () => {
  const steady = Array.from({ length: 60 }, (_, i) => w(100 + (i % 5) * 4));

  it("marca un pico de volumen muy por encima de la línea base", () => {
    const d = detect("volumen", w(900), steady, 5, 30);
    expect(d.anomalous).toBe(true);
    expect(d.baseline).toBe(108);
    expect(d.reason).toMatch(/900 llamadas/);
  });

  it("no marca la variación normal ni las caídas", () => {
    expect(detect("volumen", w(118), steady, 5, 30).anomalous).toBe(false);
    expect(detect("volumen", w(5), steady, 5, 30).anomalous).toBe(false);
  });

  it("un consumidor nuevo con tráfico moderado no es anomalía; uno que irrumpe sí", () => {
    const empty = Array.from({ length: 60 }, () => w(0));
    expect(detect("volumen", w(40), empty, 4, 30).anomalous).toBe(false);
    expect(detect("volumen", w(600), empty, 4, 30).anomalous).toBe(true);
  });

  it("errores: exige volumen mínimo y al menos 5 errores", () => {
    const clean = Array.from({ length: 60 }, () => w(0, 100, 0));
    expect(detect("errores", w(0.6, 100, 60), clean, 5, 30).anomalous).toBe(true);
    expect(detect("errores", w(0.5, 8, 4), clean, 5, 30).anomalous).toBe(false);
  });

  it("fuera de horario: alerta por volumen solo fuera del horario hábil", () => {
    expect(detect("fuera_de_horario", w(50), [], 5, 30, true).anomalous).toBe(true);
    expect(detect("fuera_de_horario", w(50), [], 5, 30, false).anomalous).toBe(false);
  });
});

suite("horario hábil en Chile", () => {
  it("lunes 10:00 en Santiago es hábil; sábado y 23:00 no", () => {
    expect(isBusinessHours(new Date("2026-10-05T13:00:00Z"))).toBe(true); // lun 10:00 (UTC−3)
    expect(isBusinessHours(new Date("2026-10-10T13:00:00Z"))).toBe(false); // sábado
    expect(isBusinessHours(new Date("2026-10-06T02:00:00Z"))).toBe(false); // lun 23:00
  });
});

suite("series desde OpenSearch", () => {
  it("rellena con ceros las ventanas sin llamadas y deja la actual al final", () => {
    const from = 1_800_000_000_000;
    const step = 60_000;
    const res = {
      aggregations: {
        consumidores: {
          buckets: [
            {
              key: "app-1",
              nombre: { buckets: [{ key: "OperadorDemo" }] },
              dueno: { buckets: [{ key: "admin" }] },
              ip: { top: { buckets: [{ key: "10.0.0.7" }] } },
              ventanas: { buckets: [{ key: from, doc_count: 4, errores: { doc_count: 1 } }, { key: from + 2 * step, doc_count: 50, errores: { doc_count: 0 } }] },
            },
          ],
        },
      },
    };
    const [s] = parseSeries("volumen", res, from, from + 3 * step, 60);
    expect(s).toMatchObject({ applicationId: "app-1", name: "OperadorDemo", owner: "admin", topIp: "10.0.0.7" });
    expect(s!.windows.map((x) => x.calls)).toEqual([4, 0, 50]);
    const q = buildQuery("latencia", from, from + 3 * step, 60, { apiId: "api-9" }) as { query: { bool: { filter: unknown[] } } };
    expect(JSON.stringify(q.query.bool.filter)).toContain("api-9");
  });
});

suite("acción efectiva del guardián", async () => {
  const { effectiveAction } = await import("./engine.js");
  it("bloquea según la regla en el caso normal", () => {
    expect(effectiveAction("bloquear_automatico", false, false)).toBe("bloquear_automatico");
    expect(effectiveAction("bloquear_con_aprobacion", false, false)).toBe("bloquear_con_aprobacion");
  });
  it("solo alerta si una persona liberó al consumidor después del inicio de la ventana", () => {
    expect(effectiveAction("bloquear_automatico", false, true)).toBe("alertar");
    expect(effectiveAction("bloquear_con_aprobacion", false, true)).toBe("alertar");
  });
  it("las aplicaciones excluidas nunca se bloquean", () => {
    expect(effectiveAction("bloquear_automatico", true, false)).toBe("alertar");
    expect(effectiveAction("alertar", false, false)).toBe("alertar");
  });
});
