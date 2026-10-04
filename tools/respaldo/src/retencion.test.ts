import { describe, expect, it } from "vitest";
import { fechaDeId } from "./manifiesto.js";
import { decidirRetencion } from "./retencion.js";

const ahora = new Date("2026-10-04T12:00:00Z");
const ids = [
  "20261004T020000Z",
  "20261003T020000Z",
  "20261002T020000Z",
  "20261001T020000Z",
  "20260920T020000Z",
  "20260801T020000Z",
];
// Desordenados a propósito: la decisión no debe depender del orden en que se listan.
const respaldos = [ids[3], ids[0], ids[5], ids[1], ids[4], ids[2]].map((id) => ({
  id: id!,
  fecha: fechaDeId(id!)!,
}));

describe("retención", () => {
  it("conserva los N más recientes y borra el resto", () => {
    const d = decidirRetencion(respaldos, { conservar: 3 }, ahora);
    expect(d.conservar).toEqual(ids.slice(0, 3));
    expect(d.borrar.map((b) => b.id)).toEqual(ids.slice(3));
    expect(d.borrar[0]!.motivo).toMatch(/fuera de los 3 más recientes/);
    expect(d.avisos).toEqual([]);
  });

  it("con máximo de días, borra también los antiguos aunque estén entre los N", () => {
    const d = decidirRetencion(respaldos, { conservar: 10, maximoDias: 7 }, ahora);
    expect(d.conservar).toEqual(ids.slice(0, 4));
    expect(d.borrar.map((b) => b.id)).toEqual(ids.slice(4));
    expect(d.borrar[0]!.motivo).toMatch(/máximo de 7 días/);
  });

  it("nunca borra el más reciente, aunque supere el máximo (y avisa)", () => {
    const viejos = respaldos.filter((r) => r.id < "20261001");
    const d = decidirRetencion(viejos, { conservar: 3, maximoDias: 7 }, ahora);
    expect(d.conservar).toEqual(["20260920T020000Z"]);
    expect(d.borrar.map((b) => b.id)).toEqual(["20260801T020000Z"]);
    expect(d.avisos[0]).toMatch(/no hay respaldos nuevos/);
  });

  it("sin respaldos no hace nada; con uno, lo conserva", () => {
    expect(decidirRetencion([], { conservar: 1 }, ahora)).toEqual({ conservar: [], borrar: [], avisos: [] });
    expect(decidirRetencion(respaldos.slice(0, 1), { conservar: 1 }, ahora).borrar).toEqual([]);
  });

  it("rechaza políticas inválidas", () => {
    expect(() => decidirRetencion(respaldos, { conservar: 0 }, ahora)).toThrow(/conservar/);
    expect(() => decidirRetencion(respaldos, { conservar: 2.5 }, ahora)).toThrow(/conservar/);
    expect(() => decidirRetencion(respaldos, { conservar: 2, maximoDias: -1 }, ahora)).toThrow(/maximoDias/);
  });
});
