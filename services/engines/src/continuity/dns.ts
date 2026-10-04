import { createSign } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { spawn } from "node:child_process";
import { fetch } from "undici";

/** Ejecuta `nsupdate` pasándole el guion por stdin y devuelve su salida combinada. */
function nsupdate(args: readonly string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("nsupdate", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.end(script);
  });
}

/**
 * Cambio del registro DNS durante la conmutación (D-05): se reapunta el nombre del servicio al sitio activo,
 * con un TTL corto (5 a 30 s) para que los clientes sigan el cambio rápido. Hay tres proveedores, elegidos por
 * la variable NEXO_DNS:
 *  - etcd: laboratorio. CoreDNS (plugin etcd) sirve el nombre; el agente escribe el registro en etcd por su API.
 *  - clouddns: Google Cloud DNS, por su API REST (si la zona vive en GCP).
 *  - rfc2136: DNS institucional (BIND, PowerDNS, Infoblox…) mediante la herramienta estándar `nsupdate`,
 *    con la clave TSIG que entregue SUBTEL. No se arma el protocolo a mano: se delega en nsupdate.
 */
export interface DnsTarget {
  name: string;
  ip: string;
  ttl: number;
}

export interface DnsProvider {
  readonly kind: string;
  update(t: DnsTarget): Promise<void>;
  /** Dirección que hoy publica el DNS para el nombre (lo que resuelven los clientes). */
  current(name: string): Promise<string | undefined>;
}

/** Resuelve el registro A consultando a un servidor DNS concreto (para confirmar el cambio). */
export async function resolveAgainst(name: string, server: string): Promise<string | undefined> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const [host, port] = server.split(":");
  resolver.setServers([port ? `${host}:${port}` : host!]);
  try {
    const ips = await resolver.resolve4(name.replace(/\.$/, ""));
    return ips[0];
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ laboratorio: CoreDNS + etcd

/**
 * CoreDNS con el plugin etcd lee cada registro de una clave JSON bajo un prefijo. Para A de "api.nexo.lab"
 * la clave es "<prefijo>/lab/nexo/api". El agente la escribe por la API v3 de etcd (gRPC-gateway, base64).
 */
export class EtcdDnsProvider implements DnsProvider {
  readonly kind = "etcd";

  constructor(
    private readonly etcdUrl: string,
    private readonly prefix = "/skydns",
    private readonly dnsServer = "coredns:53",
  ) {}

  private key(name: string): string {
    return `${this.prefix}/${name.replace(/\.$/, "").split(".").reverse().join("/")}`;
  }

  async update(t: DnsTarget): Promise<void> {
    const value = JSON.stringify({ host: t.ip, ttl: t.ttl });
    const res = await fetch(`${this.etcdUrl}/v3/kv/put`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: Buffer.from(this.key(t.name)).toString("base64"), value: Buffer.from(value).toString("base64") }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`etcd respondió ${res.status} al escribir el registro DNS`);
  }

  current(name: string): Promise<string | undefined> {
    return resolveAgainst(name, this.dnsServer);
  }
}

// ------------------------------------------------------------------ Google Cloud DNS (API REST)

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

async function gcpToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: key.client_email, scope: "https://www.googleapis.com/auth/ndev.clouddns.readwrite", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
  });
  if (!res.ok) throw new Error(`Google OAuth respondió ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export class CloudDnsProvider implements DnsProvider {
  readonly kind = "clouddns";

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly project: string,
    private readonly zone: string,
  ) {}

  private base() {
    return `https://dns.googleapis.com/dns/v1/projects/${this.project}/managedZones/${this.zone}`;
  }

  private async records(token: string, name: string) {
    const res = await fetch(`${this.base()}/rrsets?name=${encodeURIComponent(name)}&type=A`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Cloud DNS respondió ${res.status} al leer el registro`);
    return ((await res.json()) as { rrsets?: Array<{ name: string; type: string; ttl: number; rrdatas: string[] }> }).rrsets ?? [];
  }

  /** Un "change" reemplaza el registro de forma atómica (borra el anterior y agrega el nuevo). */
  async update(t: DnsTarget): Promise<void> {
    const token = await gcpToken(this.key);
    const name = t.name.endsWith(".") ? t.name : `${t.name}.`;
    const deletions = await this.records(token, name);
    const res = await fetch(`${this.base()}/changes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deletions, additions: [{ name, type: "A", ttl: t.ttl, rrdatas: [t.ip] }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Cloud DNS respondió ${res.status} al cambiar el registro: ${(await res.text()).slice(0, 200)}`);
  }

  async current(name: string): Promise<string | undefined> {
    const token = await gcpToken(this.key);
    const rr = await this.records(token, name.endsWith(".") ? name : `${name}.`);
    return rr[0]?.rrdatas[0];
  }
}

// ------------------------------------------------------------------ DNS institucional (RFC 2136 vía nsupdate)

/**
 * Reapunta el registro con la herramienta estándar `nsupdate`, a la que se le pasa la clave TSIG por archivo
 * (nunca por la línea de comandos). Así el cambio funciona con cualquier DNS que admita actualización dinámica
 * firmada (RFC 2136 + RFC 8945), sin reimplementar el protocolo.
 */
export class Rfc2136Provider implements DnsProvider {
  readonly kind = "rfc2136";

  constructor(
    private readonly server: string,
    private readonly zone: string,
    private readonly keyFile: string,
  ) {}

  async update(t: DnsTarget): Promise<void> {
    const [host, port] = this.server.split(":");
    const name = t.name.endsWith(".") ? t.name : `${t.name}.`;
    const script = [`server ${host} ${port ?? 53}`, `zone ${this.zone}`, `update delete ${name} A`, `update add ${name} ${t.ttl} A ${t.ip}`, "send", "answer", ""].join("\n");
    const out = await nsupdate(["-k", this.keyFile], script, 15_000);
    if (/NXDOMAIN|SERVFAIL|REFUSED|NOTAUTH/.test(out)) throw new Error(`nsupdate falló: ${out.split("\n").find((l) => /status:/.test(l)) ?? out.slice(0, 200)}`);
  }

  current(name: string): Promise<string | undefined> {
    return resolveAgainst(name, this.server);
  }
}

export function dnsProviderFromEnv(env: (k: string, d?: string) => string): DnsProvider {
  const kind = env("NEXO_DNS", "etcd");
  if (kind === "etcd") return new EtcdDnsProvider(env("NEXO_DNS_ETCD_URL", "http://etcd:2379"), env("NEXO_DNS_ETCD_PREFIX", "/skydns"), env("NEXO_DNS_SERVER", "coredns:53"));
  if (kind === "clouddns") {
    const raw = env("NEXO_DNS_GCP_SA_KEY");
    const key = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as ServiceAccountKey;
    return new CloudDnsProvider(key, env("NEXO_DNS_GCP_PROJECT"), env("NEXO_DNS_GCP_ZONE"));
  }
  if (kind === "rfc2136") return new Rfc2136Provider(env("NEXO_DNS_SERVER"), env("NEXO_DNS_ZONE"), env("NEXO_DNS_TSIG_KEYFILE"));
  throw new Error(`Proveedor de DNS desconocido: ${kind} (use etcd, clouddns o rfc2136)`);
}
