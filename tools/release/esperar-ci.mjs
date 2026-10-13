// Puerta del flujo de versión: espera a que el workflow CI termine en verde en el commit que se va a publicar.
// Falla si el CI de ese commit terminó en rojo (o cancelado), o si no termina dentro del plazo.
//
// Solo cuenta la corrida del push de ese commit a la rama indicada (main): no las de pull_request ni las de otras
// ramas con el mismo SHA.
//
// Uso (en GitHub Actions): node tools/release/esperar-ci.mjs [--sha <commit>] [--rama main] [--minutos 60]
//   [--workflow ci.yml]
// Variables: GITHUB_TOKEN (permiso actions: read), GITHUB_REPOSITORY y, si no se da --sha, GITHUB_SHA.
import { setTimeout as esperar } from "node:timers/promises";
import { parseArgs } from "node:util";
import { estadoCi } from "./lib/ci.mjs";

const { values: op } = parseArgs({
  options: {
    sha: { type: "string", default: process.env.GITHUB_SHA },
    minutos: { type: "string", default: "60" },
    workflow: { type: "string", default: "ci.yml" },
    rama: { type: "string", default: "main" },
    intervalo: { type: "string", default: "20" },
  },
});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token || !op.sha) {
  console.error("Faltan GITHUB_REPOSITORY, GITHUB_TOKEN o el commit (--sha / GITHUB_SHA).");
  process.exit(2);
}
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const url =
  `${api}/repos/${repo}/actions/workflows/${op.workflow}/runs?head_sha=${op.sha}` +
  `&event=push&branch=${encodeURIComponent(op.rama)}&per_page=50`;
const limite = Date.now() + Number(op.minutos) * 60_000;

for (;;) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`API de GitHub: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const { workflow_runs: corridas = [] } = await res.json();
  const { estado, detalle } = estadoCi(corridas, { rama: op.rama });
  console.log(`[${new Date().toISOString()}] ${op.sha.slice(0, 12)}: ${detalle}`);
  if (estado === "exito") process.exit(0);
  if (estado === "falla") process.exit(1);
  if (Date.now() > limite) {
    console.error(`El CI no terminó en verde dentro de ${op.minutos} minutos.`);
    process.exit(1);
  }
  await esperar(Number(op.intervalo) * 1000);
}
