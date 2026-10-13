import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  comprobarConsistencia,
  documentoVex,
  filasDesdeGrype,
  purlImagen,
  resumenPorImagen,
  tablaJson,
  tablaMarkdown,
  validarDecision,
} from "../lib/vulnerabilidades.mjs";

const aqui = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(aqui, "fixtures", n), "utf8"));
const entradas = [
  { imagen: "ghcr.io/ejemplo/nexo-console-api:1.2.0", tipo: "propia", grype: fixture("grype-consola.json") },
  { imagen: "wso2/wso2mi:4.6.0", tipo: "tercero", grype: fixture("grype-integrador.json") },
];
const comun = (decisiones = []) => ({
  version: "1.2.0",
  generado: "2026-10-08T00:00:00.000Z",
  herramienta: "grype 0.119.0",
  entradas,
  filas: filasDesdeGrype(entradas),
  decisiones,
});

test("purl de imágenes: Docker Hub, library, GHCR y digest", () => {
  assert.equal(purlImagen("wso2/wso2mi:4.6.0"), "pkg:docker/wso2/wso2mi@4.6.0");
  assert.equal(purlImagen("nginx:alpine"), "pkg:docker/library/nginx@alpine");
  assert.equal(
    purlImagen("ghcr.io/ejemplo/nexo-motores:1.2.0"),
    "pkg:docker/ejemplo/nexo-motores@1.2.0?repository_url=ghcr.io",
  );
  assert.equal(
    purlImagen("ghcr.io/ejemplo/nexo-motores@sha256:abc"),
    "pkg:docker/ejemplo/nexo-motores@sha256%3Aabc?repository_url=ghcr.io",
  );
});

test("filas: una por imagen, paquete y vulnerabilidad; las ubicaciones repetidas se cuentan", () => {
  const filas = filasDesdeGrype(entradas);
  assert.equal(filas.length, 3);
  assert.equal(filas[0].severidad, "Critical");
  assert.equal(filas[0].paquete, "bcprov-jdk18on");
  assert.equal(filas[0].ubicaciones, 2);
  assert.deepEqual(filas[0].alias, ["CVE-2026-8763"]);
  assert.deepEqual(
    filas.map((f) => f.severidad),
    ["Critical", "High", "Medium"],
  );
});

test("resumen: incluye las imágenes sin hallazgos", () => {
  const r = resumenPorImagen(entradas, filasDesdeGrype(entradas));
  assert.equal(r.length, 2);
  assert.equal(r[0].total, 0);
  assert.equal(r[1].Critical, 1);
  assert.equal(r[1].total, 3);
});

test("Markdown: todas las filas, sin cortar, y escapa las barras", () => {
  const larga = {
    imagen: "x:1",
    tipo: "propia",
    grype: {
      matches: [
        {
          vulnerability: { id: "CVE-1|2", severity: "Low", fix: { versions: [], state: "not-fixed" } },
          artifact: { name: "p".repeat(300), version: "1", type: "npm" },
        },
      ],
    },
  };
  const md = tablaMarkdown({
    ...comun(),
    entradas: [...entradas, larga],
    filas: filasDesdeGrype([...entradas, larga]),
  });
  const filasDetalle = md.split("\n").filter((l) => /^\| (Crítica|Alta|Media|Baja) \|/.test(l));
  assert.equal(filasDetalle.length, 4);
  assert.ok(md.includes("p".repeat(300)), "el nombre largo no se corta");
  assert.ok(md.includes("CVE-1\\|2"));
  assert.match(md, /\| \*\*Total\*\* \|/);
});

test("JSON: misma información y estado VEX de las críticas", () => {
  const j = tablaJson(comun());
  assert.equal(j.vulnerabilidades.length, 3);
  assert.equal(j.vulnerabilidades[0].estadoVex, "under_investigation");
  assert.equal(j.vulnerabilidades[1].estadoVex, null);
});

test("OpenVEX: una declaración por crítica, sin análisis = under_investigation con notas", () => {
  const vex = documentoVex({ ...comun(), autor: "Yago", idDocumento: "urn:uuid:1" });
  assert.equal(vex["@context"], "https://openvex.dev/ns/v0.2.0");
  assert.equal(vex.statements.length, 1);
  const st = vex.statements[0];
  assert.equal(st.vulnerability.name, "GHSA-9pwp-9qqc-pr26");
  assert.deepEqual(st.vulnerability.aliases, ["CVE-2026-8763"]);
  assert.equal(st.status, "under_investigation");
  assert.match(st.status_notes, /1\.85/);
  assert.equal(st.products[0]["@id"], "pkg:docker/wso2/wso2mi@4.6.0");
  assert.equal(st.products[0].subcomponents.length, 1);
});

test("OpenVEX: aplica la decisión registrada (por alias) con su justificación", () => {
  const decision = {
    id: "CVE-2026-8763",
    status: "not_affected",
    justification: "vulnerable_code_not_in_execute_path",
    impact_statement: "Texto de prueba.",
  };
  const vex = documentoVex({ ...comun([decision]), autor: "Yago", idDocumento: "urn:uuid:1" });
  const st = vex.statements[0];
  assert.equal(st.status, "not_affected");
  assert.equal(st.justification, "vulnerable_code_not_in_execute_path");
  assert.equal(st.status_notes, undefined);
});

test("decisiones inválidas: not_affected sin justificación y affected sin acción", () => {
  assert.equal(validarDecision({ id: "CVE-1", status: "not_affected" }).length, 1);
  assert.equal(validarDecision({ id: "CVE-1", status: "affected" }).length, 1);
  assert.equal(
    validarDecision({ id: "CVE-1", status: "not_affected", justification: "porque_si" }).length,
    1,
  );
  assert.equal(validarDecision({ id: "CVE-1", status: "fixed" }).length, 0);
  assert.throws(
    () =>
      documentoVex({
        ...comun([{ id: "CVE-1", status: "afectado" }]),
        autor: "Yago",
        idDocumento: "urn:uuid:1",
      }),
    /vex-decisiones\.json inválido/,
  );
});

test("vex-decisiones.json del repositorio es válido", () => {
  const { decisiones } = JSON.parse(readFileSync(join(aqui, "..", "vex-decisiones.json"), "utf8"));
  assert.deepEqual(decisiones.flatMap(validarDecision), []);
});

test("consistencia: tabla, JSON y OpenVEX coinciden y detecta filas o críticas que faltan", () => {
  const c = comun();
  const vex = documentoVex({ ...c, autor: "Yago", idDocumento: "urn:uuid:1" });
  const markdown = tablaMarkdown(c);
  const json = tablaJson(c);
  assert.deepEqual(comprobarConsistencia({ markdown, json, vex }), []);
  const recortada = markdown.split("\n").slice(0, -2).join("\n");
  assert.ok(comprobarConsistencia({ markdown: recortada, json, vex }).some((e) => /filas/.test(e)));
  const sinVex = { ...vex, statements: [] };
  assert.ok(
    comprobarConsistencia({ markdown, json, vex: sinVex }).some((e) => /no tiene declaración/.test(e)),
  );
});
