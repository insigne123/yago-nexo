/**
 * D-05 · Conmutación automatizada entre el sitio principal (CPD) y el de respaldo (Google Cloud), sin
 * intervención manual. Laboratorio de dos sitios en Docker Compose: PostgreSQL CPD (primario) y GCP (réplica
 * por streaming), etcd para los votos, CoreDNS para el nombre del sitio activo y tres agentes (CPD, GCP y
 * testigo). Mismo escenario y mismas comprobaciones que tools/lab-bootstrap/src/check-d05.ts, narrado paso a paso.
 */
import { execFileSync } from "node:child_process";
import type { Demo } from "../lib/grabador.js";
import { consola, contenedor, docker, tokenPersona } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";

type Estado = { activeSite: string; mode: string; votosPrimarioCaido: number; sites: Array<{ id: string; vote: string; active: boolean }> };
type Evento = { id: string; kind: string; trigger: string; to: string; rtoSeconds?: number; rpoSecondsEstimated?: number; status: string; startedAt: string };

const CLAVE_CONT = () => process.env.CONT_DB_PASSWORD ?? "nexo-lab-cont";

function dns(): string | undefined {
  try {
    const out = execFileSync("docker", ["exec", contenedor("cont-etcd"), "etcdctl", "get", "/skydns/lab/nexo/activo"], { encoding: "utf8" });
    return (JSON.parse(out.split("\n").slice(1).join("\n") || "{}") as { host?: string }).host;
  } catch {
    return undefined;
  }
}

function sql(sitio: "cont-cpd" | "cont-gcp", q: string): string | undefined {
  try {
    return execFileSync("docker", ["exec", "-e", `PGPASSWORD=${CLAVE_CONT()}`, contenedor(sitio), "psql", "-U", "postgres", "-d", "postgres", "-tAc", q], { encoding: "utf8", timeout: 6000 }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Reconstruye la réplica del sitio de respaldo desde el primario (lo que el retorno deja «pendiente»): borra
 * los datos de la réplica promovida, renueva la ranura de replicación en el CPD y deja que el entrypoint del
 * contenedor GCP vuelva a clonar el primario con pg_basebackup. Devuelve los segundos que tomó.
 */
async function resincronizarReplica(log?: (l: string, tipo?: "cmd" | "tenue" | "ok") => void): Promise<number> {
  const t0 = Date.now();
  log?.("$ docker stop cont-gcp && borrar los datos de la réplica promovida", "cmd");
  docker("stop", contenedor("cont-gcp"));
  docker("run", "--rm", "-v", "nexo-lab_contgcp:/var/lib/postgresql/data", "alpine:3.20", "sh", "-c", "rm -rf /var/lib/postgresql/data/pgdata");
  log?.("$ renovar la ranura gcp_slot en el CPD y docker start cont-gcp   # pg_basebackup -R desde el primario", "cmd");
  sql("cont-cpd", "SELECT pg_drop_replication_slot('gcp_slot') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'gcp_slot' AND NOT active)");
  sql("cont-cpd", "SELECT pg_create_physical_replication_slot('gcp_slot') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'gcp_slot')");
  docker("start", contenedor("cont-gcp"));
  const lista = await esperarHasta(async () => sql("cont-gcp", "SELECT pg_is_in_recovery()"), (v) => v === "t", 90, 1000);
  if (!lista) throw new Error("la réplica GCP no volvió a quedar en espera");
  return (Date.now() - t0) / 1000;
}

const AGENTES = ["cont-agente-cpd", "cont-agente-gcp", "cont-agente-testigo"].map(contenedor);
const TODOS = ["cont-cpd", "cont-gcp", "cont-etcd", "cont-coredns"].map(contenedor).concat(AGENTES);

export const d05: Demo = {
  id: "D-05",
  archivo: "D-05_conmutacion",
  nombre: "Conmutación automática CPD ↔ Google Cloud sin intervención manual",
  afirmacion:
    "Cuando el sitio principal cae, los agentes de continuidad conmutan solos al sitio de respaldo si 2 de 3 votos coinciden: promueven la réplica, reapuntan el DNS y registran el RTO; sin quórum no conmutan (evita dos sitios activos) y el retorno lo aprueba una persona.",
  pasos: 5,
  usuarioInicial: "luis.aprobador",

  async preparar() {
    for (const c of TODOS) {
      try {
        docker("start", c);
      } catch {
        /* ya arriba */
      }
    }
    const apr = await tokenPersona("luis.aprobador");
    const sano = await esperarHasta(
      async () => (await consola<Estado>(apr, "GET", "/continuity")).data,
      (s) => s.activeSite === "cpd" && s.sites.length === 3 && s.sites.every((x) => x.vote === "primario_sano") && s.mode === "automatico",
      90,
      2000,
    );
    if (!sano) throw new Error("el laboratorio de continuidad no está sano (make continuidad)");
    const notas = ["laboratorio de continuidad (perfil cont) arriba: dos sitios simulados en contenedores, etcd, CoreDNS y tres agentes"];
    if (sql("cont-gcp", "SELECT pg_is_in_recovery()") !== "t") {
      const seg = await resincronizarReplica();
      notas.push(`réplica GCP reconstruida desde el CPD (quedó promovida en una prueba anterior): en espera en ${seg.toFixed(0)} s`);
    }
    return notas;
  },

  async ejecutar(c) {
    const apr = await tokenPersona("luis.aprobador");
    const estado = async () => (await consola<Estado>(apr, "GET", "/continuity")).data;

    c.paso("Estado sano: tres agentes votan «primario sano»; el CPD atiende y el DNS apunta a él");
    await c.ir("/continuidad");
    await c.app.getByTestId("active-site").waitFor();
    c.log("Laboratorio: los dos sitios son contenedores de esta máquina; en producción el respaldo corre en Google Cloud.", "tenue");
    const e0 = await estado();
    c.log(`votos: ${e0.sites.map((s) => `${s.id}=${s.vote}`).join(" · ")} · modo ${e0.mode}`);
    c.log(`$ dig activo.nexo.lab → ${dns()}   (CoreDNS, registro en etcd)`, "cmd");
    c.log(`CPD en lectura/escritura: ${sql("cont-cpd", "SELECT NOT pg_is_in_recovery()") === "t" ? "sí" : "no"} · GCP réplica en espera: ${sql("cont-gcp", "SELECT pg_is_in_recovery()") === "t" ? "sí" : "no"}`);
    c.exigir("CPD activo con tres votos sanos y DNS en 10.80.0.1", e0.activeSite === "cpd" && dns() === "10.80.0.1");
    const marca = `marca-${Date.now()}`;
    sql("cont-cpd", `INSERT INTO estado_plataforma (clave, valor) VALUES ('${marca}', 'confirmado antes de la caída')`);
    c.log(`$ INSERT INTO estado_plataforma … '${marca}'   # dato confirmado en el CPD`, "cmd");
    await c.esperar(3000);
    c.log(`réplica GCP ya lo tiene: ${sql("cont-gcp", `SELECT count(*) FROM estado_plataforma WHERE clave = '${marca}'`) === "1" ? "sí" : "no"}`, "tenue");

    c.paso("Sin quórum no se conmuta: cae el CPD y solo el agente de Google Cloud lo ve caído");
    c.log("$ docker stop cont-agente-cpd cont-agente-testigo   # dos agentes sin comunicación", "cmd");
    docker("stop", contenedor("cont-agente-cpd"), contenedor("cont-agente-testigo"));
    c.log("$ docker stop cont-cpd   # cae la base de datos del sitio principal", "cmd");
    docker("stop", contenedor("cont-cpd"));
    for (let i = 0; i < 6; i++) {
      await c.esperar(3000);
      const s = await estado();
      c.log(`t=${(i + 1) * 3}s · activo ${s.activeSite} · votos «primario caído»: ${s.votosPrimarioCaido} de 3 (se necesitan 2)`, "aviso");
    }
    const sinQuorum = await estado();
    const promovidaAntes = sql("cont-gcp", "SELECT NOT pg_is_in_recovery()") === "t";
    c.verificar("sin quórum no hay conmutación (anti split brain)", sinQuorum.activeSite === "cpd" && !promovidaAntes, `activo ${sinQuorum.activeSite} · réplica ${promovidaAntes ? "promovida" : "en espera"}`);

    c.paso("Vuelven los otros agentes: con 2 de 3 votos la conmutación es automática");
    c.log("$ docker start cont-agente-cpd cont-agente-testigo", "cmd");
    const t0 = Date.now();
    docker("start", contenedor("cont-agente-cpd"), contenedor("cont-agente-testigo"));
    let ultimo = "";
    const cambio = await esperarHasta(
      async () => {
        const s = await estado();
        if (`${s.votosPrimarioCaido}|${s.activeSite}` !== ultimo) {
          ultimo = `${s.votosPrimarioCaido}|${s.activeSite}`;
          c.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s · votos «primario caído»: ${s.votosPrimarioCaido} de 3 · activo ${s.activeSite}`, s.activeSite === "gcp" ? "ok" : "aviso");
        }
        return s;
      },
      (s) => s.activeSite === "gcp",
      90,
      500,
    );
    const segConmutacion = (Date.now() - t0) / 1000;
    await c.esperar(2500);
    const promovida = sql("cont-gcp", "SELECT NOT pg_is_in_recovery()") === "t";
    const marcaPresente = sql("cont-gcp", `SELECT count(*) FROM estado_plataforma WHERE clave = '${marca}'`) === "1";
    c.log(`$ dig activo.nexo.lab → ${dns()}`, "cmd");
    c.verificar("conmutación automática a GCP con quórum", !!cambio && promovida && dns() === "10.80.0.2", `${segConmutacion.toFixed(1)} s desde que volvieron los agentes · réplica promovida · DNS 10.80.0.2`);
    c.verificar("el dato confirmado sigue en el respaldo (sin pérdida)", marcaPresente, marca);
    const ev = (await consola<Evento[]>(apr, "GET", "/continuity/events")).data.find((e) => e.kind === "conmutacion" && e.to === "gcp" && Date.parse(e.startedAt) >= t0 - 60_000);
    c.verificar("evento automático con RTO medido", !!ev && ev.trigger === "automatico" && ev.status === "completado" && (ev.rtoSeconds ?? 0) > 0, ev ? `RTO del motor ${ev.rtoSeconds?.toFixed(2)} s · RPO estimado ${ev.rpoSecondsEstimated ?? 0} s` : "sin evento");
    await c.app.mouse.move(600, 420);
    await c.app.mouse.wheel(0, 420);
    await c.esperar(4500);
    await c.app.mouse.wheel(0, -420);

    c.paso("Retorno guiado: se repone el CPD y un aprobador aprueba la vuelta");
    c.log("$ docker start cont-cpd   # el sitio principal vuelve", "cmd");
    docker("start", contenedor("cont-cpd"));
    await c.esperar(5000);
    const tR = Date.now();
    await c.clic(c.app.getByTestId("btn-approve-failback"));
    const dlg = c.app.getByTestId("failback-dialog-reason");
    if (await dlg.isVisible({ timeout: 3000 }).catch(() => false)) {
      await c.escribir(dlg, "Sitio principal restablecido y verificado", 12);
      await c.clic(c.app.getByTestId("failback-dialog-confirm"));
    }
    const vuelta = await esperarHasta(estado, (s) => s.activeSite === "cpd", 60, 1000);
    const segRetorno = (Date.now() - tR) / 1000;
    c.log(`$ dig activo.nexo.lab → ${dns()}`, "cmd");
    c.verificar("retorno al CPD aprobado por una persona", !!vuelta && dns() === "10.80.0.1", `${segRetorno.toFixed(0)} s · DNS 10.80.0.1`);
    await c.esperar(3500);

    c.paso("La Consola deja pendiente re-sincronizar la réplica; se reconstruye desde el CPD");
    const segResync = await resincronizarReplica((l, t) => c.log(l, t));
    const enEspera = sql("cont-gcp", "SELECT pg_is_in_recovery()") === "t";
    c.log(`GCP réplica en espera: ${enEspera ? "sí" : "no"} · recibe los cambios del CPD`, enEspera ? "ok" : "mal");
    c.verificar("réplica del respaldo reconstruida y en espera", enEspera, `${segResync.toFixed(0)} s`);
    await c.app.reload();
    await c.esperar(3000);

    return {
      medido: `conmutación automática ${segConmutacion.toFixed(1).replace(".", ",")} s después de formarse el quórum (2 de 3 votos), sin pérdida del dato confirmado; con un solo voto no conmutó en 18 s`,
      datos: { segundosConmutacion: Math.round(segConmutacion * 10) / 10, rtoMotorSeg: ev?.rtoSeconds, rpoEstimadoSeg: ev?.rpoSecondsEstimated, segundosRetorno: Math.round(segRetorno) },
    };
  },

  async limpiar() {
    for (const c of TODOS) {
      try {
        docker("start", c);
      } catch {
        /* ya arriba */
      }
    }
  },
};
