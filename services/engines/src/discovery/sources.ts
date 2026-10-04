import { createSign } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { Agent, fetch } from "undici";
import { parseAccessLog, parseNginxConfig, parseSpec, personalDataInBody, SCANNER_AGENT, type ParsedSpec } from "./analysis.js";

/** Hallazgo antes de compararlo con el catálogo y de calcular su exposición. */
export interface RawFinding {
  source: "apisix" | "nginx" | "red" | "gcp";
  host: string;
  port?: number;
  path: string;
  protocol: string;
  /** URL para sondear sin credenciales (GET) y una cabecera Host opcional. */
  probe?: { url: string; host?: string };
  spec?: ParsedSpec;
  /** Autenticación declarada en la configuración (plugin de APISIX, directiva de NGINX, IAM de GCP). */
  authHint?: "requerida" | "ninguna";
  authDetail?: string;
  tls?: string;
  external: boolean;
  observedCalls?: number;
  evidence: Record<string, unknown>;
}

const insecure = new Agent({ connect: { rejectUnauthorized: false }, headersTimeout: 5000, bodyTimeout: 5000 });
const PROBE_TIMEOUT = 4000;

function splitHostPort(addr: string, defPort: number): { host: string; port: number } {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(addr.trim());
  return { host: m?.[1] ?? addr, port: Number(m?.[2] ?? defPort) };
}

// ------------------------------------------------------------------ APISIX (Admin API)

const APISIX_AUTH_PLUGINS = ["key-auth", "jwt-auth", "basic-auth", "hmac-auth", "openid-connect", "authz-keycloak", "ldap-auth", "forward-auth", "wolf-rbac", "authz-casdoor", "cas-auth"];

type ApisixRoute = {
  id?: string;
  name?: string;
  uri?: string;
  uris?: string[];
  host?: string;
  hosts?: string[];
  methods?: string[];
  status?: number;
  plugins?: Record<string, unknown>;
  upstream?: { nodes?: Record<string, number> | Array<{ host: string; port: number }>; scheme?: string };
  upstream_id?: string;
};

export async function apisixFindings(adminUrl: string, apiKey: string, address: string): Promise<RawFinding[]> {
  const headers = { "x-api-key": apiKey };
  const res = await fetch(`${adminUrl.replace(/\/+$/, "")}/apisix/admin/routes`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`APISIX Admin API respondió ${res.status}`);
  const body = (await res.json()) as { list?: Array<{ value: ApisixRoute }> };
  const gw = splitHostPort(address, 9080);
  const out: RawFinding[] = [];
  for (const { value: r } of body.list ?? []) {
    if (r.status === 0) continue; // ruta deshabilitada
    let upstream = r.upstream;
    if (!upstream && r.upstream_id) {
      const u = await fetch(`${adminUrl.replace(/\/+$/, "")}/apisix/admin/upstreams/${r.upstream_id}`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      upstream = u?.ok ? ((await u.json()) as { value?: ApisixRoute["upstream"] }).value : undefined;
    }
    const nodes = Array.isArray(upstream?.nodes) ? upstream!.nodes.map((n) => `${n.host}:${n.port}`) : Object.keys(upstream?.nodes ?? {});
    const auth = APISIX_AUTH_PLUGINS.filter((p) => r.plugins && p in r.plugins);
    for (const uri of r.uris ?? (r.uri ? [r.uri] : [])) {
      const path = uri.replace(/\/\*$/, "").replace(/\*$/, "") || "/";
      out.push({
        source: "apisix",
        host: r.hosts?.[0] ?? r.host ?? gw.host,
        port: gw.port,
        path,
        protocol: "http",
        probe: { url: `http://${gw.host}:${gw.port}${path}`, host: r.hosts?.[0] ?? r.host },
        authHint: auth.length ? "requerida" : undefined,
        authDetail: auth.length ? `APISIX (${auth.join(", ")})` : undefined,
        external: true,
        evidence: { ruta: r.id ?? r.name, metodos: r.methods ?? ["todos"], destino: nodes, plugins: Object.keys(r.plugins ?? {}) },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ NGINX (configuración y registro de accesos)

export function nginxFindings(confPath: string, logPath: string | undefined, address: string): RawFinding[] {
  const files = statSync(confPath).isDirectory()
    ? readdirSync(confPath)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => join(confPath, f))
    : [confPath];
  const locations = files.flatMap((f) => parseNginxConfig(readFileSync(f, "utf8")).map((l) => ({ ...l, file: f })));
  let observed = new Map<string, { calls: number; statuses: Record<string, number> }>();
  if (logPath) {
    try {
      observed = parseAccessLog(readFileSync(logPath, "utf8"));
    } catch {
      /* sin registro disponible: solo configuración */
    }
  }
  const gw = splitHostPort(address, 80);
  const out: RawFinding[] = [];
  for (const loc of locations) {
    if (loc.static) continue; // respuestas fijas (p. ej. /health) no son APIs
    const serverName = loc.serverNames.find((n) => n !== "_" && !n.startsWith("~")) ?? gw.host;
    // Las rutas concretas vistas en el registro dicen qué se usa de verdad bajo cada location.
    const seen = [...observed.entries()].filter(([p]) => (loc.exact ? p === loc.path : p.startsWith(loc.path)));
    const paths = seen.length ? seen : [[loc.path.replace(/\/+$/, "") || "/", { calls: 0, statuses: {} }] as const];
    for (const [path, stats] of paths) {
      out.push({
        source: "nginx",
        host: serverName,
        port: loc.listen,
        path,
        protocol: loc.tls ? "https" : "http",
        probe: { url: `${loc.tls ? "https" : "http"}://${gw.host}:${gw.port}${path}`, host: serverName },
        authHint: loc.auth ? "requerida" : undefined,
        authDetail: loc.auth,
        tls: loc.tls ? undefined : "sin TLS",
        external: true,
        observedCalls: stats.calls,
        evidence: { archivo: loc.file, location: loc.path, destino: loc.upstream, respuestas: stats.statuses },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ red (objetivos autorizados)

const SPEC_PATHS = ["/openapi.json", "/openapi.yaml", "/swagger.json", "/v3/api-docs", "/v2/api-docs", "/swagger/v1/swagger.json", "/api-docs", "/?wsdl"];

/** Expande objetivos "host:puerto" y rangos "a.b.c.d/nn:p1|p2" (como máximo /24). */
export function expandTargets(targets: readonly string[]): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const t of targets.map((x) => x.trim()).filter(Boolean)) {
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d+):([\d|]+)$/.exec(t);
    if (cidr) {
      const bits = Number(cidr[2]);
      if (bits < 24 || bits > 32) throw new Error(`Rango ${t} demasiado amplio: el máximo permitido es /24`);
      const base = cidr[1]!.split(".").map(Number).reduce((a, b) => a * 256 + b, 0) & ~((1 << (32 - bits)) - 1);
      const count = 2 ** (32 - bits);
      for (let i = 0; i < count; i++) {
        const ip = base + i;
        const host = [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");
        for (const p of cidr[3]!.split("|")) out.push({ host, port: Number(p) });
      }
    } else out.push(splitHostPort(t, 80));
  }
  return out;
}

/** Versión de TLS y vigencia del certificado; undefined si el puerto no habla TLS. */
export function tlsInfo(host: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = tlsConnect({ host, port, servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 2500 }, () => {
      const proto = sock.getProtocol() ?? "TLS";
      const cert = sock.getPeerCertificate();
      sock.end();
      if (cert?.valid_to && new Date(cert.valid_to).getTime() < Date.now()) return resolve("certificado vencido");
      resolve(proto === "TLSv1.3" || proto === "TLSv1.2" ? proto : "TLS débil");
    });
    sock.on("error", () => resolve(undefined));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(undefined);
    });
  });
}

async function get(url: string, hostHeader?: string): Promise<{ status: number; type: string; body: string } | undefined> {
  try {
    const res = await fetch(url, { dispatcher: insecure, headers: { "user-agent": SCANNER_AGENT, ...(hostHeader ? { host: hostHeader } : {}) }, signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 256 * 1024);
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: buf.toString("utf8") };
  } catch {
    return undefined;
  }
}

async function graphqlIntrospection(base: string): Promise<ParsedSpec | undefined> {
  try {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      dispatcher: insecure,
      headers: { "content-type": "application/json", "user-agent": SCANNER_AGENT },
      body: JSON.stringify({ query: "{ __schema { queryType { name } types { name fields { name } } } }" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    if (!res.ok) return undefined;
    return parseSpec(await res.text(), "application/json");
  } catch {
    return undefined;
  }
}

/** Sondea un objetivo: TLS, rutas típicas de contratos y GraphQL. Solo lecturas (GET y consulta de introspección). */
export async function networkFindings(target: { host: string; port: number }, extraSpecPaths: readonly string[] = []): Promise<RawFinding[]> {
  const tls = await tlsInfo(target.host, target.port);
  const scheme = tls ? "https" : "http";
  const base = `${scheme}://${target.host}:${target.port}`;
  const root = await get(`${base}/`);
  if (!root) return []; // nada escucha HTTP en ese puerto
  const out: RawFinding[] = [];
  for (const p of [...SPEC_PATHS, ...extraSpecPaths]) {
    const r = await get(`${base}${p}`);
    if (!r || r.status !== 200) continue;
    const spec = parseSpec(r.body, r.type);
    if (!spec) continue;
    for (const path of spec.paths.length ? spec.paths : ["/"]) {
      const concrete = !path.includes("{") && !path.startsWith("#");
      out.push({
        source: "red",
        host: target.host,
        port: target.port,
        path: path.startsWith("#") ? `${p}${path}` : path,
        protocol: spec.kind === "wsdl" ? "soap" : scheme,
        probe: concrete ? { url: `${base}${path}` } : undefined,
        spec,
        tls: tls ?? "sin TLS",
        external: false,
        evidence: { contrato: p, especificacion: `${spec.kind}${spec.title ? ` · ${spec.title} ${spec.version ?? ""}` : ""}` },
      });
    }
    break; // un contrato por objetivo basta
  }
  const gql = await graphqlIntrospection(base);
  if (gql) {
    // La introspección respondió sin credenciales: el esquema completo está a la vista de cualquiera.
    out.push({
      source: "red",
      host: target.host,
      port: target.port,
      path: "/graphql",
      protocol: "graphql",
      probe: undefined,
      spec: gql,
      authHint: "ninguna",
      authDetail: "introspección GraphQL abierta",
      tls: tls ?? "sin TLS",
      external: false,
      evidence: { contrato: "introspección GraphQL" },
    });
  }
  if (!out.length) {
    out.push({
      source: "red",
      host: target.host,
      port: target.port,
      path: "/",
      protocol: scheme,
      probe: { url: `${base}/` },
      tls: tls ?? "sin TLS",
      external: false,
      evidence: { nota: "servicio HTTP sin contrato publicado en las rutas típicas", respuestaRaiz: root.status },
    });
  }
  return out;
}

/** Sondeo sin credenciales: ¿exige autenticación? ¿la respuesta trae datos personales? */
export async function probe(f: RawFinding): Promise<{ auth: "ninguna" | "requerida" | "desconocida"; status?: number; personal: string[] }> {
  if (!f.probe) return { auth: f.authHint ?? "desconocida", personal: [] };
  const r = await get(f.probe.url, f.probe.host);
  if (!r) return { auth: f.authHint ?? "desconocida", personal: [] };
  const auth = r.status === 401 || r.status === 403 ? "requerida" : r.status < 500 ? (f.authHint === "requerida" ? "requerida" : "ninguna") : (f.authHint ?? "desconocida");
  return { auth, status: r.status, personal: r.status < 300 ? personalDataInBody(r.body) : [] };
}

// ------------------------------------------------------------------ Google Cloud (Cloud Run y API Gateway)

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

async function gcpToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: key.client_email, scope: "https://www.googleapis.com/auth/cloud-platform.read-only", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
  });
  if (!res.ok) throw new Error(`Google OAuth respondió ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export interface CloudRunService {
  name: string;
  uri?: string;
  ingress?: string;
}

/** Hallazgos a partir de servicios de Cloud Run: ingreso abierto y si permiten invocación sin autenticación. */
export function cloudRunToFindings(services: readonly CloudRunService[], publicInvokers: ReadonlySet<string>): RawFinding[] {
  return services
    .filter((s) => s.uri)
    .map((s) => {
      const u = new URL(s.uri!);
      const open = publicInvokers.has(s.name);
      return {
        source: "gcp" as const,
        host: u.hostname,
        port: 443,
        path: "/",
        protocol: "https",
        probe: { url: `${s.uri}` },
        authHint: open ? ("ninguna" as const) : ("requerida" as const),
        authDetail: open ? "Cloud Run permite invocación sin autenticación (allUsers)" : "Cloud Run exige identidad (IAM)",
        external: s.ingress === "INGRESS_TRAFFIC_ALL",
        evidence: { servicio: s.name, ingreso: s.ingress },
      };
    });
}

export async function gcpFindings(keyJson: string, project: string): Promise<RawFinding[]> {
  const key = JSON.parse(keyJson.trim().startsWith("{") ? keyJson : Buffer.from(keyJson, "base64").toString("utf8")) as ServiceAccountKey;
  const token = await gcpToken(key);
  const auth = { authorization: `Bearer ${token}` };
  const res = await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/-/services`, { headers: auth });
  if (!res.ok) throw new Error(`Cloud Run respondió ${res.status}`);
  const services = (((await res.json()) as { services?: CloudRunService[] }).services ?? []).map((s) => ({ name: s.name, uri: s.uri, ingress: s.ingress }));
  const open = new Set<string>();
  for (const s of services) {
    const p = await fetch(`https://run.googleapis.com/v2/${s.name}:getIamPolicy`, { headers: auth }).catch(() => undefined);
    const policy = p?.ok ? ((await p.json()) as { bindings?: Array<{ role: string; members?: string[] }> }) : undefined;
    if (policy?.bindings?.some((b) => b.role === "roles/run.invoker" && b.members?.includes("allUsers"))) open.add(s.name);
  }
  const out = cloudRunToFindings(services, open);
  // API Gateway administrado de Google: cada gateway publica un host propio.
  const gws = await fetch(`https://apigateway.googleapis.com/v1/projects/${project}/locations/-/gateways`, { headers: auth }).catch(() => undefined);
  if (gws?.ok) {
    for (const g of ((await gws.json()) as { gateways?: Array<{ name: string; defaultHostname?: string; apiConfig?: string }> }).gateways ?? []) {
      if (!g.defaultHostname) continue;
      out.push({
        source: "gcp",
        host: g.defaultHostname,
        port: 443,
        path: "/",
        protocol: "https",
        probe: { url: `https://${g.defaultHostname}/` },
        external: true,
        evidence: { gateway: g.name, configuracion: g.apiConfig },
      });
    }
  }
  return out;
}
