/**
 * D-05 · Conmutación automatizada entre el sitio principal (CPD) y el de respaldo (Google Cloud), sin
 * intervención manual, en 3 actos (V13):
 *   1. partición: el agente de Google Cloud deja de ver el CPD (que sigue atendiendo); con 1 de 3 votos
 *      «primario caído» no se conmuta;
 *   2. cae la base del CPD: los agentes forman mayoría (2 de 3) y conmutan solos (réplica promovida, DNS);
 *   3. el RTO se mide desde la falla (desde que se detuvo la base del CPD hasta que el respaldo quedó activo).
 * Después, el retorno al CPD lo solicita una persona (carla.operacion) y lo aprueba otra (luis.aprobador), cada
 * una con su propia sesión de Keycloak, y se mide su duración.
 *
 * Laboratorio de dos sitios en Docker Compose (perfil cont): PostgreSQL CPD (primario) y GCP (réplica por
 * streaming), etcd para los votos, CoreDNS para el nombre del sitio activo y tres agentes (CPD, GCP y testigo).
 * Cada comando que se ve en la terminal es el que se ejecuta. preparar() comprueba el modo automático en la
 * Consola (GET /continuity; lo fija la instalación). Duración estimada: ≈ 145 s (ver ayudas-d.test.ts).
 *
 * La partición se hace dentro del contenedor del agente de Google Cloud: su /etc/hosts apunta cont-cpd a
 * 192.0.2.1 (dirección de documentación, no enrutable), así sus sondas al CPD no llegan mientras el CPD y los
 * otros dos agentes siguen sanos. Con NEXO_D05_PARTICION=agentes se usa la variante probada antes (se detienen
 * los otros dos agentes y luego el CPD), por si el laboratorio no permitiera editar /etc/hosts.
 */
import type { Page } from "playwright-core";
import { fetch } from "undici";
import type { Contexto, Demo } from "../lib/grabador.js";
import { consola, contenedor, ENSAYO, tokenPersona } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";
import {
  abrir,
  agendaDe,
  ampliar,
  aparece,
  comando,
  desplazarSiHay,
  seg,
  type PasoGuion,
} from "./ayudas-d.js";
import { nuevaSesionD, prepararEnsayoD } from "./d0x-ensayo.js";

type Sitio = { id: string; vote: string; active: boolean };
type Estado = {
  activeSite: string;
  mode: string;
  votosPrimarioCaido: number;
  rtoObjetivoMin?: number;
  sites: Sitio[];
  pendingFailback?: { id: string; requestedBy: string };
};
type Evento = {
  id: string;
  kind: string;
  trigger: string;
  to: string;
  rtoSeconds?: number;
  rpoSecondsEstimated?: number;
  status: string;
  startedAt: string;
  requestedBy?: string;
  approvedBy?: string;
};
type Solicitud = { id: string; status: string; requestedBy?: string };

const CPD = contenedor("cont-cpd");
const GCP = contenedor("cont-gcp");
const ETCD = contenedor("cont-etcd");
const AGENTE_GCP = contenedor("cont-agente-gcp");
const AGENTES = ["cont-agente-cpd", "cont-agente-gcp", "cont-agente-testigo"].map(contenedor);
const TODOS = ["cont-cpd", "cont-gcp", "cont-etcd", "cont-coredns"].map(contenedor).concat(AGENTES);
const IP_CPD = "10.80.0.1";
const IP_GCP = "10.80.0.2";
const BLACKHOLE = "192.0.2.1";
const VARIANTE = process.env.NEXO_D05_PARTICION === "agentes" ? "agentes" : "hosts";
const MOTIVO_SOLICITUD = "CPD restablecido y verificado; volver al sitio principal";

const PASOS_PARTICION_HOSTS: PasoGuion[] = [
  {
    titulo: "Estado sano: tres agentes votan y el CPD atiende",
    quePasa:
      "Agentes en el CPD, en Google Cloud y en un sitio testigo revisan cada 3 s si la base principal responde, y votan. Los tres dicen «primario sano».",
    porQueImporta: "La conmutación la decide una mayoría de agentes independientes, no un único vigilante.",
    comprueba: [
      "3 de 3 votos «primario sano» · modo automático",
      "el DNS apunta al CPD (10.80.0.1)",
      "dato de control escrito en el CPD y replicado",
    ],
    estimadoS: 12,
  },
  {
    titulo: "Acto 1 · Partición: un solo agente ve caído el CPD",
    quePasa:
      "Se corta la red entre el agente de Google Cloud y el CPD, que sigue atendiendo. Ese agente vota «primario caído»; los otros dos lo ven sano.",
    porQueImporta:
      "Con 1 de 3 votos no se conmuta: una falla de red no puede dejar los dos sitios activos a la vez.",
    comprueba: [
      "1 de 3 votos «primario caído»",
      "el CPD sigue activo 20 s después",
      "la réplica de Google Cloud no se promueve",
    ],
    estimadoS: 38,
  },
  {
    titulo: "Acto 2 · Cae el CPD y se conmuta solo",
    quePasa:
      "Se detiene la base del CPD. Con al menos 2 de 3 votos «primario caído», el agente de Google Cloud promueve su réplica y reapunta el DNS.",
    porQueImporta: "Ante una caída real el servicio pasa al respaldo sin esperar a que alguien reaccione.",
    comprueba: [
      "conmutación automática a Google Cloud",
      "el DNS apunta al respaldo (10.80.0.2)",
      "el dato de control sigue en el respaldo",
    ],
    estimadoS: 18,
  },
  {
    titulo: "Acto 3 · RTO medido desde la falla",
    quePasa:
      "Se cuenta desde que se detuvo la base del CPD hasta ver el respaldo activo. La Consola registra además cuánto tardó la conmutación misma.",
    porQueImporta:
      "El RTO es lo que vive quien usa el servicio: se cuenta desde la falla, no desde que alguien la notó.",
    comprueba: [
      "RTO desde la falla dentro del objetivo",
      "evento automático con el RTO del motor",
      "conmutación registrada en la auditoría",
    ],
    estimadoS: 12,
  },
  {
    titulo: "Retorno al CPD: lo pide una persona y lo aprueba otra",
    quePasa:
      "Repuesto el CPD, la operadora pide el retorno con un motivo. El aprobador entra con su propia sesión y lo aprueba; el DNS vuelve al CPD.",
    porQueImporta:
      "Volver al sitio principal lo revisan dos personas distintas, y queda medido cuánto tarda.",
    comprueba: [
      "quien solicita no puede aprobar (HTTP 403)",
      "retorno aprobado por otra persona",
      "CPD activo de nuevo y DNS en 10.80.0.1",
    ],
    estimadoS: 45,
  },
];

/**
 * Variante de respaldo (NEXO_D05_PARTICION=agentes): en el acto 1 se detienen los agentes del CPD y del testigo y
 * cae la base del CPD, así que la narración de los actos 1 a 3 cuenta eso (y que el RTO incluye ese tramo).
 * Las verificaciones declaradas son las mismas (las mide el mismo código).
 */
export const PASOS_D05_AGENTES: PasoGuion[] = PASOS_PARTICION_HOSTS.map((p, i) => {
  if (i === 1)
    return {
      ...p,
      titulo: "Acto 1 · Aislamiento: un solo agente ve caído el CPD",
      quePasa:
        "Se detienen los agentes del CPD y del testigo, y cae la base del CPD. Solo el agente de Google Cloud vota «primario caído».",
      porQueImporta:
        "Con 1 de 3 votos no se conmuta: un agente aislado no puede dejar los dos sitios activos a la vez.",
    };
  if (i === 2)
    return {
      ...p,
      quePasa:
        "Vuelven los otros dos agentes y también ven caída la base del CPD. Con 2 de 3 votos, Google Cloud promueve su réplica y reapunta el DNS.",
    };
  if (i === 3)
    return {
      ...p,
      quePasa:
        "Se cuenta desde que cayó la base del CPD, al empezar el acto 1, hasta ver el respaldo activo. La Consola registra además la conmutación misma.",
    };
  return p;
});

export const PASOS_D05: PasoGuion[] = VARIANTE === "agentes" ? PASOS_D05_AGENTES : PASOS_PARTICION_HOSTS;

// ── Laboratorio de continuidad (comandos reales; en ensayo, el simulador de d0x-ensayo.ts) ──────────

/** Operación simulada en ensayo (el servidor de ensayo lleva el estado de los dos sitios). */
async function ensayoLab(op: string): Promise<string> {
  const r = await fetch(`${ENSAYO}/d0x/continuidad/lab`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op }),
  });
  return ((await r.json()) as { salida?: string }).salida ?? "";
}

/** Ejecuta una línea de shell del laboratorio (se muestra tal cual, salvo `silencioso`) y devuelve su salida. */
async function lab(
  c: Contexto | undefined,
  linea: string,
  op: string,
  o: { mostrar?: boolean; env?: Record<string, string> } = {},
): Promise<string> {
  if (ENSAYO) {
    // En ensayo la línea se muestra con la nota «no se ejecuta» y el simulador entrega su resultado.
    if (c && o.mostrar !== false) await comando(c, linea, { soloLaboratorio: true, silencioso: true });
    return ensayoLab(op);
  }
  if (!c || o.mostrar === false) {
    const { execFileSync } = await import("node:child_process");
    try {
      return execFileSync("sh", ["-c", linea], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, ...o.env },
      }).trim();
    } catch {
      return "";
    }
  }
  const r = await comando(c, linea, { env: o.env ?? {}, silencioso: true });
  return r.salida.join("\n").trim();
}

const PG = { PGPASSWORD: process.env.CONT_DB_PASSWORD ?? "nexo-lab-cont" };
const sql = (c: Contexto | undefined, sitio: string, q: string, op: string, mostrar = true) =>
  lab(c, `docker exec -e PGPASSWORD ${sitio} psql -U postgres -d postgres -tAc "${q}"`, op, {
    mostrar,
    env: PG,
  });

/** Registro DNS del sitio activo, leído de etcd (es lo que CoreDNS sirve para activo.nexo.lab). */
async function dns(c?: Contexto): Promise<string | undefined> {
  const out = await lab(c, `docker exec ${ETCD} etcdctl get /skydns/lab/nexo/activo`, "dns", {
    mostrar: !!c,
  });
  try {
    const host = (JSON.parse(out.split("\n").slice(1).join("\n") || "{}") as { host?: string }).host;
    if (c)
      c.log(
        `  activo.nexo.lab → ${host ?? "sin registro"}   (registro que sirve CoreDNS)`,
        host ? "ok" : "mal",
      );
    return host;
  } catch {
    return undefined;
  }
}

const PARTIR = `docker exec -u 0 ${AGENTE_GCP} sh -c "echo '${BLACKHOLE} cont-cpd' >> /etc/hosts"`;
const CURAR = `docker exec -u 0 ${AGENTE_GCP} sh -c "grep -v ' cont-cpd$' /etc/hosts > /tmp/hosts.nexo; cat /tmp/hosts.nexo > /etc/hosts"`;

/**
 * Reconstruye la réplica del sitio de respaldo desde el primario (lo que el retorno deja «pendiente»): borra
 * los datos de la réplica promovida, renueva la ranura de replicación en el CPD y deja que el entrypoint del
 * contenedor GCP vuelva a clonar el primario con pg_basebackup. Devuelve los segundos que tomó.
 */
async function resincronizarReplica(): Promise<number> {
  const t0 = Date.now();
  await lab(undefined, `docker stop ${GCP}`, "resync");
  await lab(
    undefined,
    `docker run --rm -v nexo-lab_contgcp:/var/lib/postgresql/data alpine:3.20 sh -c "rm -rf /var/lib/postgresql/data/pgdata"`,
    "resync",
  );
  await sql(
    undefined,
    CPD,
    "SELECT pg_drop_replication_slot('gcp_slot') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'gcp_slot' AND NOT active)",
    "resync",
    false,
  );
  await sql(
    undefined,
    CPD,
    "SELECT pg_create_physical_replication_slot('gcp_slot') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'gcp_slot')",
    "resync",
    false,
  );
  await lab(undefined, `docker start ${GCP}`, "resync");
  const lista = await esperarHasta(
    async () => sql(undefined, GCP, "SELECT pg_is_in_recovery()", "gcp-en-espera", false),
    (v) => v === "t",
    90,
    1000,
  );
  if (!lista) throw new Error("la réplica GCP no volvió a quedar en espera");
  return (Date.now() - t0) / 1000;
}

async function arrancarTodo() {
  for (const k of TODOS) await lab(undefined, `docker start ${k}`, "arrancar", { mostrar: false });
  await lab(undefined, CURAR, "curar", { mostrar: false });
}

const votos = (s: Estado, voto: string) => s.sites.filter((x) => x.vote === voto).length;
const describirVotos = (s: Estado) =>
  s.sites
    .map(
      (x) =>
        `${x.id.toUpperCase()}: ${x.vote === "primario_caido" ? "caído" : x.vote === "primario_sano" ? "sano" : x.vote}`,
    )
    .join(" · ");

export const d05: Demo = {
  id: "D-05",
  archivo: "D-05_conmutacion",
  nombre: "Conmutación automática CPD ↔ Google Cloud sin intervención manual",
  afirmacion:
    "Los agentes de continuidad conmutan solos al sitio de respaldo cuando al menos 2 de 3 votos ven caído el sitio principal: promueven la réplica, reapuntan el DNS y registran el RTO, medido desde la falla. Con 1 de 3 votos (una partición) no conmutan, y el retorno lo pide una persona y lo aprueba otra.",
  pasos: PASOS_D05.length,
  agenda: agendaDe(PASOS_D05),
  usuarioInicial: "carla.operacion",

  async preparar(c) {
    await prepararEnsayoD(c);
    await arrancarTodo();
    const notas = [
      "laboratorio de continuidad (perfil cont) arriba: dos sitios en contenedores, etcd, CoreDNS y tres agentes",
    ];
    // Desde la 1.2.0 el modo de conmutación lo fija la instalación (NEXO_CONTINUITY_AUTOMATICO) y la Consola solo lo
    // muestra: se comprueba que esté en «automático» antes de grabar.
    const adm = await tokenPersona("admin.nexo");
    const m = await consola<Estado>(adm, "GET", "/continuity");
    if (m.status >= 300 || m.data.mode !== "automatico")
      throw new Error(
        `el modo de conmutación de la instalación no es «automático»: HTTP ${m.status} · ${m.data?.mode}`,
      );
    notas.push(
      "modo de conmutación «automático», fijado por la instalación y leído en la Consola (GET /continuity)",
    );
    const apr = await tokenPersona("luis.aprobador");
    // Solicitudes de retorno pendientes de corridas anteriores se rechazan (quedan en la auditoría).
    const previas = (await consola<Solicitud[]>(apr, "GET", "/continuity/failback/requests")).data;
    for (const p of Array.isArray(previas) ? previas : [])
      if (p.status === "pendiente")
        await consola(apr, "POST", `/continuity/failback/requests/${p.id}/reject`, {
          reason: "Retirada antes de grabar D-05",
        });
    if ((await sql(undefined, GCP, "SELECT pg_is_in_recovery()", "gcp-en-espera", false)) !== "t") {
      const s = await resincronizarReplica();
      notas.push(
        `réplica GCP reconstruida desde el CPD (quedó promovida en una prueba anterior): en espera en ${s.toFixed(0)} s`,
      );
    }
    const sano = await esperarHasta(
      async () => (await consola<Estado>(apr, "GET", "/continuity")).data,
      (s) =>
        s.activeSite === "cpd" &&
        s.sites.length === 3 &&
        s.sites.every((x) => x.vote === "primario_sano") &&
        s.mode === "automatico",
      90,
      2000,
    );
    if (!sano) throw new Error("el laboratorio de continuidad no está sano (make continuidad)");
    if (VARIANTE === "agentes")
      notas.push("partición del acto 1 en la variante «agentes» (NEXO_D05_PARTICION=agentes)");
    return notas;
  },

  async ejecutar(c) {
    const e = c.estudio;
    const apr = await tokenPersona("luis.aprobador");
    const operadora = await tokenPersona("carla.operacion");
    const estado = async () => (await consola<Estado>(apr, "GET", "/continuity")).data;
    const indicadores = (s: Estado, extra: Record<string, string> = {}) =>
      e.indicadores({
        "sitio activo": s.activeSite.toUpperCase(),
        "votos «primario caído»": `${s.votosPrimarioCaido} de ${s.sites.length}`,
        modo: s.mode === "automatico" ? "automático" : s.mode,
        ...extra,
      });

    // ── 1. Estado sano ─────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D05[0]!);
    await c.ir("/continuidad");
    await aparece(c.app.getByTestId("active-site"), 20_000);
    c.log(
      "Laboratorio: los dos sitios son contenedores de esta máquina; en producción el respaldo corre en Google Cloud.",
      "tenue",
    );
    const e0 = await estado();
    indicadores(e0);
    c.log(`votos: ${describirVotos(e0)} · modo ${e0.mode}`);
    e.exige(
      "3 de 3 votos «primario sano» · modo automático",
      e0.activeSite === "cpd" && votos(e0, "primario_sano") === 3 && e0.mode === "automatico",
      `${votos(e0, "primario_sano")} de ${e0.sites.length} sanos · ${e0.mode}`,
    );
    const d0 = await dns(c);
    e.comprueba("el DNS apunta al CPD (10.80.0.1)", d0 === IP_CPD, d0 ?? "sin registro");
    const marca = `marca-${Date.now()}`;
    await sql(
      c,
      CPD,
      `INSERT INTO estado_plataforma (clave, valor) VALUES ('${marca}', 'confirmado antes de la caída')`,
      `cpd-escribe:${marca}`,
    );
    await c.esperar(2500);
    const replicada = await sql(
      c,
      GCP,
      `SELECT count(*) FROM estado_plataforma WHERE clave = '${marca}'`,
      `gcp-tiene:${marca}`,
    );
    e.comprueba(
      "dato de control escrito en el CPD y replicado",
      replicada === "1",
      replicada === "1" ? `${marca} ya está en Google Cloud` : "no llegó a la réplica",
    );

    // ── 2. Acto 1: partición, 1 de 3 votos, no se conmuta ───────────────────────────────────────────
    await abrir(c, PASOS_D05[1]!);
    if (VARIANTE === "hosts") {
      c.log(
        "# el agente de Google Cloud deja de alcanzar al CPD (el CPD sigue atendiendo a los demás)",
        "tenue",
      );
      await lab(c, PARTIR, "particion");
    } else {
      c.log("# el respaldo queda aislado: se detienen los otros dos agentes y cae la base del CPD", "tenue");
      await lab(
        c,
        `docker stop ${contenedor("cont-agente-cpd")} ${contenedor("cont-agente-testigo")}`,
        "aislar-agentes",
      );
      await lab(c, `docker stop ${CPD}`, "cpd-stop");
    }
    const tParticion = Date.now();
    const unVoto = await esperarHasta(
      estado,
      (s) => s.sites.find((x) => x.id === "gcp")?.vote === "primario_caido",
      30,
      1000,
    );
    c.log(
      `t=${seg((Date.now() - tParticion) / 1000)} · el agente de Google Cloud vota «primario caído»`,
      "aviso",
    );
    let peor = unVoto?.valor ?? (await estado());
    for (let t = 4; t <= 20; t += 4) {
      await c.esperar(4000);
      const s = await estado();
      if (s.activeSite !== "cpd" || s.votosPrimarioCaido > peor.votosPrimarioCaido) peor = s;
      indicadores(s);
      c.log(
        `+${t} s · votos: ${describirVotos(s)} · «primario caído» ${s.votosPrimarioCaido} de ${s.sites.length} (se necesitan 2) · activo ${s.activeSite.toUpperCase()}`,
        "aviso",
      );
      if (t === 8) await ampliar(c, c.app.getByTestId("quorum"), 2400);
    }
    const sinQuorum = await estado();
    const caidosVistos = Math.max(peor.votosPrimarioCaido, sinQuorum.votosPrimarioCaido);
    e.comprueba(
      "1 de 3 votos «primario caído»",
      !!unVoto && caidosVistos === 1,
      `${caidosVistos} de ${sinQuorum.sites.length} votos «primario caído» (máximo visto)`,
    );
    e.comprueba(
      "el CPD sigue activo 20 s después",
      sinQuorum.activeSite === "cpd" && peor.activeSite === "cpd",
      `activo ${sinQuorum.activeSite.toUpperCase()} tras ${seg((Date.now() - tParticion) / 1000, 0)} de partición`,
    );
    const enEspera = await sql(c, GCP, "SELECT pg_is_in_recovery()", "gcp-en-espera");
    e.comprueba(
      "la réplica de Google Cloud no se promueve",
      enEspera === "t",
      enEspera === "t" ? "sigue en espera (pg_is_in_recovery = t)" : `pg_is_in_recovery = ${enEspera || "?"}`,
    );
    let tFalla: number;
    if (VARIANTE === "hosts") {
      c.log("# se repara la red del agente de Google Cloud", "tenue");
      await lab(c, CURAR, "curar");
      await esperarHasta(estado, (s) => s.sites.every((x) => x.vote === "primario_sano"), 30, 1000);
      // ── 3. Acto 2: cae el CPD ────────────────────────────────────────────────────────────────────
      await abrir(c, PASOS_D05[2]!);
      c.log("# cae la base de datos del sitio principal: desde aquí se mide el RTO", "tenue");
      tFalla = Date.now();
      await lab(c, `docker stop ${CPD}`, "cpd-stop");
    } else {
      await abrir(c, PASOS_D05[2]!);
      c.log("# vuelven los otros dos agentes: también ven la base del CPD caída", "tenue");
      tFalla = tParticion; // en esta variante el CPD cayó al empezar el acto 1
      await lab(
        c,
        `docker start ${contenedor("cont-agente-cpd")} ${contenedor("cont-agente-testigo")}`,
        "volver-agentes",
      );
    }
    let ultimo = "";
    let votosAlConmutar = 0;
    const cambio = await esperarHasta(
      async () => {
        const s = await estado();
        if (s.activeSite === "cpd") votosAlConmutar = Math.max(votosAlConmutar, s.votosPrimarioCaido);
        const clave = `${s.votosPrimarioCaido}|${s.activeSite}`;
        if (clave !== ultimo) {
          ultimo = clave;
          indicadores(s);
          c.log(
            `t=${seg((Date.now() - tFalla) / 1000)} desde la falla · «primario caído» ${s.votosPrimarioCaido} de ${s.sites.length} · activo ${s.activeSite.toUpperCase()}`,
            s.activeSite === "gcp" ? "ok" : "aviso",
          );
        }
        return s;
      },
      (s) => s.activeSite === "gcp",
      120,
      500,
    );
    const tActivo = Date.now();
    const rtoFalla = (tActivo - tFalla) / 1000;
    await aparece(c.app.getByTestId("site-active-gcp"), 10_000);
    await ampliar(c, c.app.getByTestId("active-site"), 2400);
    const promovida = await sql(c, GCP, "SELECT NOT pg_is_in_recovery()", "gcp-promovida");
    e.exige(
      "conmutación automática a Google Cloud",
      !!cambio && promovida === "t",
      cambio ? `activo GCP · réplica promovida (lectura y escritura)` : "no conmutó en 120 s",
    );
    const d1 = await dns(c);
    e.comprueba("el DNS apunta al respaldo (10.80.0.2)", d1 === IP_GCP, d1 ?? "sin registro");
    const sigue = await sql(
      c,
      GCP,
      `SELECT count(*) FROM estado_plataforma WHERE clave = '${marca}'`,
      `gcp-tiene:${marca}`,
    );
    e.comprueba(
      "el dato de control sigue en el respaldo",
      sigue === "1",
      sigue === "1" ? `${marca} presente (sin pérdida del dato confirmado)` : "no está",
    );

    // ── 4. Acto 3: RTO desde la falla ──────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D05[3]!);
    const s3 = await estado();
    const objetivoS = (s3.rtoObjetivoMin ?? 15) * 60;
    c.log(
      `RTO desde la falla: ${seg(rtoFalla)} (desde «docker stop» de la base del CPD hasta ver el respaldo activo en la Consola; sondeo cada 0,5 s)`,
      "ok",
    );
    indicadores(s3, { "RTO desde la falla": seg(rtoFalla) });
    e.comprueba(
      "RTO desde la falla dentro del objetivo",
      rtoFalla > 0 && rtoFalla <= objetivoS,
      `${seg(rtoFalla)} (objetivo ${s3.rtoObjetivoMin ?? 15} min)`,
    );
    const ev = (await consola<Evento[]>(apr, "GET", "/continuity/events")).data.find(
      (x) => x.kind === "conmutacion" && x.to === "gcp" && Date.parse(x.startedAt) >= tFalla - 60_000,
    );
    if (ev) {
      await desplazarSiHay(c, c.app.getByTestId(`failover-event-${ev.id}`));
      await ampliar(c, c.app.getByTestId(`failover-rto-${ev.id}`), 2600, 1.8);
    }
    e.comprueba(
      "evento automático con el RTO del motor",
      !!ev && ev.trigger === "automatico" && ev.status === "completado" && (ev.rtoSeconds ?? 0) > 0,
      ev
        ? `conmutación misma ${seg(ev.rtoSeconds ?? 0, 2)} · RPO ${ev.rpoSecondsEstimated == null ? "no medido (se registra el rezago de WAL)" : seg(ev.rpoSecondsEstimated)}`
        : "sin evento",
    );
    const aud = (
      await consola<Array<Record<string, unknown>>>(
        await tokenPersona("pedro.auditoria"),
        "GET",
        "/audit-events?action=continuidad.conmutar&limit=20",
      )
    ).data;
    const auditada = Array.isArray(aud) && !!ev && aud.some((a) => JSON.stringify(a).includes(String(ev.id)));
    e.comprueba(
      "conmutación registrada en la auditoría",
      auditada,
      auditada ? `continuidad.conmutar · conmutacion/${ev?.id}` : "sin registro",
    );

    // ── 5. Retorno con dos personas ────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D05[4]!);
    await e.desplazar(-3000).catch(() => undefined);
    c.log("# se repone la base del sitio principal", "tenue");
    await lab(c, `docker start ${CPD}`, "cpd-start");
    await c.esperar(4000);
    await c.app.reload();
    const tSolicitud = Date.now();
    await e.clic(c.app.getByTestId("btn-request-failback"));
    await e.escribir(c.app.getByTestId("failback-request-dialog-reason"), MOTIVO_SOLICITUD, { ms: 55 });
    await e.clic(c.app.getByTestId("failback-request-dialog-confirm"));
    const pedida = await esperarHasta(estado, (s) => !!s.pendingFailback, 20, 1000);
    const solicitud = pedida?.valor.pendingFailback;
    c.log(
      `solicitud ${solicitud?.id ?? "?"} de ${solicitud?.requestedBy ?? "?"} · pendiente de aprobación`,
      solicitud ? "tenue" : "mal",
    );
    c.log(
      `carla.operacion → POST /api/v1/continuity/failback/requests/${solicitud?.id ?? "?"}/approve   # intenta aprobar su propia solicitud`,
      "cmd",
    );
    const propia = await consola<{ message?: string }>(
      operadora,
      "POST",
      `/continuity/failback/requests/${solicitud?.id ?? "x"}/approve`,
      {},
    );
    c.log(`  HTTP ${propia.status} · ${propia.data.message ?? ""}`, propia.status === 403 ? "aviso" : "mal");
    e.comprueba("quien solicita no puede aprobar (HTTP 403)", propia.status === 403, `HTTP ${propia.status}`);
    // Segunda persona, con su propia sesión de Keycloak (otro contexto de navegador).
    const aprobador: Page = await nuevaSesionD(c);
    await c.mostrar(aprobador);
    await c.ingresarConsola("luis.aprobador");
    await c.ir("/continuidad");
    await aparece(c.app.getByTestId("pending-failback"), 15_000);
    await e.clic(c.app.getByTestId("btn-approve-failback"));
    await e.escribir(c.app.getByTestId("failback-dialog-reason"), "Conforme", { ms: 70 });
    await e.clic(c.app.getByTestId("failback-dialog-confirm"));
    const vuelta = await esperarHasta(estado, (s) => s.activeSite === "cpd", 90, 1000);
    const segRetorno = (Date.now() - tSolicitud) / 1000;
    const evR = (await consola<Evento[]>(apr, "GET", "/continuity/events")).data.find(
      (x) => x.kind === "retorno" && Date.parse(x.startedAt) >= tSolicitud - 5000,
    );
    e.comprueba(
      "retorno aprobado por otra persona",
      !!evR && !!evR.approvedBy && evR.approvedBy !== evR.requestedBy && evR.approvedBy !== "carla.operacion",
      evR
        ? `pidió ${evR.requestedBy ?? solicitud?.requestedBy ?? "?"} · aprobó ${evR.approvedBy ?? "?"}`
        : "sin evento de retorno",
    );
    const d2 = await dns(c);
    await aparece(c.app.getByTestId("site-active-cpd"), 10_000);
    await ampliar(c, c.app.getByTestId("active-site"), 2200);
    indicadores(vuelta?.valor ?? (await estado()), { "retorno (pedido → CPD activo)": seg(segRetorno, 0) });
    e.comprueba(
      "CPD activo de nuevo y DNS en 10.80.0.1",
      !!vuelta && d2 === IP_CPD,
      `${seg(segRetorno, 0)} desde la solicitud · DNS ${d2 ?? "?"}`,
    );
    c.log(
      "La réplica de Google Cloud queda pendiente de reconstruir desde el CPD (pg_basebackup); se hace después de grabar.",
      "tenue",
    );
    await e.esperar(1500);

    return {
      medido: `RTO ${seg(rtoFalla)} desde la caída del CPD hasta el respaldo activo (conmutación automática con ${votosAlConmutar} de 3 votos «primario caído», sin pérdida del dato confirmado); con ${caidosVistos} de 3 no conmutó; retorno pedido y aprobado por dos personas en ${seg(segRetorno, 0)}`,
      datos: {
        rtoDesdeFallaSeg: Math.round(rtoFalla * 10) / 10,
        rtoMotorSeg: ev?.rtoSeconds,
        rpoEstimadoSeg: ev?.rpoSecondsEstimated ?? null,
        votosEnParticion: caidosVistos,
        votosAlConmutar,
        segundosRetorno: Math.round(segRetorno),
        particion: VARIANTE,
      },
    };
  },

  async limpiar() {
    await arrancarTodo();
    // El retorno deja la réplica promovida: se reconstruye para la próxima toma (fuera de cámara).
    try {
      if ((await sql(undefined, GCP, "SELECT pg_is_in_recovery()", "gcp-en-espera", false)) !== "t")
        await resincronizarReplica();
    } catch (err) {
      console.error(`[D-05] réplica: ${err instanceof Error ? err.message : err}`);
    }
  },
};
