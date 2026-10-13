/**
 * Ensayo (V09) de los guiones D-01 a D-05 y BT-005: lo que el servidor de ensayo del motor (src/lib/ensayo.ts)
 * no imita y estos guiones necesitan para correr de punta a punta sin laboratorio. NADA de esto es evidencia:
 * solo existe con `grabar --ensayo`, todo va rotulado ENSAYO y verificar.ts rechaza esos videos.
 *
 * Se agrega sin tocar los archivos del motor:
 *   - rutas del servidor de ensayo (se envuelve ServidorEnsayo.prototype.atender; lo que no es de estos guiones
 *     sigue al servidor original): descubrimiento, anomalías (reglas, eventos, bloqueos y el bloqueo en el
 *     gateway), continuidad (dos sitios, votos, conmutación y retorno con dos personas), auditoría, catálogo,
 *     Dev Portal/Publisher (aplicaciones con llaves propias, suscripciones, gobierno de contratos), la API de
 *     tarifas de BT-005 y /d0x/… (analítica, alertas y el laboratorio de continuidad);
 *   - la reversión del canary de D-04 con el 25 % del tráfico (envuelve ServidorEnsayo.prototype.rollout);
 *   - páginas de la Consola de ensayo para /descubrimiento, /anomalias y /continuidad, y la tarjeta «Endpoint
 *     estable» del detalle de un despliegue (tools/evidencias/ensayo/d0x-consola.js, inyectado en el contexto).
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { Contexto } from "../lib/grabador.js";
import { PAQUETE } from "../lib/entorno.js";
import { ServidorEnsayo } from "../lib/ensayo.js";
import { ENSAYO, reescribirUrlEnsayo } from "../lib/lab.js";

// ── Utilidades HTTP ───────────────────────────────────────────────────────────────────────────────────

const json = (res: ServerResponse, status: number, cuerpo: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(JSON.stringify(cuerpo));
};

function leer(req: IncomingMessage): Promise<string> {
  return new Promise((ok, mal) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString()));
    req.on("end", () => ok(s));
    req.on("error", mal);
  });
}

async function cuerpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  const t = await leer(req);
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(t));
  }
}

/** Sujeto del token de ensayo (persona o llave de aplicación) que viene en Authorization. */
export function sujetoToken(auth: string | undefined): string | undefined {
  const t = auth?.replace(/^Bearer /, "") ?? "";
  try {
    const p = JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString()) as {
      preferred_username?: string;
      sub?: string;
    };
    return p.preferred_username ?? p.sub;
  } catch {
    return undefined;
  }
}

/** PDF mínimo válido (una página con texto) para el reporte de ensayo. */
export function pdfMinimo(lineas: readonly string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
  const texto = lineas
    .map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 50 ${780 - i * 26} Td (${esc(l)}) Tj ET`)
    .join("\n");
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(texto)} >>\nstream\n${texto}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ── Estado simulado ───────────────────────────────────────────────────────────────────────────────────

const APPS = [
  { applicationId: "app-ensayo-1", name: "OperadorDemo" },
  { applicationId: "app-ensayo-2", name: "ReportesEnsayo" },
  { applicationId: "app-ensayo-3", name: "ConsumidorAltoVolumen" },
];
const appDeLlave = (sujeto: string | undefined) =>
  APPS.find((a) => sujeto === `ensayo-ck-${a.applicationId}`)?.name;

type Voto = "primario_sano" | "primario_caido";
interface AgenteSim {
  id: "cpd" | "gcp" | "testigo";
  voto: Voto;
  pendiente?: { voto: Voto; desde: number };
}

/** Laboratorio de continuidad simulado: dos sitios, tres agentes que votan cada 3 s y conmutación con 2 de 3. */
export class ContinuidadSim {
  modo = "automatico";
  activo: "cpd" | "gcp" = "cpd";
  cpdArriba = true;
  particion = false;
  promovida = false;
  marcas = new Set<string>();
  agentes: AgenteSim[] = [
    { id: "cpd", voto: "primario_sano" },
    { id: "gcp", voto: "primario_sano" },
    { id: "testigo", voto: "primario_sano" },
  ];
  eventos: Array<Record<string, unknown>> = [];
  solicitudes: Array<Record<string, unknown>> = [];
  auditoria: Array<Record<string, unknown>> = [];
  private conmutandoDesde?: number;
  private n = 0;
  /** Segundos que tarda un agente en cambiar su voto (2 ciclos de 3 s). */
  constructor(private readonly demoraVotoMs = 6000) {}

  get dns(): string {
    return this.activo === "cpd" ? "10.80.0.1" : "10.80.0.2";
  }

  /** Avanza la simulación hasta `ahora` (votos, conmutación automática, retornos aprobados). */
  avanzar(ahora = Date.now()): void {
    for (const a of this.agentes) {
      const caido = !this.cpdArriba || (a.id === "gcp" && this.particion);
      const objetivo: Voto = caido ? "primario_caido" : "primario_sano";
      if (objetivo === a.voto) a.pendiente = undefined;
      else if (a.pendiente?.voto !== objetivo) a.pendiente = { voto: objetivo, desde: ahora };
      else if (ahora - a.pendiente.desde >= this.demoraVotoMs) {
        a.voto = objetivo;
        a.pendiente = undefined;
      }
    }
    const caidos = this.agentes.filter((a) => a.voto === "primario_caido").length;
    if (this.modo === "automatico" && this.activo === "cpd" && caidos >= 2) {
      this.conmutandoDesde ??= ahora;
      if (ahora - this.conmutandoDesde >= 1500) {
        this.activo = "gcp";
        this.promovida = true;
        this.conmutandoDesde = undefined;
        const id = `ens-conm-${++this.n}`;
        this.eventos.unshift({
          id,
          kind: "conmutacion",
          trigger: "automatico",
          from: "cpd",
          to: "gcp",
          startedAt: new Date(ahora - 1500).toISOString(),
          finishedAt: new Date(ahora).toISOString(),
          rtoSeconds: 1.62,
          status: "completado",
          requestedBy: "nexo-continuidad@gcp",
        });
        this.auditoria.unshift({
          action: "continuidad.conmutar",
          resource: `conmutacion/${id}`,
          actor: "nexo-continuidad@gcp",
          ts: new Date(ahora).toISOString(),
        });
      }
    } else this.conmutandoDesde = undefined;
    for (const ev of this.eventos) {
      if (
        ev.kind === "retorno" &&
        ev.status === "en_curso" &&
        ahora - Date.parse(String(ev.startedAt)) >= 3000
      ) {
        ev.status = "completado";
        ev.finishedAt = new Date(ahora).toISOString();
        this.activo = "cpd";
      }
    }
  }

  estado() {
    this.avanzar();
    const pend = this.solicitudes.find((s) => s.status === "pendiente");
    return {
      mode: this.modo,
      activeSite: this.activo,
      quorum: "2 de 3",
      votosPrimarioCaido: this.agentes.filter((a) => a.voto === "primario_caido").length,
      rtoObjetivoMin: 15,
      rpoObjetivoMin: 1,
      sites: this.agentes.map((a) => ({
        id: a.id,
        name: a.id.toUpperCase(),
        role: a.id === "cpd" ? "primario" : a.id === "gcp" ? "respaldo" : "testigo",
        active: a.id === this.activo,
        vote: a.voto,
        lastSeen: new Date().toISOString(),
      })),
      ...(pend ? { pendingFailback: pend } : {}),
      ensayo: true,
    };
  }

  /** Operación del laboratorio (lo que harían los comandos docker/psql/etcdctl). Devuelve su salida. */
  lab(op: string): string {
    this.avanzar();
    const [nombre, arg] = op.split(":");
    switch (nombre) {
      case "dns":
        return `/skydns/lab/nexo/activo\n{"host":"${this.dns}","ttl":10}`;
      case "cpd-escribe":
        if (this.cpdArriba && arg) this.marcas.add(arg);
        return this.cpdArriba ? "INSERT 0 1" : "";
      case "gcp-tiene":
        return arg && this.marcas.has(arg) ? "1" : "0";
      case "gcp-en-espera":
        return this.promovida ? "f" : "t";
      case "gcp-promovida":
        return this.promovida ? "t" : "f";
      case "particion":
        this.particion = true;
        return "";
      case "curar":
        this.particion = false;
        return "";
      case "cpd-stop":
        this.cpdArriba = false;
        return "nexo-lab-cont-cpd-1";
      case "cpd-start":
        this.cpdArriba = true;
        return "nexo-lab-cont-cpd-1";
      case "resync":
        this.promovida = false;
        return "";
      default:
        return "";
    }
  }

  solicitar(usuario: string, motivo: string): [number, unknown] {
    this.avanzar();
    if (this.activo === "cpd") return [409, { message: "El CPD ya es el sitio activo (ensayo)" }];
    if (this.solicitudes.some((s) => s.status === "pendiente"))
      return [409, { message: "Ya hay una solicitud pendiente (ensayo)" }];
    const r = {
      id: `ens-ret-${++this.n}`,
      status: "pendiente",
      requestedBy: usuario,
      reason: motivo,
      fromSite: this.activo,
      toSite: "cpd",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    this.solicitudes.unshift(r);
    this.auditoria.unshift({
      action: "continuidad.retorno.solicitar",
      resource: `retorno/${r.id}`,
      actor: usuario,
      ts: r.requestedAt,
    });
    return [201, r];
  }

  aprobar(id: string, usuario: string): [number, unknown] {
    const s = this.solicitudes.find((x) => x.id === id);
    if (!s) return [404, { message: "La solicitud de retorno no existe (ensayo)" }];
    if (usuario === "carla.operacion")
      return [403, { message: "No tiene el permiso continuity:failback:approve (ensayo)" }];
    if (usuario === s.requestedBy)
      return [403, { message: "Regla de cuatro ojos: quien solicita no aprueba (ensayo)" }];
    if (s.status !== "pendiente") return [409, { message: "La solicitud no está pendiente (ensayo)" }];
    s.status = "aprobada";
    s.approvedBy = usuario;
    const ev = {
      id: `ens-conm-${++this.n}`,
      kind: "retorno",
      trigger: "manual",
      from: this.activo,
      to: "cpd",
      startedAt: new Date().toISOString(),
      status: "en_curso",
      requestedBy: s.requestedBy,
      approvedBy: usuario,
    };
    this.eventos.unshift(ev);
    this.auditoria.unshift({
      action: "continuidad.retorno.aprobar",
      resource: `retorno/${id}`,
      actor: usuario,
      ts: ev.startedAt,
    });
    return [202, { request: s, event: ev }];
  }
}

interface EstadoD {
  continuidad: ContinuidadSim;
  scans: Array<Record<string, unknown>>;
  hallazgos: Array<Record<string, unknown>>;
  reglas: Array<Record<string, unknown>>;
  anomalias: Array<Record<string, unknown>>;
  bloqueos: Array<Record<string, unknown>>;
  auditoria: Array<Record<string, unknown>>;
  /** Llamadas por segundo de cada aplicación consumidora (para la ráfaga de D-02). */
  llamadas: Map<string, number[]>;
  rafagaDesde?: number;
  publicadas: Map<string, Record<string, unknown>>;
  suscripciones: Set<string>;
  manuales: Set<string>;
  tarifasPorSegundo: Map<number, number>;
  /** Desde cuándo falla concesiones-v2 (el controlador simulado tarda unos segundos en revertir). */
  fallaV2Desde?: number;
  n: number;
}

const estados = new WeakMap<object, EstadoD>();
function estadoDe(s: object): EstadoD {
  let e = estados.get(s);
  if (!e) {
    e = {
      continuidad: new ContinuidadSim(),
      scans: [],
      hallazgos: [],
      reglas: [],
      anomalias: [],
      bloqueos: [],
      auditoria: [],
      llamadas: new Map(),
      publicadas: new Map(),
      suscripciones: new Set(),
      manuales: new Set(),
      tarifasPorSegundo: new Map(),
      n: 0,
    };
    estados.set(s, e);
  }
  return e;
}

/** Hallazgos simulados del descubrimiento (mismas rutas que verifica check-d01, ordenados por puntaje). */
export function hallazgosEnsayo(): Array<Record<string, unknown>> {
  const h = [
    {
      source: "nginx",
      host: "nginx-legacy",
      port: 80,
      path: "/interno/reportes/titulares",
      specFound: false,
      authDetected: "ninguna",
      personalDataSuspected: true,
      exposureScore: 95,
      reasons: ["responde sin autenticación", "parece exponer datos personales"],
    },
    {
      source: "red",
      host: "ocultas",
      port: 7001,
      path: "/espectro/asignaciones",
      specFound: true,
      authDetected: "ninguna",
      personalDataSuspected: true,
      exposureScore: 88,
      reasons: ["contrato OpenAPI publicado", "responde sin autenticación"],
    },
    {
      source: "nginx",
      host: "nginx-legacy",
      port: 80,
      path: "/tarifas",
      specFound: false,
      authDetected: "ninguna",
      personalDataSuspected: false,
      exposureScore: 64,
      reasons: ["responde sin autenticación"],
    },
    {
      source: "apisix",
      host: "apisix",
      port: 9080,
      path: "/fiscalizacion",
      specFound: false,
      authDetected: "requerida (key-auth)",
      personalDataSuspected: false,
      exposureScore: 52,
      reasons: ["fuera del catálogo gobernado"],
    },
    {
      source: "red",
      host: "registro-soap",
      port: 7001,
      path: "/registro",
      specFound: false,
      authDetected: "desconocida",
      personalDataSuspected: false,
      exposureScore: 41,
      reasons: ["servicio SOAP sin contrato"],
    },
    {
      source: "red",
      host: "concesiones-v1",
      port: 7001,
      path: "/concesiones",
      specFound: false,
      authDetected: "ninguna",
      personalDataSuspected: false,
      matchedApiId: "wso2-concesiones",
      exposureScore: 33,
      reasons: ["backend de una API gobernada accesible sin pasar por el gateway"],
    },
    {
      source: "red",
      host: "graphql-concesiones",
      port: 7001,
      path: "/graphql",
      specFound: false,
      authDetected: "ninguna",
      personalDataSuspected: false,
      exposureScore: 27,
      reasons: ["endpoint GraphQL"],
    },
  ];
  return h.map((x, i) => ({ id: `ens-h-${i + 1}`, status: "nuevo", ...x }));
}

async function manejar(s: object, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const e = estadoDe(s);
  const p = url.pathname;
  const metodo = req.method ?? "GET";
  const usuario = () => sujetoToken(req.headers.authorization) ?? "persona";

  // ── Falla inyectable de concesiones-v2 (D-04): se anota desde cuándo falla ────────────────────────
  if (p === "/chaos-v2/_chaos" && metodo === "POST") {
    const b = await cuerpo(req);
    const tasa = Number(b.failRate ?? 0);
    (s as unknown as { falla: { v2: number } }).falla.v2 = tasa;
    e.fallaV2Desde = tasa > 0 ? Date.now() : undefined;
    json(res, 200, { failRate: tasa, ensayo: true });
    return true;
  }

  // ── /d0x: laboratorio de continuidad, analítica, alertas y publicación simulada ──────────────────
  if (p === "/d0x/continuidad/lab" && metodo === "POST") {
    const b = await cuerpo(req);
    json(res, 200, { salida: e.continuidad.lab(String(b.op ?? "")), ensayo: true });
    return true;
  }
  if (p.startsWith("/d0x/opensearch/")) {
    const q = await leer(req);
    if (q.includes("applicationName.keyword") && q.includes("date_histogram")) {
      const rps: Record<string, number> = { OperadorDemo: 2, ConsumidorAltoVolumen: 25 };
      json(res, 200, {
        aggregations: {
          app: {
            buckets: Object.entries(rps).map(([key, r]) => ({
              key,
              doc_count: r * 30 * 60,
              v: { buckets: Array.from({ length: 60 }, (_, i) => ({ key: i, doc_count: r * 30 })) },
            })),
          },
        },
      });
    } else if (q.includes("destination.keyword")) {
      json(res, 200, {
        aggregations: {
          destino: {
            buckets: [
              {
                key: "http://ocultas:7001/legacy/tarifas",
                doc_count: 22,
                codigo: {
                  buckets: [
                    { key: 200, doc_count: 21 },
                    { key: 429, doc_count: 1 },
                  ],
                },
                backend: { buckets: [{ key: 200, doc_count: 21 }] },
              },
            ],
          },
        },
      });
    } else json(res, 200, { hits: { total: { value: 0 }, hits: [] }, aggregations: {} });
    return true;
  }
  if (p === "/d0x/alertmanager/api/v2/alerts") {
    const b = e.bloqueos.find((x) => x.active);
    json(
      res,
      200,
      b
        ? [
            {
              labels: {
                alertname: "ConsumidorBloqueado",
                severidad: "S2",
                consumidor: String(b.conditionValue),
              },
              annotations: {
                resumen: `Bloqueo automático de ${String(b.conditionValue)} por volumen anómalo (ensayo)`,
              },
            },
          ]
        : [],
    );
    return true;
  }
  if (p === "/d0x/wso2/publicar" && metodo === "POST") {
    const b = await cuerpo(req);
    const name = String(b.name ?? "");
    e.publicadas.set(name, {
      id: `ens-api-${name.toLowerCase()}`,
      name,
      version: "1.0.0",
      lifeCycleStatus: "PUBLISHED",
      context: `/${name.toLowerCase()}`,
    });
    json(res, 200, { ok: true });
    return true;
  }

  // ── API de la Consola ────────────────────────────────────────────────────────────────────────────
  if (p.startsWith("/api/v1/")) {
    const r = p.slice("/api/v1".length);
    // Descubrimiento (D-01)
    if (r === "/discovery/findings" && metodo === "GET") return (json(res, 200, e.hallazgos), true);
    if (r === "/discovery/scans" && metodo === "GET") {
      for (const sc of e.scans) {
        if (sc.status === "en_curso" && Date.now() - Number(sc._t) > 7000) {
          sc.status = "terminado";
          e.hallazgos = hallazgosEnsayo();
          sc.totals = {
            endpoints: e.hallazgos.length,
            gobernados: 1,
            noGobernados: e.hallazgos.length - 1,
            riesgoAlto: e.hallazgos.filter((h) => Number(h.exposureScore) >= 70).length,
          };
        }
      }
      return (
        json(
          res,
          200,
          e.scans.map(({ _t, ...x }) => x),
        ),
        true
      );
    }
    if (r === "/discovery/scans" && metodo === "POST") {
      const sc = {
        id: `ens-scan-${++e.n}`,
        status: "en_curso",
        startedAt: new Date().toISOString(),
        requestedBy: usuario(),
        _t: Date.now(),
      };
      e.scans.unshift(sc);
      return (json(res, 202, sc), true);
    }
    if (r === "/discovery/report") {
      if (url.searchParams.get("format") === "pdf") {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="reporte-exposicion.pdf"',
          "x-ensayo": "1",
        });
        res.end(
          pdfMinimo([
            "Reporte de exposicion (ENSAYO, datos simulados)",
            ...e.hallazgos.map(
              (h) => `${String(h.exposureScore)}  ${String(h.host)}${String(h.path)}  ${String(h.source)}`,
            ),
          ]),
        );
        return true;
      }
      const csv = [
        "puntaje,fuente,host,ruta,autenticacion,datos_personales",
        ...e.hallazgos.map(
          (h) =>
            `${String(h.exposureScore)},${String(h.source)},${String(h.host)},${String(h.path)},${String(h.authDetected)},${h.personalDataSuspected ? "si" : "no"}`,
        ),
      ].join("\n");
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="reporte-exposicion.csv"',
        "x-ensayo": "1",
      });
      res.end(`${csv}\n`);
      return true;
    }
    // Anomalías (D-02)
    if (r.startsWith("/apis") && metodo === "GET")
      return (
        json(res, 200, [
          { id: "api-concesiones", wso2ApiId: "wso2-concesiones", name: "Concesiones", version: "1.0.0" },
        ]),
        true
      );
    if (r === "/anomaly-rules" && metodo === "GET") return (json(res, 200, e.reglas), true);
    if (r === "/anomaly-rules" && metodo === "POST") {
      const b = await cuerpo(req);
      const regla = {
        id: `ens-regla-${++e.n}`,
        enabled: true,
        ...b,
        sensitivity: Number(b.sensitivity ?? 3),
        minVolume: Number(b.minVolume ?? 30),
        blockTtlMinutes: Number(b.blockTtlMinutes ?? 2),
      };
      e.reglas.unshift(regla);
      return (json(res, 201, regla), true);
    }
    const mr = /^\/anomaly-rules\/([^/]+)$/.exec(r);
    if (mr && (metodo === "PATCH" || metodo === "PUT")) {
      const b = await cuerpo(req);
      const regla = e.reglas.find((x) => x.id === mr[1]);
      if (regla) Object.assign(regla, b);
      return (json(res, 200, regla ?? {}), true);
    }
    if (r.startsWith("/anomalies") && metodo === "GET") return (json(res, 200, e.anomalias), true);
    if (r === "/blocks" && metodo === "GET") return (json(res, 200, e.bloqueos), true);
    const mb = /^\/blocks\/([^/]+)\/release$/.exec(r);
    if (mb && metodo === "POST") {
      const b = e.bloqueos.find((x) => x.id === mb[1]);
      if (!b) return (json(res, 404, { message: "no existe (ensayo)" }), true);
      b.active = false;
      b.releasedBy = usuario();
      b.releasedAt = new Date().toISOString();
      e.auditoria.unshift({
        action: "anomalias.bloqueo.liberar",
        resource: `bloqueo/${String(b.id)}`,
        actor: usuario(),
        ts: b.releasedAt,
      });
      e.rafagaDesde = undefined;
      return (json(res, 200, b), true);
    }
    // Continuidad (D-05)
    const cont = e.continuidad;
    if (r === "/continuity" && metodo === "GET") return (json(res, 200, cont.estado()), true);
    if (r === "/continuity/mode" && metodo === "PUT") {
      cont.modo = String((await cuerpo(req)).mode ?? cont.modo);
      return (json(res, 200, cont.estado()), true);
    }
    if (r === "/continuity/events" && metodo === "GET")
      return (cont.avanzar(), json(res, 200, cont.eventos), true);
    if (r === "/continuity/failback/requests" && metodo === "GET")
      return (json(res, 200, cont.solicitudes), true);
    if (r === "/continuity/failback/requests" && metodo === "POST") {
      const [st, b] = cont.solicitar(usuario(), String((await cuerpo(req)).reason ?? ""));
      return (json(res, st, b), true);
    }
    const mf = /^\/continuity\/failback\/requests\/([^/]+)\/(approve|reject)$/.exec(r);
    if (mf && metodo === "POST") {
      await leer(req);
      if (mf[2] === "reject") {
        const sol = cont.solicitudes.find((x) => x.id === mf[1]);
        if (sol) sol.status = "rechazada";
        return (json(res, 200, sol ?? {}), true);
      }
      const [st, b] = cont.aprobar(mf[1]!, usuario());
      return (json(res, st, b), true);
    }
    // Auditoría
    if (r === "/audit-events" && metodo === "GET") {
      const accion = url.searchParams.get("action");
      const todos = [...cont.auditoria, ...e.auditoria];
      return (json(res, 200, accion ? todos.filter((a) => a.action === accion) : todos), true);
    }
    return false;
  }

  // ── Gateway: bloqueo de D-02 y la API de tarifas de BT-005 ──────────────────────────────────────
  if (p.startsWith("/gateway/")) {
    const app = appDeLlave(sujetoToken(req.headers.authorization));
    if (p.startsWith("/gateway/tarifas/")) {
      if (!req.headers.authorization)
        return (json(res, 401, { code: 900902, message: "Missing Credentials (ensayo)" }), true);
      if (!e.suscripciones.has("OperadorDemo"))
        return (
          json(res, 403, { code: 900908, message: "Resource forbidden: sin suscripción (ensayo)" }),
          true
        );
      const s0 = Math.floor(Date.now() / 1000);
      const k = (e.tarifasPorSegundo.get(s0) ?? 0) + 1;
      e.tarifasPorSegundo.set(s0, k);
      if (k > 20) return (json(res, 429, { code: 900800, message: "Message throttled out (ensayo)" }), true);
      return (
        json(res, 200, {
          tarifas: [
            { plan: "Plan base (ensayo)", valor: 9990 },
            { plan: "Plan full (ensayo)", valor: 19990 },
          ],
        }),
        true
      );
    }
    if (app) {
      const ahora = Math.floor(Date.now() / 1000);
      const serie = e.llamadas.get(app) ?? [];
      serie.push(ahora);
      while (serie.length && serie[0]! < ahora - 5) serie.shift();
      e.llamadas.set(app, serie);
      const bloqueado = e.bloqueos.find((b) => b.active && String(b.conditionValue).endsWith(`:${app}`));
      if (bloqueado)
        return (json(res, 403, { code: 900908, message: "Blocked by deny policy (ensayo)" }), true);
      const regla = e.reglas.find((x) => x.enabled && x.action === "bloquear_automatico");
      if (regla && app === "OperadorDemo" && serie.length / 5 >= 10) {
        e.rafagaDesde ??= Date.now();
        if (Date.now() - e.rafagaDesde > 25_000) {
          const id = `ens-bloqueo-${++e.n}`;
          e.bloqueos.unshift({
            id,
            active: true,
            conditionType: "APPLICATION",
            conditionValue: `admin:${app}`,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          });
          e.anomalias.unshift({
            id: `ens-anom-${e.n}`,
            ruleId: regla.id,
            status: "bloqueada",
            blockId: id,
            observed: 598,
            baseline: 60,
            score: 9.4,
            consumer: app,
            metric: "volumen",
            detectedAt: new Date().toISOString(),
          });
          e.auditoria.unshift({
            action: "anomalias.bloqueo.automatico",
            resource: `bloqueo/${id}`,
            actor: "nexo-guardian",
            ts: new Date().toISOString(),
          });
          return (json(res, 403, { code: 900908, message: "Blocked by deny policy (ensayo)" }), true);
        }
      } else if (app === "OperadorDemo" && serie.length / 5 < 5) e.rafagaDesde = undefined;
    }
    return false;
  }

  // ── WSO2: aplicaciones con llaves propias, suscripciones, APIs publicadas y gobierno ───────────────
  if (p.startsWith("/wso2/api/am/")) {
    const r = p.slice("/wso2/api/am".length);
    if (r === "/admin/v4/throttling/deny-policies" && metodo === "GET") {
      const lista = e.bloqueos
        .filter((b) => b.active)
        .map((b) => ({
          policyId: `ens-deny-${String(b.id)}`,
          conditionType: "APPLICATION",
          conditionValue: b.conditionValue,
          conditionStatus: true,
        }));
      return (json(res, 200, { count: lista.length, list: lista }), true);
    }
    if (/^\/devportal\/v3\/applications\/?$/.test(r) && metodo === "GET")
      return (
        json(res, 200, {
          count: APPS.length,
          list: APPS.map((a) => ({ ...a, throttlingPolicy: "Unlimited", status: "APPROVED" })),
        }),
        true
      );
    const mk = /^\/devportal\/v3\/applications\/([^/]+)\/(oauth-keys|keys)/.exec(r);
    if (mk && metodo === "GET")
      return (
        json(res, 200, {
          count: 1,
          list: [
            {
              keyManager: "Keycloak",
              keyType: "PRODUCTION",
              consumerKey: `ensayo-ck-${mk[1]}`,
              consumerSecret: "ensayo-cs",
              keyState: "COMPLETED",
            },
          ],
        }),
        true
      );
    const ms = /^\/devportal\/v3\/applications\/([^/]+)\/subscriptions|^\/devportal\/v3\/subscriptions/.exec(
      r,
    );
    if (ms && metodo === "GET")
      return (
        json(res, 200, {
          count: 1,
          list: [{ apiId: "wso2-concesiones", status: "UNBLOCKED", apiInfo: { id: "wso2-concesiones" } }],
        }),
        true
      );
    if (r.startsWith("/devportal/v3/subscriptions") && metodo === "POST") {
      const b = await cuerpo(req);
      const app = APPS.find((a) => a.applicationId === b.applicationId)?.name ?? "OperadorDemo";
      e.suscripciones.add(app);
      return (json(res, 201, { subscriptionId: `ens-sub-${++e.n}`, ...b, status: "UNBLOCKED" }), true);
    }
    if (/^\/devportal\/v3\/apis\/?$/.test(r) && metodo === "GET")
      return (
        json(res, 200, {
          count: 1 + e.publicadas.size,
          list: [{ id: "wso2-concesiones", name: "Concesiones", version: "1.0.0" }, ...e.publicadas.values()],
        }),
        true
      );
    if (/^\/publisher\/v4\/apis\/?$/.test(r) && metodo === "GET") {
      const q = url.searchParams.get("query") ?? "";
      const nombre = /name:"?([^"]+)"?/.exec(q)?.[1];
      const lista = [...e.publicadas.values()].filter((a) => !nombre || a.name === nombre);
      return (json(res, 200, { count: lista.length, list: lista }), true);
    }
    if (r === "/publisher/v4/apis/import-openapi" && metodo === "POST") {
      await leer(req);
      const id = `ens-manual-${++e.n}`;
      e.manuales.add(id);
      return (json(res, 201, { id, name: "ReportesInternos", lifeCycleStatus: "CREATED" }), true);
    }
    const mrev = /^\/publisher\/v4\/apis\/([^/]+)\/revisions$/.exec(r);
    if (mrev && metodo === "POST" && e.manuales.has(mrev[1]!)) {
      await leer(req);
      const violaciones = [
        { ruleName: "nexo-info-contacto", message: "Falta info.contact con name y email." },
        {
          ruleName: "nexo-rutas-kebab",
          message: "La ruta /obtenerReportes no cumple kebab-case en minúsculas.",
        },
        { ruleName: "nexo-sin-basic-auth", message: "El esquema de seguridad usa HTTP basic." },
      ];
      json(res, 400, {
        code: 400,
        message: "API Governance: el despliegue tiene infracciones bloqueantes (ensayo)",
        description: JSON.stringify({ blockingViolations: violaciones }),
      });
      return true;
    }
    const mdel = /^\/publisher\/v4\/apis\/([^/]+)$/.exec(r);
    if (mdel && metodo === "DELETE") {
      for (const [k, v] of e.publicadas) if (v.id === mdel[1]) e.publicadas.delete(k);
      e.manuales.delete(mdel[1]!);
      res.writeHead(200, { "x-ensayo": "1" }).end();
      return true;
    }
    return false;
  }
  return false;
}

// ── Instalación ───────────────────────────────────────────────────────────────────────────────────────

type ProtoServidor = {
  atender(req: IncomingMessage, res: ServerResponse): Promise<void>;
  rollout(id: string): Record<string, unknown> | undefined;
  __d0x?: boolean;
};

/**
 * Grabación en curso de uno de estos guiones (las rutas de aquí solo responden mientras tanto: los demás guiones
 * del ensayo siguen con el servidor del motor o con sus propias envolturas).
 */
let activo: Contexto | undefined;
/** Solo para pruebas: atiende siempre. */
let siempre = false;
const estaActivo = () => siempre || activo !== undefined;

/** Envuelve el servidor de ensayo con las rutas de estos guiones (una sola vez por proceso). */
export function instalarServidorD(o: { siempre?: boolean } = {}): void {
  if (o.siempre) siempre = true;
  const proto = ServidorEnsayo.prototype as unknown as ProtoServidor;
  if (proto.__d0x) return;
  proto.__d0x = true;
  const atender = proto.atender;
  proto.atender = async function (this: object, req: IncomingMessage, res: ServerResponse) {
    if (estaActivo()) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await manejar(this, req, res, url)) return;
    }
    return atender.call(this, req, res);
  };
  // D-04: un canary hacia concesiones-v2 que empieza a fallar con ≥ 25 % del tráfico se revierte en ese paso.
  const rollout = proto.rollout;
  proto.rollout = function (
    this: {
      falla: { v2: number };
      rollouts: Map<string, Record<string, unknown>>;
      abortados: Set<string>;
      ruta: { rolloutId?: string };
    },
    id: string,
  ) {
    const r = rollout.call(this, id) as Record<string, unknown> | undefined;
    if (!estaActivo() || !r || r.status !== "en_curso" || r.strategy !== "canary") return r;
    const peso = Number(r.currentWeight ?? 0);
    const desde = estadoDe(this).fallaV2Desde;
    if (
      peso >= 25 &&
      this.falla.v2 > 0.02 &&
      desde !== undefined &&
      Date.now() - desde >= 3500 &&
      String(r.candidateEndpoint).includes("concesiones-v2")
    ) {
      const pasos = [
        ...((r.stepsDone as unknown[]) ?? []),
        { kind: "peso", weight: peso, requests: 50, decision: "revierte", errorRate: this.falla.v2 },
      ];
      const rev = {
        ...r,
        status: "revertido",
        currentWeight: 0,
        stepsDone: pasos,
        finishedAt: new Date().toISOString(),
        rollbackReason: `tasa de error del candidato ${Math.round(this.falla.v2 * 100)} % supera el umbral de 2 % (estable: 0 %), con ${peso} % del tráfico (ensayo)`,
      };
      this.rollouts.set(id, rev);
      this.abortados.add(id);
      this.ruta.rolloutId = undefined;
      return rev;
    }
    return r;
  };
}

const SCRIPT_PAGINAS = () => readFileSync(resolve(PAQUETE, "ensayo/d0x-consola.js"), "utf8");
const conPaginas = new WeakSet<BrowserContext>();

/** Página que redirige en el navegador (así la navegación siguiente vuelve a pasar por page.route). */
export function paginaRedireccion(destino: string): string {
  const d = destino.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${d}"><script>location.replace(${JSON.stringify(destino)})</script>`;
}

/**
 * Agrega las páginas de ensayo de estos guiones a un contexto de navegador (una vez por contexto) y corrige,
 * solo en ensayo, las redirecciones de los portales de WSO2: Chromium no vuelve a interceptar el destino de un
 * 302 entregado por page.route() y busca https://apim:9443 en el DNS (falla). Aquí el 302 se convierte en una
 * redirección en el navegador, que sí vuelve a pasar por la ruta.
 */
export async function instalarPaginasD(ctx: BrowserContext): Promise<void> {
  if (!ENSAYO || conPaginas.has(ctx)) return;
  conPaginas.add(ctx);
  await ctx.addInitScript({ content: SCRIPT_PAGINAS() });
  await ctx.route(/^https:\/\/apim:9443(\/|\?|$)/, async (ruta) => {
    const original = ruta.request().url();
    const r = await ruta
      .fetch({ url: reescribirUrlEnsayo(original), maxRedirects: 0 })
      .catch(() => undefined);
    if (!r) return ruta.abort();
    const destino = r.headers().location;
    if (r.status() >= 300 && r.status() < 400 && destino) {
      const cookie = r
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value);
      return ruta.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: cookie.length ? { "set-cookie": cookie.join("\n") } : {},
        body: paginaRedireccion(new URL(destino, original).toString()),
      });
    }
    return ruta.fulfill({ response: r });
  });
}

/** Preparación de ensayo de los guiones D-01..D-05 y BT-005 (en el laboratorio no hace nada). */
export async function prepararEnsayoD(c: Contexto): Promise<void> {
  if (!c.estudio.ensayo || !ENSAYO) return;
  instalarServidorD();
  activo = c;
  c.appContext.once("close", () => {
    if (activo === c) activo = undefined;
  });
  await instalarPaginasD(c.appContext);
}

/** Otra sesión de navegador (otra persona) con las páginas de ensayo, si corresponde. */
export async function nuevaSesionD(c: Contexto): Promise<Page> {
  const p = await c.nuevaSesion();
  if (c.estudio.ensayo) await instalarPaginasD(p.context());
  return p;
}

if (ENSAYO) instalarServidorD();
