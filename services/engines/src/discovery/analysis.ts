import { isValidRut } from "@nexo/shared";
import { parse as parseYaml } from "yaml";

/**
 * Análisis puro del motor de descubrimiento (D-01): datos personales en contratos y respuestas, lectura de
 * especificaciones (OpenAPI 2/3, WSDL, GraphQL), configuración y registros de NGINX, y puntaje de exposición.
 */

// ------------------------------------------------------------------ datos personales (Ley 19.628 / 21.719)

const PERSONAL_FIELDS: Array<[RegExp, string]> = [
  [/^rut(_?\w+)?$|^run$/i, "RUT"],
  [/e-?mail|correo/i, "correo"],
  [/tel[eé]fono|celular|^phone|movil/i, "teléfono"],
  [/^nombres?$|^apellidos?$|nombre_?completo|^full_?name$/i, "nombre"],
  [/direcci[oó]n|domicilio|^address$/i, "dirección"],
  [/fecha_?(de_?)?nacimiento|birth/i, "fecha de nacimiento"],
  [/pasaporte|^dni$/i, "documento de identidad"],
];

/** Nombres de campos de una especificación que sugieren datos personales. */
export function personalFieldsInSpec(spec: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 30) return;
    const props = (node as { properties?: Record<string, unknown> }).properties;
    if (props && typeof props === "object") {
      for (const name of Object.keys(props)) for (const [re, label] of PERSONAL_FIELDS) if (re.test(name)) found.add(label);
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
  };
  walk(spec, 0);
  return [...found];
}

const RUT_RE = /\b(\d{1,2}\.?\d{3}\.?\d{3})-([\dkK])\b/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(\+?56)?\s?9\s?\d{4}\s?\d{4}/;

/** Datos personales presentes en una respuesta de muestra (RUT con dígito verificador válido, correo, teléfono). */
export function personalDataInBody(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(RUT_RE)) if (isValidRut(`${m[1]}-${m[2]}`)) found.add("RUT");
  if (EMAIL_RE.test(text)) found.add("correo");
  if (PHONE_RE.test(text)) found.add("teléfono");
  return [...found];
}

// ------------------------------------------------------------------ especificaciones

export interface ParsedSpec {
  kind: "openapi3" | "swagger2" | "wsdl" | "graphql";
  title?: string;
  version?: string;
  /** Rutas declaradas (en OpenAPI se antepone basePath o la ruta del primer servidor). */
  paths: string[];
  securityDeclared: boolean;
  personalFields: string[];
}

export function parseSpec(body: string, contentType = ""): ParsedSpec | undefined {
  const text = body.trim();
  if (/<(wsdl:)?definitions\b/i.test(text) || /<(wsdl2?:)?description\b[^>]*wsdl/i.test(text)) {
    const ops = [...text.matchAll(/<(?:wsdl:)?operation\s+name="([^"]+)"/gi)].map((m) => m[1]!);
    return { kind: "wsdl", paths: [...new Set(ops)].map((o) => `#${o}`), securityDeclared: /wsse:|wsp:Policy/i.test(text), personalFields: [] };
  }
  let doc: Record<string, unknown> | undefined;
  try {
    doc = (text.startsWith("{") || contentType.includes("json") ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const info = (doc.info ?? {}) as { title?: string; version?: string };
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string") {
    const isV3 = typeof doc.openapi === "string";
    const servers = (doc.servers as Array<{ url?: string }> | undefined) ?? [];
    let prefix = isV3 ? (servers[0]?.url ?? "") : String(doc.basePath ?? "");
    try {
      if (/^https?:\/\//.test(prefix)) prefix = new URL(prefix).pathname;
    } catch {
      prefix = "";
    }
    prefix = prefix.replace(/\/+$/, "");
    const paths = Object.keys((doc.paths ?? {}) as Record<string, unknown>).map((p) => `${prefix}${p}`);
    const components = (doc.components ?? {}) as { securitySchemes?: object };
    const securityDeclared = !!(doc.security || doc.securityDefinitions || components.securitySchemes);
    return { kind: isV3 ? "openapi3" : "swagger2", title: info.title, version: info.version, paths, securityDeclared, personalFields: personalFieldsInSpec(doc) };
  }
  const data = (doc.data ?? doc) as { __schema?: { queryType?: { name?: string }; types?: Array<{ name: string; fields?: Array<{ name: string }> | null }> } };
  if (data.__schema) {
    const fields = (data.__schema.types ?? []).flatMap((t) => (t.fields ?? []).map((f) => f.name));
    const asProps = { properties: Object.fromEntries(fields.map((f) => [f, {}])) };
    return { kind: "graphql", paths: ["/graphql"], securityDeclared: false, personalFields: personalFieldsInSpec(asProps) };
  }
  return undefined;
}

// ------------------------------------------------------------------ NGINX

export interface NginxLocation {
  serverNames: string[];
  listen: number;
  tls: boolean;
  path: string;
  exact: boolean;
  upstream?: string;
  auth?: string;
  /** El bloque responde directamente (return) en vez de redirigir a un backend. */
  static: boolean;
}

/** Lee bloques server/location de una configuración de NGINX (lo necesario para inventariar APIs). */
export function parseNginxConfig(conf: string): NginxLocation[] {
  const text = conf.replace(/#[^\n]*/g, "");
  const out: NginxLocation[] = [];
  const tokens = text.match(/[{};]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s{};]+/g) ?? [];
  type Ctx = { kind: string; args: string[]; directives: Array<[string, string[]]>; children: Ctx[] };
  const root: Ctx = { kind: "root", args: [], directives: [], children: [] };
  const stack: Ctx[] = [root];
  let words: string[] = [];
  for (const t of tokens) {
    if (t === "{") {
      const ctx: Ctx = { kind: words[0] ?? "", args: words.slice(1), directives: [], children: [] };
      stack.at(-1)!.children.push(ctx);
      stack.push(ctx);
      words = [];
    } else if (t === "}") {
      stack.pop();
      words = [];
    } else if (t === ";") {
      if (words.length) stack.at(-1)!.directives.push([words[0]!, words.slice(1)]);
      words = [];
    } else words.push(t.replace(/^["']|["']$/g, ""));
  }
  const servers: Ctx[] = [];
  const collect = (c: Ctx) => {
    for (const ch of c.children) {
      if (ch.kind === "server") servers.push(ch);
      else collect(ch);
    }
  };
  collect(root);
  for (const srv of servers) {
    const listenArgs = srv.directives.filter(([d]) => d === "listen").map(([, a]) => a);
    const first = listenArgs[0] ?? ["80"];
    const port = Number((first[0] ?? "80").split(":").pop()) || 80;
    const tls = listenArgs.some((a) => a.includes("ssl")) || srv.directives.some(([d, a]) => d === "ssl" && a[0] === "on");
    const serverNames = srv.directives.filter(([d]) => d === "server_name").flatMap(([, a]) => a);
    const serverAuth = authOf(srv.directives);
    for (const loc of srv.children.filter((c) => c.kind === "location")) {
      const exact = loc.args[0] === "=";
      const path = exact ? (loc.args[1] ?? "/") : (loc.args.at(-1) ?? "/");
      if (path.startsWith("@") || loc.args[0] === "~" || loc.args[0] === "~*") continue;
      const proxy = loc.directives.find(([d]) => d === "proxy_pass" || d === "fastcgi_pass" || d === "grpc_pass" || d === "uwsgi_pass");
      out.push({
        serverNames,
        listen: port,
        tls,
        path,
        exact,
        upstream: proxy?.[1][0],
        auth: authOf(loc.directives) ?? serverAuth,
        static: !proxy,
      });
    }
  }
  return out;
}

function authOf(directives: Array<[string, string[]]>): string | undefined {
  for (const [d, a] of directives) {
    if (d === "auth_basic" && a[0] !== "off") return "basic (NGINX)";
    if (d === "auth_request") return "subpetición de autenticación (NGINX)";
    if (d === "auth_jwt") return "JWT (NGINX)";
    if (d === "ssl_verify_client" && a[0] === "on") return "certificado de cliente (mTLS)";
  }
  return undefined;
}

/** User-Agent de todas las peticiones del motor: sus propios sondeos no deben contarse como uso real. */
export const SCANNER_AGENT = "nexo-descubrimiento/0.1 (+inventario de APIs autorizado)";

/**
 * Registro de accesos (formato combined): llamadas por ruta, sin parámetros de consulta. Se ignoran los sondeos
 * del propio motor y las rutas que nunca respondieron algo distinto de 404 (no existen).
 */
export function parseAccessLog(text: string, maxLines = 200_000): Map<string, { calls: number; statuses: Record<string, number> }> {
  const out = new Map<string, { calls: number; statuses: Record<string, number> }>();
  const lines = text.split("\n");
  for (const line of lines.slice(-maxLines)) {
    const m = /"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^ ?"]+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/.exec(line);
    if (!m || m[3]!.startsWith("nexo-descubrimiento/")) continue;
    const e = out.get(m[1]!) ?? { calls: 0, statuses: {} };
    e.calls++;
    e.statuses[m[2]!] = (e.statuses[m[2]!] ?? 0) + 1;
    out.set(m[1]!, e);
  }
  for (const [path, e] of out) if (Object.keys(e.statuses).every((st) => st === "404")) out.delete(path);
  return out;
}

// ------------------------------------------------------------------ puntaje de exposición

export interface ExposureInput {
  auth: "ninguna" | "requerida" | "desconocida" | string;
  tls: "sin TLS" | "TLSv1.3" | "TLSv1.2" | "TLS débil" | "certificado vencido" | string | undefined;
  personalData: string[];
  governed: boolean;
  /** Es el backend de una API gobernada, pero responde sin pasar por el gateway. */
  bypassesGateway: boolean;
  /** Publicada hacia afuera (gateway "actual", balanceador público o ingreso abierto en la nube). */
  external: boolean;
  specFound: boolean;
}

export function exposureScore(i: ExposureInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, reason: string) => {
    score += pts;
    reasons.push(reason);
  };
  if (i.auth === "ninguna") add(35, "responde sin autenticación");
  else if (i.auth === "desconocida") add(15, "no se pudo determinar la autenticación");
  if (i.personalData.length) add(25, `posibles datos personales (${i.personalData.join(", ")})`);
  if (!i.governed) add(15, "no está en el catálogo gobernado");
  if (i.bypassesGateway) add(10, "backend de una API gobernada accesible sin pasar por el gateway");
  if (!i.tls || i.tls === "sin TLS") add(10, "sin TLS");
  else if (i.tls === "TLS débil" || i.tls === "certificado vencido") add(10, i.tls);
  if (i.external) add(10, "expuesta hacia afuera");
  if (!i.specFound) add(5, "sin contrato publicado");
  return { score: Math.min(100, score), reasons };
}
