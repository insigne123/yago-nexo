import { describe, expect, it } from "vitest";
import { compararAuditoria, compararTablas } from "./comparacion.js";
import type { ConteoTabla } from "./manifiesto.js";

const t = (tabla: string, filas: number, huella?: string): ConteoTabla => ({
  esquema: "nexo",
  tabla,
  filas,
  ...(huella ? { huella } : {}),
});
const respaldo = [t("audit_event", 227, "h1"), t("api_asset", 12, "h2"), t("vacia", 0, "0")];

describe("comparación de tablas", () => {
  it("igual en filas y contenido: ok", () => {
    const r = compararTablas(respaldo, [
      t("vacia", 0, "0"),
      t("api_asset", 12, "h2"),
      t("audit_event", 227, "h1"),
    ]);
    expect(r).toEqual({
      ok: true,
      tablasComparadas: 3,
      filasEsperadas: 239,
      filasObtenidas: 239,
      diferencias: [],
    });
  });

  it("una fila menos: falla", () => {
    const r = compararTablas(respaldo, [
      t("audit_event", 226, "h1"),
      t("api_asset", 12, "h2"),
      t("vacia", 0, "0"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.diferencias).toEqual([
      { tabla: "nexo.audit_event", tipo: "filas", detalle: "227 filas en el respaldo, 226 restauradas" },
    ]);
  });

  it("una fila de más también es una diferencia (debe ser exactamente igual)", () => {
    const r = compararTablas(respaldo, [
      t("audit_event", 228, "h1"),
      t("api_asset", 12, "h2"),
      t("vacia", 0, "0"),
    ]);
    expect(r.diferencias[0]?.tipo).toBe("filas");
  });

  it("mismas filas con otro contenido: falla por la huella", () => {
    const r = compararTablas(respaldo, [
      t("audit_event", 227, "otra"),
      t("api_asset", 12, "h2"),
      t("vacia", 0, "0"),
    ]);
    expect(r.diferencias).toEqual([
      { tabla: "nexo.audit_event", tipo: "contenido", detalle: expect.stringMatching(/huella/) },
    ]);
  });

  it("sin huella en el respaldo, compara solo filas", () => {
    expect(compararTablas([t("a", 3)], [t("a", 3, "cualquiera")]).ok).toBe(true);
  });

  it("tabla faltante y tabla sobrante", () => {
    const r = compararTablas(respaldo, [t("audit_event", 227, "h1"), t("vacia", 0, "0"), t("nueva", 4)]);
    expect(r.ok).toBe(false);
    expect(r.tablasComparadas).toBe(2);
    expect(r.diferencias.map((d) => [d.tabla, d.tipo])).toEqual([
      ["nexo.api_asset", "falta"],
      ["nexo.nueva", "sobra"],
    ]);
    expect(r.filasObtenidas).toBe(231);
  });

  it("distingue esquemas con tablas del mismo nombre", () => {
    const a: ConteoTabla = { esquema: "public", tabla: "x", filas: 1 };
    const b: ConteoTabla = { esquema: "otro", tabla: "x", filas: 2 };
    expect(compararTablas([a, b], [b, a]).ok).toBe(true);
    expect(
      compararTablas(
        [a, b],
        [
          { ...a, filas: 2 },
          { ...b, filas: 1 },
        ],
      ).diferencias,
    ).toHaveLength(2);
  });
});

describe("sonda de la cadena de auditoría", () => {
  const esperado = { eventos: 227, ultimoSeq: 227, ultimoHash: "f".repeat(64) };

  it("misma cantidad, mismo último evento y cadena verificada: ok", () => {
    const r = compararAuditoria(
      esperado,
      { ...esperado },
      { ok: true, count: 227, lastSeq: 227, lastHash: "f".repeat(64) },
    );
    expect(r.ok).toBe(true);
    expect(r.problemas).toEqual([]);
  });

  it("falta el último evento", () => {
    const r = compararAuditoria(
      esperado,
      { eventos: 226, ultimoSeq: 226, ultimoHash: "e".repeat(64) },
      { ok: true, count: 226, lastSeq: 226, lastHash: "e".repeat(64) },
    );
    expect(r.ok).toBe(false);
    expect(r.problemas.join(" ")).toMatch(/eventos: 227 en el respaldo, 226/);
    expect(r.problemas.join(" ")).toMatch(/hash del último evento/);
  });

  it("cadena restaurada rota", () => {
    const r = compararAuditoria(
      esperado,
      { ...esperado },
      { ok: false, count: 99, brokenAt: 100, reason: "hash" },
    );
    expect(r.ok).toBe(false);
    expect(r.problemas).toEqual(["la cadena restaurada no se verifica: se rompe en el seq 100 (hash)"]);
  });

  it("cadena vacía en ambos lados", () => {
    const vacia = { eventos: 0, ultimoSeq: null, ultimoHash: null };
    expect(
      compararAuditoria(vacia, { ...vacia }, { ok: true, count: 0, lastSeq: 0, lastHash: "0".repeat(64) }).ok,
    ).toBe(true);
  });
});
