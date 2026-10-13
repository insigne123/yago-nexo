// Decide si el CI de un commit está en verde a partir de sus corridas del workflow CI (API de GitHub Actions,
// /actions/workflows/ci.yml/runs?head_sha=...). Sin E/S: la usa tools/release/esperar-ci.mjs y la prueba
// tools/release/test/ci.test.mjs.

/**
 * @param {{status: string, conclusion: string | null, html_url?: string}[]} corridas
 * @returns {{estado: "exito" | "falla" | "esperar" | "sin_corridas", detalle: string}}
 *   exito: al menos una corrida terminó en verde (por ejemplo, un reintento después de una falla);
 *   esperar: no hay corrida verde y alguna sigue en curso;
 *   falla: todas terminaron y ninguna en verde;
 *   sin_corridas: el CI todavía no registra corridas para ese commit.
 */
export function estadoCi(corridas) {
  const verde = corridas.find((c) => c.status === "completed" && c.conclusion === "success");
  if (verde) return { estado: "exito", detalle: `CI en verde: ${verde.html_url ?? "corrida sin URL"}` };
  const enCurso = corridas.filter((c) => c.status !== "completed");
  if (enCurso.length) return { estado: "esperar", detalle: `${enCurso.length} corrida(s) del CI en curso` };
  if (corridas.length === 0)
    return { estado: "sin_corridas", detalle: "el CI no tiene corridas para este commit" };
  const resultados = corridas.map((c) => `${c.conclusion ?? "sin resultado"} (${c.html_url ?? "sin URL"})`);
  return { estado: "falla", detalle: `el CI de este commit no está en verde: ${resultados.join(", ")}` };
}
