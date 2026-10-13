// Decide si el CI de un commit está en verde a partir de sus corridas del workflow CI (API de GitHub Actions,
// /actions/workflows/ci.yml/runs?head_sha=...&event=push&branch=main). Sin E/S: la usa
// tools/release/esperar-ci.mjs y la prueba tools/release/test/ci.test.mjs.

/**
 * Solo cuenta la corrida del push del commit a la rama que se publica (main): una corrida de pull_request prueba
 * el commit de fusión, no el commit, y una de otra rama con el mismo SHA no dice nada del push a main. De esas,
 * vale la más reciente (un reintento conserva la corrida y actualiza su resultado).
 *
 * @param {{status: string, conclusion: string | null, html_url?: string, event?: string, head_branch?: string,
 *   run_number?: number, created_at?: string}[]} corridas
 * @param {{rama?: string}} [opciones] rama de la que debe venir la corrida (por omisión, main)
 * @returns {{estado: "exito" | "falla" | "esperar" | "sin_corridas", detalle: string}}
 *   exito: la corrida más reciente del push a la rama terminó en verde;
 *   esperar: esa corrida sigue en curso;
 *   falla: esa corrida terminó y no en verde (aunque haya corridas verdes de un PR o de otra rama);
 *   sin_corridas: el CI todavía no registra una corrida del push de ese commit a la rama.
 */
export function estadoCi(corridas, { rama = "main" } = {}) {
  const validas = corridas
    .filter((c) => c.event === "push" && c.head_branch === rama)
    .sort(
      (a, b) =>
        (b.run_number ?? 0) - (a.run_number ?? 0) ||
        Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""),
    );
  const ultima = validas[0];
  if (!ultima) {
    const otras = corridas.length
      ? ` (se ignoraron ${corridas.length} de pull_request o de otras ramas)`
      : "";
    return {
      estado: "sin_corridas",
      detalle: `el CI no tiene una corrida del push de este commit a ${rama}${otras}`,
    };
  }
  const url = ultima.html_url ?? "corrida sin URL";
  if (ultima.status !== "completed")
    return { estado: "esperar", detalle: `la corrida del CI en ${rama} sigue en curso: ${url}` };
  if (ultima.conclusion === "success") return { estado: "exito", detalle: `CI en verde en ${rama}: ${url}` };
  return {
    estado: "falla",
    detalle: `el CI de este commit en ${rama} no está en verde: ${ultima.conclusion ?? "sin resultado"} (${url})`,
  };
}
