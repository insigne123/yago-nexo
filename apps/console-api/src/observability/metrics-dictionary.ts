/**
 * Diccionario de métricas y alertas de Nexo (BT-034), generado desde la configuración y el código del
 * repositorio: trabajos de Prometheus, métricas propias (motores, Consola, Fluent Bit y exportador JMX del
 * gateway), métricas de terceros que usan las reglas y el tablero, reglas de alerta y alertas que emiten los
 * motores, con su recorrido hasta la auditoría y el SIEM.
 *
 * Uso (desde la raíz del repositorio): pnpm --filter @nexo/console-api metricas:diccionario
 * Escribe deploy/compose/prometheus/diccionario-metricas.md y .json. Una prueba verifica que estén al día.
 *
 * Solo usa módulos de Node y `yaml`, y sintaxis de TypeScript que Node ejecuta directamente.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export interface ScrapeJob {
  job: string;
  targets: string[];
  path: string;
  params?: Record<string, string[]>;
  componente?: string;
}

export interface MetricDef {
  name: string;
  type: string;
  labels: string[];
  help: string;
  source: string;
  job: string;
}

export interface RuleDef {
  group: string;
  alert: string;
  expr: string;
  for?: string;
  severidad?: string;
  resumen?: string;
  metrics: string[];
}

export interface EngineAlert {
  alert: string;
  severidad: string;
  motor: string;
  source: string;
}

export interface Dictionary {
  routing: {
    evaluationInterval: string;
    groupBy: string[];
    receiver: string;
    webhookUrl: string;
    sendResolved: boolean;
    tokenFile?: string;
  };
  jobs: ScrapeJob[];
  metrics: MetricDef[];
  thirdParty: Array<{ name: string; job: string; usedBy: string[] }>;
  rules: RuleDef[];
  engineAlerts: EngineAlert[];
  dashboards: Array<{ title: string; panel: string; expr: string; metrics: string[] }>;
  warnings: string[];
}

const PROMQL_KEYWORDS = new Set([
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "bool",
  "and",
  "or",
  "unless",
  "offset",
  "inf",
  "nan",
]);

/**
 * Errores conocidos en una regla: filtrar por cola en las métricas agregadas de RabbitMQ (/metrics no publica la
 * etiqueta queue, así que la regla nunca se cumple; las métricas por cola están en /metrics/detailed).
 */
export function ruleWarnings(alert: string, expr: string): string[] {
  const out: string[] = [];
  if (/\brabbitmq_queue_\w+\s*\{[^}]*\bqueue\s*(=~|!~|!=|=)/.test(expr)) {
    out.push(
      `La regla ${alert} filtra por la etiqueta queue en una métrica agregada de RabbitMQ (rabbitmq_queue_*), que no la tiene; use rabbitmq_detailed_queue_* (/metrics/detailed)`,
    );
  }
  return out;
}

/** Métricas que usa una expresión PromQL: identificadores que no son funciones, palabras clave ni etiquetas. */
export function metricsInExpr(expr: string): string[] {
  let s = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'); // literales
  s = s.replace(/\{[^}]*\}/g, ""); // selectores de etiquetas
  s = s.replace(/\[[^\]]*\]/g, ""); // rangos
  s = s.replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " "); // listas de etiquetas
  const out = new Set<string>();
  for (const m of s.matchAll(/(?<![\w.:])([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    const [, name, call] = m;
    if (call || PROMQL_KEYWORDS.has(name!.toLowerCase())) continue;
    out.add(name!);
  }
  return [...out].sort();
}

function readYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}

function filesUnder(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") out.push(...filesUnder(p, pred));
    } else if (pred(e.name)) out.push(p);
  }
  return out.sort();
}

/** Texto entre la llave que abre en `start` y su cierre. */
function balanced(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

export function buildDictionary(root: string): Dictionary {
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  const warnings: string[] = [];
  const promDir = join(root, "deploy/compose/prometheus");

  // ------------------------------------------------------------ trabajos de Prometheus
  type PromConfig = {
    global?: { evaluation_interval?: string };
    scrape_configs: Array<{
      job_name: string;
      metrics_path?: string;
      params?: Record<string, string[]>;
      static_configs?: Array<{ targets: string[]; labels?: Record<string, string> }>;
    }>;
  };
  const prom = readYaml<PromConfig>(join(promDir, "prometheus.yml"));
  const jobs: ScrapeJob[] = prom.scrape_configs.map((c) => ({
    job: c.job_name,
    targets: (c.static_configs ?? []).flatMap((s) => s.targets),
    path: c.metrics_path ?? "/metrics",
    ...(c.params ? { params: c.params } : {}),
    ...(c.static_configs?.[0]?.labels?.componente
      ? { componente: c.static_configs[0].labels.componente }
      : {}),
  }));
  const evaluationInterval = prom.global?.evaluation_interval ?? "1m";

  // ------------------------------------------------------------ Alertmanager → webhook de la Consola
  type Am = {
    route: { receiver: string; group_by?: string[] };
    receivers: Array<{
      name: string;
      webhook_configs?: Array<{
        url: string;
        send_resolved?: boolean;
        http_config?: { authorization?: { type?: string; credentials_file?: string; credentials?: string } };
      }>;
    }>;
  };
  const am = readYaml<Am>(join(root, "deploy/compose/alertmanager/alertmanager.yml"));
  const receiver = am.receivers.find((r) => r.name === am.route.receiver);
  const webhook = receiver?.webhook_configs?.[0];
  const routing = {
    evaluationInterval,
    groupBy: am.route.group_by ?? [],
    receiver: am.route.receiver,
    webhookUrl: webhook?.url ?? "",
    sendResolved: webhook?.send_resolved ?? false,
    tokenFile: webhook?.http_config?.authorization?.credentials_file,
  };
  if (!routing.tokenFile)
    warnings.push(
      "Alertmanager no envía el token del webhook desde un archivo (http_config.authorization.credentials_file)",
    );
  if (webhook?.http_config?.authorization?.credentials)
    warnings.push("alertmanager.yml trae el token en claro (credentials); use credentials_file");

  const jobByTarget = (host: string) =>
    jobs.find((j) => j.targets.some((t) => t.startsWith(`${host}:`)))?.job;

  // ------------------------------------------------------------ métricas propias
  const metrics: MetricDef[] = [];
  type Compose = { services: Record<string, { command?: string[] | string }> };
  const compose = readYaml<Compose>(join(root, "deploy/compose/docker-compose.yml"));
  const motoresCmd = compose.services.motores?.command;
  const inMotores = new Set(Array.isArray(motoresCmd) ? motoresCmd : []);
  const motoresJob = jobByTarget("motores") ?? "sin recolección";
  const engineFiles = filesUnder(
    join(root, "services/engines/src"),
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const consoleFiles = filesUnder(
    join(root, "apps/console-api/src"),
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const engineAlerts: EngineAlert[] = [];

  for (const file of [...engineFiles, ...consoleFiles]) {
    const text = readFileSync(file, "utf8");
    if (!/new (Counter|Gauge|Histogram|Summary)\(|collectDefaultMetrics\(|\.alert\(\{/.test(text)) continue;
    const engineName = /:\s*Engine\s*=\s*\{\s*name:\s*"([^"]+)"/.exec(text)?.[1];
    const isConsole = file.includes("/apps/console-api/");
    const job = isConsole
      ? (jobByTarget("console-api") ?? "sin recolección")
      : engineName && !inMotores.has(engineName)
        ? `sin recolección en el laboratorio (motor «${engineName}», fuera del servicio motores)`
        : motoresJob;
    for (const m of text.matchAll(/new (Counter|Gauge|Histogram|Summary)\(\{/g)) {
      const body = balanced(text, m.index! + m[0].length - 1);
      const name = /name:\s*"([^"]+)"/.exec(body)?.[1];
      if (!name) continue;
      metrics.push({
        name,
        type: m[1]!.toLowerCase(),
        labels: [...(/labelNames:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
          (x) => x[1]!,
        ),
        help: /help:\s*"([^"]+)"/.exec(body)?.[1] ?? "",
        source: rel(file),
        job,
      });
    }
    for (const m of text.matchAll(/collectDefaultMetrics\(\{[^}]*prefix:\s*"([^"]+)"/g)) {
      metrics.push({
        name: `${m[1]}*`,
        type: "proceso",
        labels: [],
        help: "Métricas de proceso de Node.js (CPU, memoria, event loop, recolector de basura) con este prefijo",
        source: rel(file),
        job,
      });
    }
    for (const m of text.matchAll(/\.alert\(\{/g)) {
      const body = balanced(text, m.index! + m[0].length - 1);
      // Valor de una propiedad: hasta la siguiente propiedad o el fin de línea (admite un operador ternario).
      const prop = (key: string) =>
        new RegExp(`\\b${key}:\\s*(.+?)(?:,\\s*[a-zA-Z]+:|,?\\s*\\n|\\s*\\}\\)?$)`).exec(body)?.[1] ?? "";
      const names = [...prop("name").matchAll(/"([A-Z][a-z]\w*)"/g)].map((x) => x[1]!);
      const sev = [...prop("severity").matchAll(/"(S\d)"/g)].map((x) => x[1]!);
      names.forEach((n, i) =>
        engineAlerts.push({
          alert: n,
          severidad: sev.length === names.length ? sev[i]! : sev.join(" o "),
          motor: engineName ?? "kit",
          source: rel(file),
        }),
      );
    }
  }

  // Fluent Bit: contadores e histogramas derivados de la analítica del gateway (log_to_metrics).
  const fbPath = join(root, "deploy/compose/fluent-bit/fluent-bit.yaml");
  type FluentBit = {
    pipeline: { filters?: Array<Record<string, unknown>>; outputs?: Array<Record<string, unknown>> };
  };
  const fb = readYaml<FluentBit>(fbPath);
  const exporter = (fb.pipeline.outputs ?? []).find((o) => o.name === "prometheus_exporter");
  const fbTarget = `fluent-bit:${String(exporter?.port ?? 2021)}`;
  const fbJob = jobs.find((j) => j.targets.includes(fbTarget))?.job ?? `sin recolección (${fbTarget})`;
  for (const f of fb.pipeline.filters ?? []) {
    if (f.name !== "log_to_metrics") continue;
    const mode = String(f.metric_mode);
    const name = `${String(f.metric_namespace)}_${String(f.metric_subsystem ?? mode)}_${String(f.metric_name)}`;
    metrics.push({
      name,
      type: mode,
      labels: (f.label_field as string[] | undefined) ?? [],
      help: String(f.metric_description ?? ""),
      source: `${rel(fbPath)} (log_to_metrics${f.value_field ? `, valor ${String(f.value_field)}` : ""})`,
      job: fbJob,
    });
  }

  // Exportador JMX del gateway: reglas con nombre propio (el resto se publica con el nombre de JMX).
  const jmxPath = join(root, "deploy/compose/apim/jmx/config.yaml");
  type Jmx = {
    lowercaseOutputName?: boolean;
    rules: Array<{ pattern: string; name?: string; labels?: Record<string, string> }>;
  };
  const jmx = readYaml<Jmx>(jmxPath);
  const jmxJob = jobByTarget("apim") ?? "gateway-jvm";
  for (const r of jmx.rules) {
    if (!r.name) continue;
    const groups = [...r.pattern.matchAll(/\(([^()]*)\)/g)].map((g) => g[1]!);
    const ref = /\$(\d)/.exec(r.name);
    const alternatives = ref
      ? (groups[Number(ref[1]) - 1] ?? "").split("|").filter((a) => /^\w+$/.test(a))
      : [""];
    for (const alt of alternatives) {
      const name = ref ? r.name.replace(ref[0], alt) : r.name;
      metrics.push({
        name: jmx.lowercaseOutputName ? name.toLowerCase() : name,
        type: "jmx",
        labels: Object.keys(r.labels ?? {}),
        help: `Atributo JMX ${alt} (${r.pattern.split("<")[0]})`,
        source: rel(jmxPath),
        job: jmxJob,
      });
    }
  }
  metrics.sort((a, b) => a.name.localeCompare(b.name));

  // ------------------------------------------------------------ reglas de alerta
  const rulesDir = join(promDir, "rules");
  const rules: RuleDef[] = [];
  type Rules = {
    groups: Array<{
      name: string;
      rules: Array<{
        alert?: string;
        record?: string;
        expr: string;
        for?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      }>;
    }>;
  };
  for (const f of readdirSync(rulesDir)
    .filter((x) => x.endsWith(".yml") || x.endsWith(".yaml"))
    .sort()) {
    for (const g of readYaml<Rules>(join(rulesDir, f)).groups) {
      for (const r of g.rules) {
        if (!r.alert) continue;
        warnings.push(...ruleWarnings(r.alert, String(r.expr)));
        rules.push({
          group: g.name,
          alert: r.alert,
          expr: String(r.expr).trim(),
          ...(r.for ? { for: r.for } : {}),
          ...(r.labels?.severidad ? { severidad: r.labels.severidad } : {}),
          ...(r.annotations?.resumen ? { resumen: r.annotations.resumen } : {}),
          metrics: metricsInExpr(String(r.expr)),
        });
      }
    }
  }

  // ------------------------------------------------------------ tablero de Grafana
  const dashboards: Dictionary["dashboards"] = [];
  const dashDir = join(root, "deploy/compose/grafana/dashboards");
  type Panel = { title?: string; panels?: Panel[]; targets?: Array<{ expr?: string }> };
  for (const f of readdirSync(dashDir)
    .filter((x) => x.endsWith(".json"))
    .sort()) {
    const d = JSON.parse(readFileSync(join(dashDir, f), "utf8")) as { title: string; panels?: Panel[] };
    const walk = (ps: Panel[]) => {
      for (const p of ps) {
        if (p.panels) walk(p.panels);
        for (const t of p.targets ?? [])
          if (t.expr)
            dashboards.push({
              title: d.title,
              panel: p.title ?? "",
              expr: t.expr,
              metrics: metricsInExpr(t.expr),
            });
      }
    };
    walk(d.panels ?? []);
  }

  // ------------------------------------------------------------ métricas de terceros y verificación
  const own = (name: string) =>
    metrics.some(
      (m) =>
        m.name === name ||
        (m.type === "histogram" &&
          /_(bucket|sum|count)$/.test(name) &&
          m.name === name.replace(/_(bucket|sum|count)$/, "")) ||
        (m.name.endsWith("*") && name.startsWith(m.name.slice(0, -1))),
    );
  const detailedJob = jobs.find((j) => j.path === "/metrics/detailed");
  const thirdPartyJob = (name: string): string | undefined => {
    if (name === "up") return "todos los trabajos (Prometheus)";
    if (name.startsWith("rabbitmq_detailed_queue_")) {
      const families = detailedJob?.params?.family ?? [];
      const family = name.startsWith("rabbitmq_detailed_queue_consumer")
        ? "queue_consumer_count"
        : "queue_coarse_metrics";
      return detailedJob && families.includes(family)
        ? `${detailedJob.job} (/metrics/detailed, familia ${family})`
        : undefined;
    }
    if (name.startsWith("rabbitmq_")) return jobByTarget("rabbitmq");
    if (name.startsWith("jvm_")) return jmxJob;
    if (name.startsWith("wso2_integration_")) return jobByTarget("mi");
    if (name.startsWith("envoy_")) return jobByTarget("nexo-division");
    if (name.startsWith("keycloak_")) return jobByTarget("keycloak");
    if (name.startsWith("fluentbit_")) return jobs.find((j) => j.job === "fluent-bit")?.job;
    return undefined;
  };
  const used = new Map<string, Set<string>>();
  for (const r of rules)
    for (const m of r.metrics) (used.get(m) ?? used.set(m, new Set()).get(m)!).add(`regla ${r.alert}`);
  for (const d of dashboards)
    for (const m of d.metrics)
      (used.get(m) ?? used.set(m, new Set()).get(m)!).add(`tablero «${d.title}» · ${d.panel}`);
  const thirdParty: Dictionary["thirdParty"] = [];
  for (const [name, by] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
    if (own(name)) continue;
    const job = thirdPartyJob(name);
    if (!job)
      warnings.push(
        `La métrica ${name} (${[...by].join("; ")}) no tiene una fuente conocida en la configuración`,
      );
    thirdParty.push({ name, job: job ?? "desconocida", usedBy: [...by].sort() });
  }

  return { routing, jobs, metrics, thirdParty, rules, engineAlerts, dashboards, warnings };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(d: Dictionary): string {
  const out: string[] = [];
  out.push("# Diccionario de métricas y alertas de Nexo", "");
  out.push(
    "<!-- Archivo generado: no se edita a mano. Se regenera con `pnpm --filter @nexo/console-api metricas:diccionario`. -->",
    "",
  );
  out.push(
    "Generado desde `deploy/compose/prometheus/prometheus.yml`, `deploy/compose/prometheus/rules/`, `deploy/compose/alertmanager/alertmanager.yml`, `deploy/compose/fluent-bit/fluent-bit.yaml`, " +
      "`deploy/compose/apim/jmx/config.yaml`, `deploy/compose/grafana/dashboards/` y el código de `services/engines` y `apps/console-api`. " +
      "Una prueba de `@nexo/console-api` falla si este archivo no coincide con la configuración.",
    "",
  );
  out.push("## Recorrido de una alerta", "");
  const r = d.routing;
  out.push(
    `1. Prometheus evalúa las reglas cada ${r.evaluationInterval} (\`evaluation_interval\`) y envía las alertas activas a Alertmanager; los motores de Nexo envían las suyas directo a Alertmanager (\`NEXO_ALERTMANAGER_URL\`).`,
    `2. Alertmanager las agrupa por ${r.groupBy.map((g) => `\`${g}\``).join(" y ")} y el receptor \`${r.receiver}\` las entrega${r.sendResolved ? ", también cuando se resuelven," : ""} al webhook de la Consola (\`${r.webhookUrl}\`) con el token compartido en \`Authorization: Bearer\`${r.tokenFile ? `, leído del archivo de secreto \`${r.tokenFile}\`` : ""}. Sin token o con uno inválido la Consola responde 401 y el intento queda en la auditoría, agrupado por IP.`,
    "3. La Consola guarda cada alerta (el resumen de inicio cuenta como abiertas las recibidas en estado `firing` en las últimas 24 h) y la registra en la cadena de auditoría como `alerta.recibida`, con su estado (`firing` o `resolved`), severidad, resumen y etiquetas.",
    "4. El motor `siem` reenvía la cadena de auditoría al SIEM sin pérdida; así cada alerta recibida llega también al SIEM.",
    "",
  );
  out.push("## Reglas de alerta de Prometheus", "");
  out.push(
    "| Alerta | Grupo | Severidad | Duración | Expresión | Resumen | Métricas |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of d.rules)
    out.push(
      `| ${r.alert} | ${r.group} | ${r.severidad ?? ""} | ${r.for ?? "inmediata"} | \`${cell(r.expr)}\` | ${cell(r.resumen ?? "")} | ${r.metrics.map((m) => `\`${m}\``).join(", ")} |`,
    );
  out.push("", "## Alertas que emiten los motores", "");
  out.push("| Alerta | Severidad | Motor | Origen |", "|---|---|---|---|");
  for (const a of d.engineAlerts) out.push(`| ${a.alert} | ${a.severidad} | ${a.motor} | \`${a.source}\` |`);
  out.push("", "## Trabajos de Prometheus", "");
  out.push("| Trabajo | Destino | Ruta | Componente |", "|---|---|---|---|");
  for (const j of d.jobs) {
    const params = j.params
      ? `?${Object.entries(j.params)
          .flatMap(([k, vs]) => vs.map((v) => `${k}=${v}`))
          .join("&")}`
      : "";
    out.push(
      `| ${j.job} | ${j.targets.map((t) => `\`${t}\``).join(", ")} | \`${j.path}${params}\` | ${j.componente ?? ""} |`,
    );
  }
  out.push("", "## Métricas propias de Nexo", "");
  out.push("| Métrica | Tipo | Etiquetas | Descripción | Trabajo | Origen |", "|---|---|---|---|---|---|");
  for (const m of d.metrics)
    out.push(
      `| \`${m.name}\` | ${m.type} | ${m.labels.join(", ")} | ${cell(m.help)} | ${cell(m.job)} | \`${m.source}\` |`,
    );
  out.push("", "## Métricas de terceros que usan las reglas y el tablero", "");
  out.push("| Métrica | Trabajo | Se usa en |", "|---|---|---|");
  for (const t of d.thirdParty) out.push(`| \`${t.name}\` | ${cell(t.job)} | ${cell(t.usedBy.join("; "))} |`);
  out.push("", "## Paneles del tablero", "");
  out.push("| Tablero | Panel | Consulta |", "|---|---|---|");
  for (const p of d.dashboards) out.push(`| ${p.title} | ${cell(p.panel)} | \`${cell(p.expr)}\` |`);
  out.push("", "## Advertencias", "");
  out.push(
    ...(d.warnings.length
      ? d.warnings.map((w) => `- ${w}`)
      : ["Ninguna: toda métrica que usan las reglas y el tablero tiene una fuente en la configuración."]),
  );
  out.push("");
  return out.join("\n");
}

export const OUTPUT_MD = "deploy/compose/prometheus/diccionario-metricas.md";
export const OUTPUT_JSON = "deploy/compose/prometheus/diccionario-metricas.json";

export function renderJson(d: Dictionary): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

/** Raíz del repositorio a partir de este archivo (apps/console-api/src/observability). */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = repoRoot();
  const d = buildDictionary(root);
  writeFileSync(join(root, OUTPUT_MD), renderMarkdown(d));
  writeFileSync(join(root, OUTPUT_JSON), renderJson(d));
  console.log(
    `${OUTPUT_MD}: ${d.rules.length} reglas, ${d.engineAlerts.length} alertas de motores, ${d.metrics.length} métricas propias, ${d.thirdParty.length} de terceros`,
  );
  for (const w of d.warnings) console.warn(`advertencia: ${w}`);
}
