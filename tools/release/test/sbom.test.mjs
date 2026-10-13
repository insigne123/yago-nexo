import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  aplanarLicenciasPnpm,
  clasificarNpm,
  componenteNpm,
  componentesPlataforma,
  componentesPropios,
  construirBom,
  licenciaCdx,
  licenciasDenegadas,
  purlNpm,
  resumen,
} from "../lib/sbom.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));

test("purl npm: el scope va con %40 y el nombre sin scope queda igual", () => {
  assert.equal(purlNpm("@nexo/console-api", "1.2.0"), "pkg:npm/%40nexo/console-api@1.2.0");
  assert.equal(purlNpm("@types/node", "22.20.5"), "pkg:npm/%40types/node@22.20.5");
  assert.equal(purlNpm("react", "19.3.0"), "pkg:npm/react@19.3.0");
  assert.equal(purlNpm("left-pad", "1.0.0+build.1"), "pkg:npm/left-pad@1.0.0%2Bbuild.1");
});

test("licencias: id SPDX simple, expresión compuesta y texto libre", () => {
  assert.deepEqual(licenciaCdx("MIT"), { license: { id: "MIT" } });
  assert.deepEqual(licenciaCdx("(MIT OR Apache-2.0)"), { expression: "MIT OR Apache-2.0" });
  assert.deepEqual(licenciaCdx("SEE LICENSE IN LICENSE"), { license: { name: "SEE LICENSE IN LICENSE" } });
});

test("pnpm licenses: resuelve Unknown con overrides y reporta lo que falta", () => {
  const crudo = {
    MIT: [{ name: "a", versions: ["1.0.0", "1.1.0"], homepage: "https://a.example" }],
    Unknown: [
      { name: "b", versions: ["2.0.0"] },
      { name: "c", versions: ["3.0.0"] },
    ],
  };
  const { paquetes, problemas } = aplanarLicenciasPnpm(crudo, { b: { licencia: "ISC" } });
  assert.deepEqual(
    paquetes.map((p) => `${p.nombre}@${p.version}:${p.licencia}`),
    ["a@1.0.0:MIT", "a@1.1.0:MIT", "b@2.0.0:ISC"],
  );
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /\bc\b/);
});

test("clasificación: lo de producción de los paquetes entregados es ejecución; el resto, desarrollo", () => {
  const todos = [
    { nombre: "express", version: "5.0.0", licencia: "MIT" },
    { nombre: "vitest", version: "5.0.3", licencia: "MIT" },
    { nombre: "express", version: "5.0.0", licencia: "MIT" },
  ];
  const ejecucion = [{ nombre: "express", version: "5.0.0", licencia: "MIT" }];
  const r = clasificarNpm(todos, ejecucion);
  assert.deepEqual(
    r.map((p) => `${p.nombre}:${p.uso}`),
    ["express:ejecucion", "vitest:desarrollo"],
  );
  const [exp, vit] = r.map(componenteNpm);
  assert.equal(exp.scope, "required");
  assert.equal(vit.scope, "excluded");
  assert.ok(vit.properties.some((p) => p.name === "cdx:npm:package:development" && p.value === "true"));
  assert.ok(!exp.properties.some((p) => p.name === "cdx:npm:package:development"));
});

test("copyleft fuerte en npm hace fallar el SBOM", () => {
  const r = licenciasDenegadas([
    { nombre: "x", version: "1.0.0", licencia: "GPL-3.0-only", uso: "desarrollo" },
    { nombre: "y", version: "1.0.0", licencia: "MIT", uso: "ejecucion" },
  ]);
  assert.equal(r.length, 1);
  assert.match(r[0], /x@1\.0\.0/);
});

test("componentes propios @nexo/*: purl correcto, licencia propia y uso", () => {
  const [lib, app] = componentesPropios([
    { nombre: "@nexo/shared", version: "1.2.0", ruta: "packages/shared", uso: "ejecucion" },
    { nombre: "@nexo/evidencias", version: "1.2.0", ruta: "tools/evidencias", uso: "desarrollo" },
  ]);
  assert.equal(lib.type, "library");
  assert.equal(lib.purl, "pkg:npm/%40nexo/shared@1.2.0");
  assert.equal(lib.scope, "required");
  assert.deepEqual(lib.licenses, [{ expression: "LicenseRef-Yago-Nexo" }]);
  assert.equal(app.type, "application");
  assert.equal(app.scope, "excluded");
});

test("componentes de plataforma: purls válidos y los del laboratorio quedan excluded", () => {
  const plataforma = JSON.parse(
    readFileSync(join(aqui, "..", "componentes-plataforma.json"), "utf8"),
  ).componentes;
  const comps = componentesPlataforma(plataforma);
  const purl =
    /^pkg:(docker|maven)\/[a-z0-9._-]+(\/[a-z0-9._-]+)*@[A-Za-z0-9._%-]+(\?repository_url=[a-z0-9.-]+)?$/;
  for (const c of comps) assert.match(c.purl, purl, `${c.name}: ${c.purl}`);
  const mi = comps.find((c) => c.name === "WSO2 Micro Integrator");
  assert.equal(mi.purl, "pkg:docker/wso2/wso2mi@4.6.0");
  const etcd = comps.find((c) => c.name === "etcd");
  assert.equal(etcd.purl, "pkg:docker/coreos/etcd@v3.6.5?repository_url=quay.io");
  assert.equal(comps.find((c) => c.name === "Apache APISIX").scope, "excluded");
  assert.equal(comps.find((c) => c.name === "Envoy").scope, "required");
});

test("BOM: CycloneDX 1.6, componentes ordenados y bom-ref únicos", () => {
  const propios = componentesPropios([
    { nombre: "@nexo/console-api", version: "1.2.0", ruta: "apps/console-api", uso: "ejecucion" },
  ]);
  const npm = clasificarNpm(
    [
      { nombre: "zod", version: "4.0.0", licencia: "MIT" },
      { nombre: "eslint", version: "10.0.0", licencia: "MIT" },
    ],
    [{ nombre: "zod", version: "4.0.0", licencia: "MIT" }],
  ).map(componenteNpm);
  const bom = construirBom({
    version: "1.2.0",
    timestamp: "2026-10-08T00:00:00.000Z",
    propios,
    plataforma: [],
    npm,
  });
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.metadata.component.version, "1.2.0");
  assert.deepEqual(
    bom.components.map((c) => c.name),
    ["@nexo/console-api", "eslint", "zod"],
  );
  const refs = bom.components.map((c) => c["bom-ref"]);
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(resumen(bom), { total: 3, ejecucion: 2, desarrollo: 1, laboratorio: 0, propios: 1 });
});
