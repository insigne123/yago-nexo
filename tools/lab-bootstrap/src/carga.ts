/**
 * Carga de fondo del laboratorio (CLI). Muestra por segundo los códigos y la versión del backend, y al
 * final un resumen con los errores que vieron los consumidores (evidencia de "sin cortes" en D-04 y D-05).
 *
 * Uso: pnpm --filter @nexo/lab-bootstrap carga -- --url https://apim:8243/concesiones/1.0.0/concesiones --rps 10 --segundos 120
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runLoad } from "./load.js";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "https://apim:8243/concesiones/1.0.0/concesiones" },
    rps: { type: "string", default: "10" },
    segundos: { type: "string", default: "120" },
    app: { type: "string", default: "OperadorDemo" },
    salida: { type: "string" },
    silencioso: { type: "boolean", default: false },
  },
});

async function main() {
  const res = await runLoad({
    url: args.url!,
    rps: Number(args.rps),
    seconds: Number(args.segundos),
    app: args.app,
    onSecond: args.silencioso
      ? undefined
      : (s) => console.log(`[carga] t=${String(s.t).padStart(3)}s ok=${s.ok} err=${s.errores} ${Object.entries(s.versiones).map(([k, n]) => `v${k}:${n}`).join(" ")}`),
  });
  console.log(`[carga] resumen: ${JSON.stringify({ ...res, timeline: undefined })}`);
  if (args.salida) writeFileSync(args.salida, JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error("[carga] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
