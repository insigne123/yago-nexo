import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface LintIssue {
  code: string;
  message: string;
  path: string[];
  severity: 0 | 1 | 2 | 3; // 0 error, 1 warn, 2 info, 3 hint (formato Spectral)
  range?: { start: { line: number; character: number } };
}

export interface LintResult {
  errors: LintIssue[];
  warnings: LintIssue[];
  infos: LintIssue[];
}

const SEVERITY_LABEL = ["error", "advertencia", "info", "sugerencia"] as const;

function spectralBin(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@stoplight/spectral-cli/package.json");
  return join(dirname(pkg), "dist", "index.js");
}

/** Valida un contrato contra la guía de estilo con Spectral (D-03). */
export function lintContract(contractPath: string, rulesetPath: string): LintResult {
  const res = spawnSync(
    process.execPath,
    [spectralBin(), "lint", contractPath, "--ruleset", rulesetPath, "--format", "json", "--quiet", "--fail-severity", "error"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const out = (res.stdout ?? "").trim();
  let issues: LintIssue[] = [];
  if (out.startsWith("[")) {
    issues = JSON.parse(out) as LintIssue[];
  } else if (res.status !== 0 && res.status !== 1) {
    throw new Error(`Spectral falló (código ${res.status}): ${res.stderr || out}`);
  }
  return {
    errors: issues.filter((i) => i.severity === 0),
    warnings: issues.filter((i) => i.severity === 1),
    infos: issues.filter((i) => i.severity >= 2),
  };
}

export function formatIssues(result: LintResult): string {
  const all = [...result.errors, ...result.warnings, ...result.infos];
  if (all.length === 0) return "  Sin observaciones.";
  return all
    .map((i) => {
      const where = i.path.length ? i.path.join(".") : "(raíz)";
      const line = i.range ? `:${i.range.start.line + 1}` : "";
      return `  [${SEVERITY_LABEL[i.severity]}] ${i.code} en ${where}${line}: ${i.message}`;
    })
    .join("\n");
}
