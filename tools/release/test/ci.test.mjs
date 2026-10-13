import assert from "node:assert/strict";
import { test } from "node:test";
import { estadoCi } from "../lib/ci.mjs";

const corrida = (status, conclusion, n = 1, extra = {}) => ({
  status,
  conclusion,
  html_url: `https://ci/${n}`,
  event: "push",
  head_branch: "main",
  run_number: n,
  ...extra,
});

test("verde si la corrida más reciente del push a main terminó bien (un reintento actualiza la misma corrida)", () => {
  assert.equal(
    estadoCi([corrida("completed", "success", 2), corrida("completed", "failure", 1)]).estado,
    "exito",
  );
  // La API devuelve la corrida reintentada con su último resultado.
  assert.equal(estadoCi([corrida("completed", "success", 1, { run_attempt: 2 })]).estado, "exito");
});

test("espera mientras la corrida del push a main siga en curso", () => {
  assert.equal(estadoCi([corrida("in_progress", null)]).estado, "esperar");
  assert.equal(estadoCi([corrida("completed", "failure", 1), corrida("queued", null, 2)]).estado, "esperar");
});

test("falla si la corrida más reciente terminó en rojo o cancelada", () => {
  const r = estadoCi([corrida("completed", "success", 1), corrida("completed", "cancelled", 2)]);
  assert.equal(r.estado, "falla");
  assert.match(r.detalle, /cancelled/);
});

test("una corrida verde de un pull_request o de otra rama no habilita la versión si el push a main está en rojo", () => {
  const corridas = [
    corrida("completed", "failure", 10),
    corrida("completed", "success", 11, { event: "pull_request", head_branch: "trabajo/x" }),
    corrida("completed", "success", 12, { head_branch: "trabajo/x" }),
  ];
  const r = estadoCi(corridas);
  assert.equal(r.estado, "falla");
});

test("sin corrida del push a main: no da el CI por bueno aunque haya otras", () => {
  assert.equal(estadoCi([]).estado, "sin_corridas");
  const r = estadoCi([corrida("completed", "success", 3, { event: "pull_request" })]);
  assert.equal(r.estado, "sin_corridas");
  assert.match(r.detalle, /se ignoraron 1/);
});

test("la rama se puede indicar", () => {
  assert.equal(
    estadoCi([corrida("completed", "success", 1, { head_branch: "release/1.2" })], { rama: "release/1.2" })
      .estado,
    "exito",
  );
});
