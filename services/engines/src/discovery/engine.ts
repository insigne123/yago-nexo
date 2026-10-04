import { createHash } from "node:crypto";
import { Agent, fetch } from "undici";
import { Counter, Gauge } from "@prometheus-io/client";
import { env, num, opt } from "../kit/config.js";
import type { Engine, EngineContext } from "../kit/runtime.js";
import { exposureScore, parseSpec, SCANNER_AGENT, type ParsedSpec } from "./analysis.js";
import { apisixFindings, expandTargets, gcpFindings, networkFindings, nginxFindings, probe, tlsInfo, type RawFinding } from "./sources.js";

/**
 * Motor de descubrimiento de APIs no gobernadas (D-01). Inventaría lo que publica la plataforma "actual"
 * (rutas de APISIX, configuración y registro de accesos de NGINX), sondea los objetivos de red autorizados
 * buscando contratos en las rutas típicas y lee Cloud Run y API Gateway en Google Cloud. Cada hallazgo se
 * compara con el catálogo gobernado y recibe un puntaje de exposición con sus motivos.
 * El sondeo es pasivo: solo lecturas sin credenciales (GET e introspección GraphQL), con límites de tiempo.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const SPEC_SUFFIXES = ["/v2/api-docs", "/v3/api-docs", "/openapi.json", "/swagger.json"];

let scansTotal: Counter<"resultado">;
let findingsGauge: Gauge<"estado">;

const fingerprint = (f: RawFinding) => createHash("sha256").update(`${f.source}|${f.host}|${f.port ?? ""}|${f.path}`).digest("hex").slice(0, 32);

interface CatalogIndex {
  gateways: Set<string>;
  contexts: Array<{ context: string; apiId: string }>;
  backends: Map<string, string>;
}

/** Catálogo gobernado: contextos publicados en los gateways y backends de cada API (incluidos los de sus flujos). */
async function catalogIndex(ctx: EngineContext): Promise<CatalogIndex> {
  const apis = (await ctx.db.query("SELECT id, context, version FROM nexo.api_asset WHERE state <> 'RETIRED'")).rows;
  const contexts = apis.map((a) => ({ context: `${String(a.context).replace(/\/+$/, "")}/${a.version}`, apiId: String(a.id) }));
  const backends = new Map<string, string>();
  const direct = await ctx.db.query(
    `SELECT e.from_id AS api, n.id AS node FROM nexo.graph_edge e JOIN nexo.graph_node n ON n.id = e.to_id
     WHERE e.from_id LIKE 'api:%' AND e.relation = 'llama' AND n.type = 'sistema'
     UNION
     SELECT e1.from_id, n.id FROM nexo.graph_edge e1 JOIN nexo.graph_edge e2 ON e2.from_id = e1.to_id JOIN nexo.graph_node n ON n.id = e2.to_id
     WHERE e1.from_id LIKE 'api:%' AND e1.to_id LIKE 'flujo:%' AND n.type = 'sistema'`,
  );
  for (const r of direct.rows) backends.set(String(r.node).replace(/^sistema:/, ""), String(r.api));
  for (const r of (await ctx.db.query("SELECT api_id, stable_url, candidate_url FROM nexo.traffic_route")).rows) {
    for (const u of [r.stable_url, r.candidate_url].filter(Boolean)) backends.set(new URL(String(u)).host, `api:${r.api_id}`);
  }
  const gateways = new Set(
    env("NEXO_DISCOVERY_GATEWAYS", "apim:8243,apim:8280,gw-publico:8243,dev.nexo.lab:8243,qa.nexo.lab:8243,operadores.nexo.lab:8243,publico.nexo.lab:18243")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { gateways, contexts, backends };
}

function match(f: RawFinding, idx: CatalogIndex): { matchedApiId?: string; governed: boolean; bypass: boolean } {
  const hp = `${f.host}:${f.port ?? 80}`;
  if (idx.gateways.has(hp)) {
    const hit = idx.contexts.find((c) => f.path === c.context || f.path.startsWith(`${c.context}/`));
    return hit ? { matchedApiId: hit.apiId, governed: true, bypass: false } : { governed: false, bypass: false };
  }
  const backend = idx.backends.get(hp);
  if (backend) return { matchedApiId: backend, governed: true, bypass: true };
  // Una ruta del gateway "actual" que lleva al backend de una API gobernada es un camino paralelo al gobierno.
  const dest = (f.evidence.destino as string | string[] | undefined) ?? [];
  for (const d of Array.isArray(dest) ? dest : [dest]) {
    const host = /^https?:\/\//.test(d) ? new URL(d).host : d;
    const api = idx.backends.get(host);
    if (api) return { matchedApiId: api, governed: false, bypass: true };
  }
  return { governed: false, bypass: false };
}

/** Busca un contrato publicado bajo el prefijo de una ruta del gateway "actual". */
async function specUnderPrefix(f: RawFinding): Promise<{ spec: ParsedSpec; at: string } | undefined> {
  if (!f.probe) return undefined;
  const base = new URL(f.probe.url);
  const prefix = f.path.split("/").slice(0, 2).join("/");
  for (const suffix of SPEC_SUFFIXES) {
    const url = `${base.protocol}//${base.host}${prefix}${suffix}`;
    try {
      const res = await fetch(url, { dispatcher: insecure, headers: { "user-agent": SCANNER_AGENT, ...(f.probe.host ? { host: f.probe.host } : {}) }, signal: AbortSignal.timeout(4000) });
      if (res.status !== 200) {
        await res.arrayBuffer();
        continue;
      }
      const spec = parseSpec(await res.text(), res.headers.get("content-type") ?? "");
      if (spec) return { spec, at: `${prefix}${suffix}` };
    } catch {
      /* sin contrato en esa ruta */
    }
  }
  return undefined;
}

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

async function collect(ctx: EngineContext, scan: Row): Promise<{ findings: RawFinding[]; errors: string[] }> {
  const sources = (scan.sources as string[]) ?? [];
  const errors: string[] = [];
  const findings: RawFinding[] = [];
  const safe = async (name: string, fn: () => Promise<RawFinding[]> | RawFinding[]) => {
    try {
      findings.push(...(await fn()));
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (sources.includes("apisix")) {
    const admin = opt("NEXO_DISCOVERY_APISIX_ADMIN");
    if (!admin) errors.push("apisix: no está configurada la Admin API (NEXO_DISCOVERY_APISIX_ADMIN)");
    else await safe("apisix", () => apisixFindings(admin, env("NEXO_DISCOVERY_APISIX_KEY"), env("NEXO_DISCOVERY_APISIX_ADDRESS", "apisix:9080")));
  }
  if (sources.includes("nginx")) {
    const conf = opt("NEXO_DISCOVERY_NGINX_CONF");
    if (!conf) errors.push("nginx: no está configurada la ruta de la configuración (NEXO_DISCOVERY_NGINX_CONF)");
    else await safe("nginx", () => nginxFindings(conf, opt("NEXO_DISCOVERY_NGINX_LOG"), env("NEXO_DISCOVERY_NGINX_ADDRESS", "localhost:80")));
  }
  // Contratos publicados detrás de las rutas de los gateways "actuales".
  const gatewayFindings = [...findings];
  const prefixes = new Map<string, RawFinding>();
  for (const f of gatewayFindings) prefixes.set(`${f.source}|${f.host}|${f.path.split("/").slice(0, 2).join("/")}`, f);
  for (const f of prefixes.values()) {
    const found = await specUnderPrefix(f);
    if (!found) continue;
    for (const g of gatewayFindings.filter((x) => x.source === f.source && x.host === f.host && x.path.startsWith(f.path.split("/").slice(0, 2).join("/")))) {
      g.spec = found.spec;
      g.evidence.contrato = found.at;
    }
    for (const p of found.spec.paths.filter((p) => !gatewayFindings.some((x) => x.source === f.source && x.host === f.host && x.path === p))) {
      findings.push({ ...f, path: p, spec: found.spec, observedCalls: 0, probe: f.probe && !p.includes("{") ? { ...f.probe, url: `${new URL(f.probe.url).origin}${p}` } : undefined, evidence: { ...f.evidence, contrato: found.at } });
    }
  }
  if (sources.includes("red")) {
    const targets = (scan.targets as string[])?.length ? (scan.targets as string[]) : env("NEXO_DISCOVERY_TARGETS", "").split(",");
    await safe("red", async () => (await pool(expandTargets(targets.filter(Boolean)), num("NEXO_DISCOVERY_CONCURRENCY", 8), (t) => networkFindings(t))).flat());
  }
  if (sources.includes("gcp")) {
    const key = opt("NEXO_GCP_SA_KEY");
    const project = opt("NEXO_GCP_PROJECT");
    if (!key || !project) errors.push("gcp: faltan credenciales (NEXO_GCP_SA_KEY y NEXO_GCP_PROJECT)");
    else await safe("gcp", () => gcpFindings(key, project));
  }
  const unique = new Map<string, RawFinding>();
  for (const f of findings) {
    // El documento del contrato no es una operación de la API: queda como evidencia del hallazgo.
    const contract = typeof f.evidence.contrato === "string" ? f.evidence.contrato.split("?")[0] : undefined;
    if (contract && f.path === contract) continue;
    unique.set(fingerprint(f), f);
  }
  return { findings: [...unique.values()], errors };
}

async function runScan(ctx: EngineContext, scan: Row) {
  const { findings, errors } = await collect(ctx, scan);
  const idx = await catalogIndex(ctx);
  let created = 0;
  let highRisk = 0;
  let ungoverned = 0;
  const bySource: Record<string, number> = {};
  // Las rutas con parámetros no se sondean: heredan lo observado en otra ruta del mismo servicio.
  const probed = new Map<string, Awaited<ReturnType<typeof probe>>>();
  const ordered = [...findings].sort((a, b) => Number(!a.probe) - Number(!b.probe));
  for (const f of ordered) {
    const service = `${f.source}|${f.host}|${f.port ?? ""}`;
    let p = await probe(f);
    if (!f.probe && p.auth === "desconocida" && probed.has(service)) p = { ...probed.get(service)!, personal: [], status: undefined };
    else if (f.probe && !probed.has(service)) probed.set(service, p);
    const personal = [...new Set([...(f.spec?.personalFields ?? []), ...p.personal])];
    const tls = f.tls ?? (f.protocol === "https" ? ((await tlsInfo(f.host, f.port ?? 443)) ?? "sin TLS") : "sin TLS");
    const m = match(f, idx);
    const auth = p.auth;
    const { score, reasons } = exposureScore({ auth, tls, personalData: personal, governed: m.governed, bypassesGateway: m.bypass, external: f.external, specFound: !!f.spec });
    const autoStatus = m.governed && !m.bypass ? "gobernado" : "nuevo";
    const authLabel = f.authDetail && auth === f.authHint ? `${auth} · ${f.authDetail}` : auth;
    const res = await ctx.db.query(
      `INSERT INTO nexo.discovery_finding (fingerprint, scan_id, source, host, port, path, protocol, spec_found, auth_detected, tls,
         personal_data_suspected, matched_api_id, exposure_score, reasons, status, evidence, observed_calls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (fingerprint) DO UPDATE SET scan_id = EXCLUDED.scan_id, protocol = EXCLUDED.protocol, spec_found = EXCLUDED.spec_found,
         auth_detected = EXCLUDED.auth_detected, tls = EXCLUDED.tls, personal_data_suspected = EXCLUDED.personal_data_suspected,
         matched_api_id = EXCLUDED.matched_api_id, exposure_score = EXCLUDED.exposure_score, reasons = EXCLUDED.reasons,
         evidence = EXCLUDED.evidence, observed_calls = EXCLUDED.observed_calls, last_seen = now(),
         status = CASE WHEN nexo.discovery_finding.status IN ('nuevo', 'gobernado') THEN EXCLUDED.status ELSE nexo.discovery_finding.status END
       RETURNING (xmax = 0) AS inserted, status`,
      [
        fingerprint(f),
        scan.id,
        f.source,
        f.host,
        f.port ?? null,
        f.path,
        f.protocol,
        !!f.spec,
        authLabel,
        tls,
        personal.length > 0,
        m.matchedApiId ?? null,
        score,
        reasons,
        autoStatus,
        JSON.stringify({ ...f.evidence, ...(personal.length ? { datosPersonales: personal } : {}), ...(p.status ? { respuestaSinCredenciales: p.status } : {}) }),
        f.observedCalls ?? 0,
      ],
    );
    const row = res.rows[0];
    bySource[f.source] = (bySource[f.source] ?? 0) + 1;
    if (!m.governed) ungoverned++;
    if (score >= 70) highRisk++;
    if (row?.inserted) {
      created++;
      if (score >= 70) {
        await ctx.alert({
          name: "ApiNoGobernadaRiesgoAlto",
          severity: "S3",
          summary: `API no gobernada con exposición ${score}: ${f.host}${f.port ? `:${f.port}` : ""}${f.path} (${reasons.slice(0, 2).join("; ")})`,
          labels: { fuente: f.source },
        });
      }
    }
  }
  return { hallazgos: findings.length, nuevos: created, noGobernados: ungoverned, riesgoAlto: highRisk, porFuente: bySource, errores: errors };
}

let lastScheduled = 0;

export const discoveryEngine: Engine = {
  name: "descubrimiento",
  lockKey: 727101,
  intervalMs: num("NEXO_DISCOVERY_INTERVAL_MS", 10_000),
  async init(ctx) {
    scansTotal = new Counter({ name: "nexo_descubrimiento_escaneos_total", help: "Escaneos ejecutados", labelNames: ["resultado"], registers: [ctx.registry] });
    findingsGauge = new Gauge({ name: "nexo_descubrimiento_hallazgos", help: "Hallazgos por estado", labelNames: ["estado"], registers: [ctx.registry] });
  },
  async tick(ctx) {
    const everyMin = num("NEXO_DISCOVERY_SCHEDULE_MIN", 0);
    if (everyMin > 0 && Date.now() - lastScheduled > everyMin * 60_000) {
      const recent = await ctx.db.query("SELECT 1 FROM nexo.discovery_scan WHERE requested_by = 'nexo-descubrimiento' AND started_at > now() - make_interval(mins => $1)", [everyMin]);
      if (!recent.rowCount) {
        await ctx.db.query("INSERT INTO nexo.discovery_scan (sources, targets, requested_by) VALUES ($1, '{}', 'nexo-descubrimiento')", [
          env("NEXO_DISCOVERY_SCHEDULE_SOURCES", "apisix,nginx,red").split(","),
        ]);
      }
      lastScheduled = Date.now();
    }
    const scan = (await ctx.db.query("SELECT * FROM nexo.discovery_scan WHERE status = 'en_curso' ORDER BY started_at LIMIT 1")).rows[0];
    if (scan) {
      ctx.log("info", `escaneo ${scan.id} iniciado (${(scan.sources as string[]).join(", ")})`);
      try {
        const totals = await runScan(ctx, scan);
        const status = totals.hallazgos === 0 && totals.errores.length ? "fallido" : "terminado";
        await ctx.db.query("UPDATE nexo.discovery_scan SET status = $1, totals = $2, error = $3, finished_at = now() WHERE id = $4", [
          status,
          JSON.stringify(totals),
          totals.errores.length ? totals.errores.join(" · ") : null,
          scan.id,
        ]);
        scansTotal.inc({ resultado: status });
        await ctx.audit("descubrimiento.escaneo.terminar", `scan/${scan.id}`, status === "terminado" ? "exito" : "error", totals);
        ctx.log("info", `escaneo ${scan.id} ${status}`, totals);
      } catch (e) {
        await ctx.db.query("UPDATE nexo.discovery_scan SET status = 'fallido', error = $1, finished_at = now() WHERE id = $2", [e instanceof Error ? e.message : String(e), scan.id]);
        scansTotal.inc({ resultado: "fallido" });
        throw e;
      }
    }
    for (const r of (await ctx.db.query("SELECT status, count(*)::int AS n FROM nexo.discovery_finding GROUP BY status")).rows) findingsGauge.set({ estado: r.status }, r.n);
    return { escaneoEnCurso: scan?.id ?? null };
  },
};
