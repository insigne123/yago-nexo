import { describe, expect, it } from "vitest";
import { compararTablas } from "./comparacion.js";
import {
  calcularTotalesInforme,
  FORMATO_INFORME,
  informeMarkdown,
  tamano,
  type InformeRestauracion,
} from "./informe.js";

function informe(diferencia: boolean): InformeRestauracion {
  const comparacion = compararTablas(
    [{ esquema: "nexo", tabla: "alert", filas: 44 }],
    [{ esquema: "nexo", tabla: "alert", filas: diferencia ? 43 : 44 }],
  );
  const servidores: InformeRestauracion["servidores"] = [
    {
      nombre: "principal",
      versionOrigen: "16.15",
      versionPrueba: "16.15",
      contenedor: "nexo-respaldo-prueba-principal-1",
      arranqueMs: 3000,
      globales: { ok: true, ms: 100 },
      bases: [
        {
          nombre: "nexo",
          bytes: 87_000,
          restauracionMs: 600,
          comparacion,
          auditoria: null,
          ok: comparacion.ok,
        },
        {
          nombre: "no-comparada",
          bytes: 10,
          restauracionMs: 0,
          comparacion: null,
          auditoria: null,
          ok: false,
          error: "x",
        },
      ],
      ok: comparacion.ok,
    },
  ];
  return {
    formato: FORMATO_INFORME,
    respaldo: "20261004T163323Z",
    instanteRespaldo: "2026-10-04T16:33:23.610Z",
    herramienta: { nombre: "@nexo/respaldo", version: "1.0.0" },
    imagen: "postgres:16-alpine",
    inicio: "2026-10-04T16:40:00.000Z",
    fin: "2026-10-04T16:40:17.000Z",
    resultado: comparacion.ok ? "exitosa" : "fallida",
    interrumpida: false,
    rtoMedidoMs: 13_900,
    duracionTotalMs: 16_700,
    objetivos: { rtoMinutos: 60, rpoHoras: 24 },
    antiguedadRespaldoHoras: 0.1,
    archivos: { verificados: 9, bytes: 2_127_825, ms: 30, ok: true },
    servidores,
    totales: calcularTotalesInforme(servidores),
    errores: [],
    avisos: [],
  };
}

describe("informe de restauración", () => {
  it("los totales cuentan solo las bases comparadas", () => {
    expect(informe(false).totales).toEqual({
      bases: 1,
      tablasComparadas: 1,
      filasComparadas: 44,
      diferencias: 0,
    });
  });

  it("el Markdown dice el resultado, el RTO frente al objetivo y cada diferencia", () => {
    const ok = informeMarkdown(informe(false));
    expect(ok).toContain("**Resultado:** EXITOSA");
    expect(ok).toContain("**RTO medido:** 13,9 s · objetivo 60 min (cumple)");
    expect(ok).toContain("| nexo | 85,0 KiB | 0,6 s | 1 | 44 | 0 | ok |");
    const mal = informeMarkdown(informe(true));
    expect(mal).toContain("**Resultado:** FALLIDA");
    expect(mal).toContain("- `nexo.alert` (filas): 44 filas en el respaldo, 43 restauradas");
  });

  it("tamaños legibles", () => {
    expect(tamano(1076)).toBe("1,1 KiB");
    expect(tamano(2_127_825)).toBe("2,03 MiB");
  });
});
