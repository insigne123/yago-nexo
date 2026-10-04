/**
 * Verificación de D-05 (conmutación automatizada CPD ↔ Google Cloud con quórum, sin intervención manual).
 * Laboratorio de dos sitios: PostgreSQL CPD (primario) y GCP (réplica por streaming), etcd para el quórum de
 * votos y CoreDNS para el nombre del sitio activo. Comprueba:
 *   1. estado sano: tres agentes votan, el CPD es el activo y publica su registro DNS;
 *   2. guarda contra split brain: con un solo agente viendo el primario caído NO se conmuta (sin quórum);
 *   3. conmutación automática: con quórum (2 de 3) el respaldo promueve la réplica, cambia el DNS y mide el
 *      RTO; un dato confirmado antes de la caída sigue presente tras la promoción (RPO acotado);
 *   4. retorno guiado con aprobación desde la Consola.
 * Requiere `make continuidad` (perfil cont) arriba.
 */
import { execFileSync } from "node:child_process";
import { fetch } from "undici";

const BASE = process.env.NEXO_CONSOLE_URL ?? "http://localhost:8090/api/v1";
const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://keycloak:8080/realms/nexo";
const PASSWORD = process.env.NEXO_LAB_USER_PASSWORD ?? "Nexo-Lab-2026!";
const CONT_DB_PASSWORD = process.env.CONT_DB_PASSWORD ?? "nexo-lab-cont";
const C = (name: string) => `nexo-lab-${name}-1`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function token(username: string) {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "nexo-console", username, password: PASSWORD }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

type Continuity = { activeSite: string; mode: string; votosPrimarioCaido: number; sites: Array<{ id: string; vote: string; active: boolean }> };
async function state(tok: string): Promise<Continuity> {
  return (await fetch(`${BASE}/continuity`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json())) as Continuity;
}

/** Registro DNS del sitio activo, leído de etcd (lo que CoreDNS sirve para activo.nexo.lab). */
function dnsRecord(): string | undefined {
  try {
    const out = execFileSync("docker", ["exec", C("cont-etcd"), "etcdctl", "get", "/skydns/lab/nexo/activo"], { encoding: "utf8" });
    return (JSON.parse(out.split("\n").slice(1).join("\n") || "{}") as { host?: string }).host;
  } catch {
    return undefined;
  }
}

/** Consulta puntual (un valor) a un sitio, por psql dentro del contenedor (sin exponer puertos). */
function query(site: "cont-cpd" | "cont-gcp", sql: string): string | undefined {
  try {
    const out = execFileSync("docker", ["exec", "-e", `PGPASSWORD=${CONT_DB_PASSWORD}`, C(site), "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], { encoding: "utf8", timeout: 6000 });
    return out.trim();
  } catch {
    return undefined;
  }
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutSec: number): Promise<{ value: T; sec: number } | undefined> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const value = await fn();
    if (pred(value)) return { value, sec: (Date.now() - t0) / 1000 };
    await sleep(1000);
  }
  return undefined;
}

const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "ignore" });

async function main() {
  const approver = await token("luis.aprobador");
  const rows: Array<Record<string, unknown>> = [];
  try {
    // 1) Estado sano.
    const healthy = await waitFor(() => state(approver), (s) => s.activeSite === "cpd" && s.sites.length === 3 && s.sites.every((x) => x.vote === "primario_sano"), 60);
    rows.push({
      prueba: "tres agentes sanos, CPD activo, DNS publicado",
      esperado: "3 sanos · activo cpd · dns 10.80.0.1",
      obtenido: healthy ? `${healthy.value.sites.length} sanos · activo ${healthy.value.activeSite} · dns ${dnsRecord()}` : "no se estabilizó",
      cumple: !!healthy && dnsRecord() === "10.80.0.1",
    });

    // Dato confirmado que debe sobrevivir a la conmutación (RPO).
    const marca = `marca-${Date.now()}`;
    query("cont-cpd", `INSERT INTO estado_plataforma (clave, valor) VALUES ('${marca}', 'ok')`);
    await sleep(2000); // se replica a GCP

    // 2) Guarda contra split brain: solo el agente GCP queda activo; ve el primario caído pero está solo.
    docker("stop", C("cont-agente-cpd"), C("cont-agente-testigo"));
    docker("stop", C("cont-cpd"));
    await sleep(18_000);
    const guard = await state(approver);
    const promotedTooEarly = query("cont-gcp", "SELECT NOT pg_is_in_recovery()") === "t";
    rows.push({
      prueba: "sin quórum no se conmuta (anti split-brain)",
      esperado: "activo sigue cpd · réplica no promovida",
      obtenido: `activo ${guard.activeSite} · réplica ${promotedTooEarly ? "promovida" : "en espera"}`,
      cumple: guard.activeSite === "cpd" && !promotedTooEarly,
    });

    // 3) Conmutación automática: vuelven los otros agentes; ahora 3 ven el primario caído → quórum.
    docker("start", C("cont-agente-cpd"), C("cont-agente-testigo"));
    const switched = await waitFor(() => state(approver), (s) => s.activeSite === "gcp", 90);
    const promoted = query("cont-gcp", "SELECT NOT pg_is_in_recovery()") === "t";
    const marcaPresente = query("cont-gcp", `SELECT count(*) FROM estado_plataforma WHERE clave = '${marca}'`) === "1";
    rows.push({
      prueba: "conmutación automática con quórum (2 de 3)",
      esperado: "activo gcp · réplica promovida · DNS 10.80.0.2",
      obtenido: switched ? `activo gcp en ${switched.sec.toFixed(0)} s · ${promoted ? "promovida" : "en recuperación"} · dns ${dnsRecord()}` : "no conmutó",
      cumple: !!switched && promoted && dnsRecord() === "10.80.0.2",
    });
    rows.push({ prueba: "el dato confirmado sobrevive (RPO acotado)", esperado: "presente en GCP", obtenido: marcaPresente ? "presente" : "ausente", cumple: marcaPresente });

    const ev = (await fetch(`${BASE}/continuity/events`, { headers: { authorization: `Bearer ${approver}` } }).then((r) => r.json())) as Array<{ kind: string; trigger: string; to: string; rtoSeconds?: number; status: string }>;
    const conm = ev.find((e) => e.kind === "conmutacion" && e.to === "gcp");
    rows.push({
      prueba: "evento de conmutación con RTO medido y auditado",
      esperado: "automatico · completado · RTO > 0",
      obtenido: conm ? `${conm.trigger} · ${conm.status} · RTO ${conm.rtoSeconds?.toFixed?.(1)} s` : "sin evento",
      cumple: !!conm && conm.trigger === "automatico" && conm.status === "completado" && (conm.rtoSeconds ?? 0) > 0,
    });

    // 4) Retorno guiado con aprobación (desde la Consola). Se repone el primario antes del retorno.
    docker("start", C("cont-cpd"));
    await sleep(5000);
    const fb = await fetch(`${BASE}/continuity/failback`, { method: "POST", headers: { authorization: `Bearer ${approver}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "Verificación D-05: primario restablecido" }) });
    const back = await waitFor(() => state(approver), (s) => s.activeSite === "cpd", 60);
    rows.push({
      prueba: "retorno guiado con aprobación",
      esperado: "activo vuelve a cpd · DNS 10.80.0.1",
      obtenido: `${fb.status} · activo ${back?.value.activeSite ?? "?"} · dns ${dnsRecord()}`,
      cumple: fb.status === 202 && !!back && dnsRecord() === "10.80.0.1",
    });
  } finally {
    for (const c of ["cont-cpd", "cont-agente-cpd", "cont-agente-gcp", "cont-agente-testigo"]) {
      try {
        docker("start", C(c));
      } catch {
        /* ya arriba */
      }
    }
  }
  console.table(rows);
  const ok = rows.every((r) => r.cumple);
  console.log(ok ? "[D-05] verificado: quórum, conmutación automática con RTO/RPO medidos y retorno guiado" : "[D-05] NO cumple");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[D-05] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
