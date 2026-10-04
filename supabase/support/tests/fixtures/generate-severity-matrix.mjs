// Regenera severity_matrix.json desde classifySeverity (packages/shared/src/severity.ts).
// Uso (desde la raíz del repositorio):
//   pnpm --filter @nexo/shared build && node supabase/support/tests/fixtures/generate-severity-matrix.mjs
// Después de regenerarla, ajuste nexo_private.sd_classify si la regla cambió: las pruebas de
// Vitest (apps/support-web) y de SQL (02_clasificacion.sql) comparan ambas contra este archivo.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifySeverity } from "../../../../packages/shared/dist/browser.js";

const keys = [
  "esConsultaOCambio",
  "servicioProductivoCaido",
  "existeAlternativa",
  "degradacionOSeguridad",
  "soloNoProductivoOMenor",
];

const casos = [];
for (let mask = 0; mask < 2 ** keys.length; mask++) {
  const answers = {};
  keys.forEach((key, i) => {
    answers[key] = Boolean(mask & (1 << (keys.length - 1 - i)));
  });
  const { severity, rule } = classifySeverity(answers);
  casos.push({ answers, severity, rule });
}

const out = {
  descripcion:
    "Matriz completa (32 combinaciones) de classifySeverity de packages/shared/src/severity.ts. La verifican la prueba de Vitest de apps/support-web (contra TypeScript) y supabase/support/tests/02_clasificacion.sql (contra nexo_private.sd_classify). Se regenera con supabase/support/tests/fixtures/generate-severity-matrix.mjs.",
  claves: keys,
  casos,
};

const target = fileURLToPath(new URL("./severity_matrix.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Escrito ${target} (${casos.length} casos)`);
