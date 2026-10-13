import assert from "node:assert/strict";
import { test } from "node:test";
import { estadoCi } from "../lib/ci.mjs";

const corrida = (status, conclusion, n = 1) => ({ status, conclusion, html_url: `https://ci/${n}` });

test("verde si alguna corrida del commit terminó bien (por ejemplo, un reintento)", () => {
  assert.equal(
    estadoCi([corrida("completed", "failure", 1), corrida("completed", "success", 2)]).estado,
    "exito",
  );
});

test("espera mientras haya una corrida en curso y ninguna verde", () => {
  assert.equal(estadoCi([corrida("in_progress", null)]).estado, "esperar");
  assert.equal(estadoCi([corrida("completed", "failure", 1), corrida("queued", null, 2)]).estado, "esperar");
});

test("falla si todas terminaron y ninguna en verde (también si se cancelaron)", () => {
  const r = estadoCi([corrida("completed", "failure", 1), corrida("completed", "cancelled", 2)]);
  assert.equal(r.estado, "falla");
  assert.match(r.detalle, /cancelled/);
});

test("sin corridas todavía: no da el CI por bueno", () => {
  assert.equal(estadoCi([]).estado, "sin_corridas");
});
