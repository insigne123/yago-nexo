/**
 * nexo-motores: ejecuta los motores de Nexo. Uso:
 *   node nexo-motores.mjs despliegues guardian descubrimiento siem
 *   NEXO_MOTORES=despliegues,guardian node nexo-motores.mjs
 * El agente de continuidad (D-05) corre aparte en cada sitio: node nexo-motores.mjs continuidad
 */
import type { Engine } from "./kit/runtime.js";
import { runEngines } from "./kit/runtime.js";
import { continuityEngine } from "./continuity/engine.js";
import { discoveryEngine } from "./discovery/engine.js";
import { guardianEngine } from "./guardian/engine.js";
import { rolloutEngine } from "./rollout/engine.js";
import { siemEngine } from "./siem/engine.js";

const ENGINES: Record<string, Engine> = {
  despliegues: rolloutEngine,
  guardian: guardianEngine,
  descubrimiento: discoveryEngine,
  siem: siemEngine,
  continuidad: continuityEngine,
};

async function main() {
  const requested = (process.argv.slice(2).length ? process.argv.slice(2) : (process.env.NEXO_MOTORES ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  if (!requested.length) throw new Error(`Indique los motores a ejecutar: ${Object.keys(ENGINES).join(", ")}`);
  const unknown = requested.filter((n) => !ENGINES[n]);
  if (unknown.length) throw new Error(`Motores desconocidos: ${unknown.join(", ")}. Disponibles: ${Object.keys(ENGINES).join(", ")}`);
  await runEngines(requested.map((n) => ENGINES[n]!));
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), nivel: "error", msg: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
