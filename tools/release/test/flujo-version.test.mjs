// Contrato del flujo de versión (.github/workflows/release.yml): sin dependencias (corre en el job de neutralidad,
// que no instala paquetes), revisa el texto del workflow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const flujo = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");

test("una etiqueta v* solo publica si apunta a un commit que está en main", () => {
  const paso = flujo.slice(flujo.indexOf("La versión coincide"), flujo.indexOf("El CI de este commit"));
  assert.match(paso, /refs\/tags\/\*/);
  assert.match(paso, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(paso, /exit 1/);
});

test("la puerta del CI cuenta solo la corrida del push a main", () => {
  assert.match(flujo, /esperar-ci\.mjs --sha "\$GITHUB_SHA" --rama main/);
});
