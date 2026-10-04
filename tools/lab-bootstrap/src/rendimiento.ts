/**
 * Prueba de rendimiento de Yago Nexo (BT-039 a BT-041) contra el laboratorio, con k6.
 *
 * Fases, todas con la mezcla de tests/rendimiento/mezcla.js (50% operadores, 30% público, 20% integración):
 *   nominal   28 tx/s   el pico promedio de la línea base (100.000 tx/h)
 *   pico     125 tx/s   pico esperado: ráfaga 3× y crecimiento 1,5× (planilla de dimensionamiento)
 *   diseno   250 tx/s   capacidad de diseño (pico esperado × holgura 2×)
 *   estres   escalones crecientes hasta que la plataforma deja de cumplir (error ≥ 1%, p99 sobre el umbral
 *            o k6 no logra sostener la tasa); se informa el último escalón que cumplió.
 *
 * Durante cada fase toma muestras de CPU y memoria de los contenedores principales. Deja en
 * release/rendimiento/<fecha>/ los resúmenes de k6, resultados.json, informe.html e informe.pdf (este último
 * con la imagen nexo-tools/libreoffice:1, si existe).
 *
 * Uso: pnpm --filter @nexo/lab-bootstrap rendimiento
 *      FASES=nominal,diseno DURACION=1m pnpm --filter @nexo/lab-bootstrap rendimiento   (corrida corta)
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Wso2Client } from "@nexo/wso2-client";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const K6 = process.env.K6_BIN ?? "k6";
const SCRIPT = join(raiz, "tests/rendimiento/mezcla.js");
const TOKEN_URL = `${process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo"}/protocol/openid-connect/token`;
const CONTENEDORES = ["apim", "gw-publico", "mi", "keycloak", "postgres", "rabbitmq", "opensearch", "concesiones-v1", "registro-soap"];
const UMBRAL_P99 = { operadores: 1000, publico: 1000, integracion: 2000 } as const;
type Tipo = keyof typeof UMBRAL_P99;

interface Fase {
  id: string;
  nombre: string;
  tasa: number;
  duracion: string;
}

const DUR = process.env.DURACION;
const FASES: Fase[] = [
  { id: "nominal", nombre: "Nominal: pico promedio de la línea base", tasa: 28, duracion: DUR ?? "3m" },
  { id: "pico", nombre: "Pico esperado (ráfaga × crecimiento)", tasa: 125, duracion: DUR ?? "3m" },
  { id: "diseno", nombre: "Capacidad de diseño", tasa: 250, duracion: DUR ?? "5m" },
];
const ESCALONES = (process.env.ESCALONES ?? "350,450,600,800").split(",").map(Number);
const DUR_ESCALON = process.env.DURACION_ESCALON ?? "90s";

interface Muestra {
  t: string;
  contenedor: string;
  cpu: number;
  memMiB: number;
}

interface ResultadoFase {
  id: string;
  nombre: string;
  tasaObjetivo: number;
  duracion: string;
  tasaLograda: number;
  solicitudes: number;
  iteracionesPerdidas: number;
  tasaError: number;
  checksOk: number;
  latencia: Record<Tipo | "total", { med: number; p90: number; p95: number; p99: number; max: number }>;
  cumple: boolean;
  motivo: string;
  recursos: Record<string, { cpuProm: number; cpuMax: number; memMaxMiB: number }>;
}

async function credenciales(): Promise<{ key: string; secret: string }> {
  const wso2 = new Wso2Client({
    baseUrl: process.env.NEXO_WSO2_URL ?? "https://apim:9443",
    auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
    tls: { rejectUnauthorized: false },
  });
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo");
  if (!app) throw new Error("no existe la aplicación OperadorDemo (corra el bootstrap del laboratorio)");
  const k = (await wso2.devportal.listKeys(app.applicationId)).list.find((x) => x.keyManager === "Keycloak");
  if (!k?.consumerKey || !k.consumerSecret) throw new Error("OperadorDemo no tiene llaves de Keycloak");
  return { key: k.consumerKey, secret: k.consumerSecret };
}

function muestrear(muestras: Muestra[]): () => void {
  let activo = true;
  const nombres = CONTENEDORES.map((c) => `nexo-lab-${c}-1`);
  const vuelta = () => {
    if (!activo) return;
    const p = spawn("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...nombres]);
    let out = "";
    p.stdout.on("data", (b: Buffer) => (out += b.toString()));
    p.on("close", () => {
      const t = new Date().toISOString();
      for (const linea of out.split("\n").filter(Boolean)) {
        try {
          const s = JSON.parse(linea) as { Name: string; CPUPerc: string; MemUsage: string };
          const mem = s.MemUsage.split("/")[0]!.trim();
          const n = parseFloat(mem);
          const memMiB = mem.endsWith("GiB") ? n * 1024 : mem.endsWith("KiB") ? n / 1024 : n;
          muestras.push({ t, contenedor: s.Name.replace(/^nexo-lab-|-1$/g, ""), cpu: parseFloat(s.CPUPerc), memMiB });
        } catch {
          /* línea parcial */
        }
      }
      if (activo) setTimeout(vuelta, 3000);
    });
  };
  vuelta();
  return () => {
    activo = false;
  };
}

function correrK6(fase: Fase, dir: string, cred: { key: string; secret: string }): Promise<{ resumen: Record<string, unknown>; codigo: number }> {
  const resumen = join(dir, `k6-${fase.id}.json`);
  return new Promise((ok) => {
    const p = spawn(K6, ["run", "--quiet", "--no-color", SCRIPT], {
      env: {
        ...process.env,
        TASA: String(fase.tasa),
        DURACION: fase.duracion,
        TOKEN_URL,
        CONSUMER_KEY: cred.key,
        CONSUMER_SECRET: cred.secret,
        RESUMEN: resumen,
        // Los nombres del laboratorio se resuelven localmente: nunca pasan por un proxy de salida, si lo hay.
        NO_PROXY: ["apim", "keycloak", "publico.nexo.lab", process.env.NO_PROXY].filter(Boolean).join(","),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("close", (codigo) => ok({ resumen: JSON.parse(readFileSync(resumen, "utf8")) as Record<string, unknown>, codigo: codigo ?? 1 }));
  });
}

type Metricas = Record<string, { values: Record<string, number> } | undefined>;

function analizar(fase: Fase, r: Record<string, unknown>, muestras: Muestra[]): ResultadoFase {
  const m = r.metrics as Metricas;
  const lat = (clave: string) => {
    const v = m[clave]?.values ?? {};
    const n = (x: string) => Math.round((v[x] ?? 0) * 10) / 10;
    return { med: n("med"), p90: n("p(90)"), p95: n("p(95)"), p99: n("p(99)"), max: n("max") };
  };
  const latencia = {
    operadores: lat("http_req_duration{tipo:operadores}"),
    publico: lat("http_req_duration{tipo:publico}"),
    integracion: lat("http_req_duration{tipo:integracion}"),
    total: lat("http_req_duration"),
  };
  const solicitudes = (m.http_reqs?.values.count ?? 0) - 1; // menos la del token
  const seg = parseDuracion(fase.duracion);
  const tasaLograda = Math.round((solicitudes / seg) * 10) / 10;
  const perdidas = m.dropped_iterations?.values.count ?? 0;
  const tasaError = m.http_req_failed?.values.rate ?? 0;
  const checksOk = m.checks?.values.rate ?? 0;
  const motivos: string[] = [];
  if (tasaError >= 0.01) motivos.push(`error ${(tasaError * 100).toFixed(2)}% ≥ 1%`);
  for (const t of Object.keys(UMBRAL_P99) as Tipo[]) if (latencia[t].p99 > UMBRAL_P99[t]) motivos.push(`p99 ${t} ${latencia[t].p99} ms > ${UMBRAL_P99[t]} ms`);
  if (perdidas > fase.tasa * seg * 0.02) motivos.push(`k6 no sostuvo la tasa (${perdidas} iteraciones no lanzadas)`);
  const recursos: ResultadoFase["recursos"] = {};
  for (const c of CONTENEDORES) {
    const xs = muestras.filter((x) => x.contenedor === c);
    if (!xs.length) continue;
    recursos[c] = {
      cpuProm: Math.round((xs.reduce((s, x) => s + x.cpu, 0) / xs.length) * 10) / 10,
      cpuMax: Math.round(Math.max(...xs.map((x) => x.cpu)) * 10) / 10,
      memMaxMiB: Math.round(Math.max(...xs.map((x) => x.memMiB))),
    };
  }
  return {
    id: fase.id,
    nombre: fase.nombre,
    tasaObjetivo: fase.tasa,
    duracion: fase.duracion,
    tasaLograda,
    solicitudes,
    iteracionesPerdidas: perdidas,
    tasaError,
    checksOk,
    latencia,
    cumple: motivos.length === 0,
    motivo: motivos.join("; ") || "cumple",
    recursos,
  };
}

function parseDuracion(d: string): number {
  const m = /^(\d+)(s|m)$/.exec(d);
  if (!m) throw new Error(`duración no válida: ${d}`);
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}

function entorno() {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: raiz, encoding: "utf8" }).trim();
    } catch {
      return "desconocido";
    }
  };
  const version = (JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")) as { version: string }).version;
  const k6 = spawnSync(K6, ["version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "";
  return {
    producto: `Yago Nexo ${version}`,
    commit: git(["rev-parse", "--short", "HEAD"]),
    host: hostname(),
    vcpu: cpus().length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    k6,
    nota:
      (process.env.RENDIMIENTO_NOTA ? `${process.env.RENDIMIENTO_NOTA} ` : "") +
      "Laboratorio en una sola máquina compartida por unos 30 contenedores (WSO2, Keycloak, PostgreSQL, RabbitMQ, OpenSearch, observabilidad, backends de prueba y el propio generador de carga). En el laboratorio, el plano de control de WSO2 y el gateway de operadores comparten un contenedor; en producción el gateway corre en instancias dedicadas de 2 vCPU según la planilla de dimensionamiento.",
  };
}

const fmt = (n: number) => n.toLocaleString("es-CL", { maximumFractionDigits: 1 });

function html(res: { fecha: string; entorno: ReturnType<typeof entorno>; fases: ResultadoFase[]; estres: ResultadoFase[]; limite: number | null }): string {
  const filaLat = (f: ResultadoFase) =>
    `<tr><td>${f.nombre}</td><td>${fmt(f.tasaObjetivo)}</td><td>${fmt(f.tasaLograda)}</td><td>${fmt(f.solicitudes)}</td><td>${(f.tasaError * 100).toFixed(2)}%</td>` +
    (["operadores", "publico", "integracion"] as Tipo[]).map((t) => `<td>${fmt(f.latencia[t].med)} / ${fmt(f.latencia[t].p95)} / ${fmt(f.latencia[t].p99)}</td>`).join("") +
    `<td class="${f.cumple ? "ok" : "mal"}">${f.cumple ? "Cumple" : f.motivo}</td></tr>`;
  const todas = [...res.fases, ...res.estres];
  const filaRec = (f: ResultadoFase) =>
    `<tr><td>${f.nombre}</td>${CONTENEDORES.map((c) => `<td>${f.recursos[c] ? `${fmt(f.recursos[c].cpuProm)}% / ${fmt(f.recursos[c].memMaxMiB)}` : "—"}</td>`).join("")}</tr>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de rendimiento · Yago Nexo</title>
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#1f2937;margin:24px}h1{color:#1F3864;font-size:18pt}h2{color:#1D6F6A;font-size:13pt;margin-top:22px}
table{border-collapse:collapse;width:100%;margin:8px 0}th{background:#1F3864;color:#fff;font-weight:bold}th,td{border:1px solid #BFC9D6;padding:4px 6px;text-align:center;font-size:8.5pt}
td:first-child{text-align:left}tr:nth-child(even) td{background:#F5F8FB}.ok{color:#166534;font-weight:bold}.mal{color:#9a3412;font-weight:bold}.nota{color:#595959;font-size:9pt}</style></head><body>
<h1>Informe de rendimiento · ${res.entorno.producto}</h1>
<p>Fecha: ${res.fecha} · Commit ${res.entorno.commit} · Máquina ${res.entorno.host} (${res.entorno.vcpu} vCPU, ${res.entorno.ramGB} GB RAM) · ${res.entorno.k6}</p>
<h2>Resultado</h2>
<p>La plataforma sostuvo la capacidad de diseño de <b>250 tx/s</b>${res.fases.find((f) => f.id === "diseno")?.cumple ? " cumpliendo" : " <b>sin cumplir</b>"} los umbrales (error &lt; 1%, p99 &lt; 1.000 ms en REST y &lt; 2.000 ms en integración), frente a un pico promedio de 28 tx/s de la línea base.
${res.limite ? `En la prueba de estrés, el último escalón que cumplió fue <b>${fmt(res.limite)} tx/s</b>.` : "En la prueba de estrés ningún escalón adicional cumplió los umbrales."}</p>
<h2>Fases a tasa constante</h2>
<table><tr><th>Fase</th><th>Tasa objetivo (tx/s)</th><th>Tasa lograda (tx/s)</th><th>Solicitudes</th><th>Error</th><th>Operadores p50/p95/p99 (ms)</th><th>Público p50/p95/p99 (ms)</th><th>Integración p50/p95/p99 (ms)</th><th>Resultado</th></tr>
${res.fases.map(filaLat).join("\n")}</table>
<h2>Estrés por escalones</h2>
<table><tr><th>Escalón</th><th>Tasa objetivo (tx/s)</th><th>Tasa lograda (tx/s)</th><th>Solicitudes</th><th>Error</th><th>Operadores p50/p95/p99 (ms)</th><th>Público p50/p95/p99 (ms)</th><th>Integración p50/p95/p99 (ms)</th><th>Resultado</th></tr>
${res.estres.map(filaLat).join("\n")}</table>
<h2>Uso de recursos (CPU promedio / memoria máxima en MiB)</h2>
<table><tr><th>Fase</th>${CONTENEDORES.map((c) => `<th>${c}</th>`).join("")}</tr>${todas.map(filaRec).join("\n")}</table>
<p class="nota">CPU en % de un núcleo (100% = 1 vCPU), según docker stats cada 3 s.</p>
<h2>Cómo se midió</h2>
<p>k6 genera tasa constante de llegadas (no depende de cuánto tarda cada respuesta) con la mezcla 50% gateway de operadores (REST), 30% gateway público (REST) y 20% integración (gateway → Micro Integrator con validación, llamada SOAP, transformación y publicación en RabbitMQ, con llave de idempotencia única). Cada llamada lleva un token OAuth2 de Keycloak; el token se obtiene antes de medir. La latencia es de extremo a extremo vista por el consumidor, incluido el backend de prueba.</p>
<p class="nota">${res.entorno.nota}</p>
<p class="nota">Se reproduce con: pnpm --filter @nexo/lab-bootstrap rendimiento (script tests/rendimiento/mezcla.js).</p>
</body></html>`;
}

async function main() {
  const cred = await credenciales();
  const fecha = new Date().toISOString();
  const dir = join(raiz, "release/rendimiento", fecha.slice(0, 16).replace(/[:T]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const elegidas = process.env.FASES?.split(",") ?? [...FASES.map((f) => f.id), "estres"];
  const fases: ResultadoFase[] = [];
  const estres: ResultadoFase[] = [];
  const correr = async (f: Fase) => {
    console.log(`[rendimiento] ${f.nombre}: ${f.tasa} tx/s durante ${f.duracion}`);
    const muestras: Muestra[] = [];
    const parar = muestrear(muestras);
    const { resumen } = await correrK6(f, dir, cred);
    parar();
    const r = analizar(f, resumen, muestras);
    console.log(`[rendimiento]   lograda ${r.tasaLograda} tx/s · error ${(r.tasaError * 100).toFixed(2)}% · p99 operadores ${r.latencia.operadores.p99} ms · integración ${r.latencia.integracion.p99} ms → ${r.motivo}`);
    return r;
  };
  for (const f of FASES.filter((x) => elegidas.includes(x.id))) {
    fases.push(await correr(f));
    await new Promise((r) => setTimeout(r, 20_000)); // reposo entre fases
  }
  let limite: number | null = null;
  if (elegidas.includes("estres")) {
    for (const tasa of ESCALONES) {
      const r = await correr({ id: `estres-${tasa}`, nombre: `Estrés ${tasa} tx/s`, tasa, duracion: DUR_ESCALON });
      estres.push(r);
      if (!r.cumple) break;
      limite = tasa;
      await new Promise((x) => setTimeout(x, 20_000));
    }
  }
  const res = { fecha, entorno: entorno(), fases, estres, limite };
  writeFileSync(join(dir, "resultados.json"), JSON.stringify(res, null, 2) + "\n");
  writeFileSync(join(dir, "informe.html"), html(res));
  const imagen = "nexo-tools/libreoffice:1";
  if (spawnSync("docker", ["image", "inspect", imagen]).status === 0) {
    spawnSync("docker", ["run", "--rm", "-v", `${dir}:/w`, imagen, "soffice", "--headless", "--convert-to", "pdf:writer_web_pdf_Export", "informe.html"], { stdio: "ignore" });
  }
  console.log(`[rendimiento] informe en ${dir}${existsSync(join(dir, "informe.pdf")) ? " (con PDF)" : ""}`);
  if (fases.some((f) => !f.cumple)) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
