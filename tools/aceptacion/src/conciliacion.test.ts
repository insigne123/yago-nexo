import { describe, expect, it } from "vitest";
import { conciliar, cumple, resumen, type Enviado, type Recepcion } from "./conciliacion.js";

const enviados = (n: number): Enviado[] =>
  Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    idempotencyKey: `k${i + 1}`,
    status: 202,
    correlacion: `c${i + 1}`,
  }));
const rec = (correlacion: string, status: number, resultado: Recepcion["resultado"]): Recepcion => ({
  en: "2026-10-13T00:00:00Z",
  correlacion,
  idempotencyKey: `k${correlacion.slice(1)}`,
  status,
  resultado,
});

/** Recepciones de una corrida sana: las primeras `fallas` reciben un 503 y luego se crean con el reintento. */
function corridaSana(n: number, fallas: number): Recepcion[] {
  const r: Recepcion[] = [];
  for (let i = 1; i <= fallas; i++) r.push(rec(`c${i}`, 503, "falla-simulada"));
  for (let i = fallas + 1; i <= n; i++) r.push(rec(`c${i}`, 201, "creado"));
  for (let i = 1; i <= fallas; i++) r.push(rec(`c${i}`, 201, "creado"));
  return r;
}

describe("conciliación por correlación (0-31)", () => {
  it("100 enviados = 100 entregados, 0 duplicados y las 10 fallas temporales recuperadas: cumple", () => {
    const c = conciliar(enviados(100), [...corridaSana(100, 10), rec("de-otra-corrida", 201, "creado")]);
    expect(c).toMatchObject({
      enviados: 100,
      aceptados: 100,
      entregados: 100,
      duplicados: 0,
      fallasTemporales: 10,
      recuperados: 10,
    });
    expect(c.filas[0]!.recepciones).toEqual(["503 falla-simulada", "201 creado"]);
    expect(cumple(c, 100, 10)).toEqual({ ok: true, motivos: [] });
    expect(resumen(c)).toMatch(/^100 enviados, 100 aceptados \(202\), 100 entregados, 0 duplicados/);
  });

  it("detecta un duplicado que /_estadisticas no mostraría (el mismo mensaje creado dos veces)", () => {
    const r = corridaSana(100, 10);
    r.push(rec("c50", 201, "creado"));
    const c = conciliar(enviados(100), r);
    expect(c.duplicados).toBe(1);
    expect(cumple(c, 100, 10).motivos).toContain("1 registros duplicados en el destino");
  });

  it("una repetición respondida por idempotencia no es un duplicado", () => {
    const r = corridaSana(100, 10);
    r.push(rec("c7", 201, "repeticion"));
    const c = conciliar(enviados(100), r);
    expect(c.duplicados).toBe(0);
    expect(c.repeticiones).toBe(1);
    expect(cumple(c, 100, 10).ok).toBe(true);
  });

  it("un mensaje que no llegó, uno no aceptado o una falla no recuperada hacen fallar", () => {
    const sinUno = conciliar(
      enviados(100),
      corridaSana(100, 10).filter((x) => !(x.correlacion === "c100" && x.resultado === "creado")),
    );
    expect(sinUno.sinEntregar.map((f) => f.n)).toEqual([100]);
    expect(cumple(sinUno, 100, 10).motivos).toContain("1 no llegaron al destino");

    const e = enviados(100);
    e[3] = { ...e[3]!, status: 502, correlacion: "" };
    const rechazado = conciliar(e, corridaSana(100, 10));
    expect(rechazado.noAceptados.map((x) => x.n)).toEqual([4]);
    expect(cumple(rechazado, 100, 10).ok).toBe(false);

    const noRecuperada = conciliar(
      enviados(100),
      corridaSana(100, 10).filter((x) => !(x.correlacion === "c1" && x.resultado === "creado")),
    );
    expect(cumple(noRecuperada, 100, 10).motivos).toContain(
      "1 mensajes con falla temporal no se recuperaron",
    );
  });

  it("exige que la falla inyectada haya ocurrido (no aprueba una corrida sin falla)", () => {
    const c = conciliar(enviados(100), corridaSana(100, 0));
    expect(cumple(c, 100, 10).motivos).toContain(
      "se inyectaron 10 fallas temporales y el destino respondió 0",
    );
  });
});
