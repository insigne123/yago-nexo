/**
 * Ensayo (V09) de los guiones D-06, D-07, D-08, BT-008, BT-018, BT-021 y BT-049: lo que el servidor de ensayo
 * del motor (src/lib/ensayo.ts) no imita y estos guiones necesitan para correr de punta a punta sin laboratorio.
 *
 * NADA de esto es evidencia: solo existe con `grabar --ensayo`, todas las páginas llevan el rótulo ENSAYO y el
 * video también (pasos.json con ensayo:true, que verificar.ts rechaza). En una grabación oficial
 * prepararEnsayo() no hace nada y urlLab()/urlEventos() devuelven las direcciones reales del laboratorio.
 *
 * Cómo se engancha sin tocar el motor: instalarEnsayoGuiones() envuelve ServidorEnsayo.prototype.atender; si la
 * ruta es de estos guiones la atiende aquí y si no, la deja al servidor del motor. Las páginas de la Consola de
 * ensayo que faltan (catálogo, dependencias, mensajes fallidos, consumo y exportación) las dibuja
 * ensayo/consola/bt0x-paginas.js, que se inyecta en el contexto operado.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { WebSocketServer } from "ws";
import { PAQUETE } from "../lib/entorno.js";
import { ServidorEnsayo } from "../lib/ensayo.js";
import type { Contexto } from "../lib/grabador.js";
import { ENSAYO, enEnsayo } from "../lib/lab.js";

// ── Direcciones del laboratorio que no están en ORIGENES_LAB (lab.ts) ─────────────────────────────────────

/** Puertos locales del laboratorio que usan estos guiones (destino de BT-008, RabbitMQ y Jaeger). */
const PUERTOS_LOCALES = ["7001", "15672", "16686"];

/** En ensayo, http://localhost:7001|15672|16686/… va al servidor de ensayo (/bt0x/<puerto>/…); si no, igual. */
export function urlLab(url: string, base: string | undefined = ENSAYO): string {
  if (!base) return url;
  const m = /^http:\/\/localhost:(\d+)(\/.*)?$/.exec(url);
  if (!m || !PUERTOS_LOCALES.includes(m[1]!)) return url;
  return `${base}/bt0x/${m[1]}${m[2] ?? "/"}`;
}

let ws: { url: string; servidor: WebSocketServer } | undefined;

/** URL de la API de eventos (D-06): la del gateway, o en ensayo un WebSocket local que exige token. */
export async function urlEventos(): Promise<string> {
  if (!enEnsayo()) return "wss://apim:8099/eventos/red/1.0.0/ws";
  if (!ws) {
    const servidor = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (info, cb) =>
        /^Bearer \S+/.test(String(info.req.headers.authorization ?? ""))
          ? cb(true)
          : cb(false, 401, "Unauthorized"),
    });
    await new Promise<void>((ok) => servidor.once("listening", () => ok()));
    let n = 0;
    servidor.on("connection", (s) => {
      s.send(JSON.stringify({ tipo: "bienvenida", ensayo: true, ocurridoEn: new Date().toISOString() }));
      const t = setInterval(() => {
        n++;
        s.send(
          JSON.stringify({
            tipo: "estado_red",
            ensayo: true,
            nodo: `NODO-${String(n).padStart(3, "0")}`,
            region: ["Los Lagos", "Aysén", "Biobío"][n % 3],
            estado: n % 4 ? "operativo" : "degradado",
          }),
        );
      }, 1200);
      s.on("close", () => clearInterval(t));
    });
    ws = { url: `ws://127.0.0.1:${(servidor.address() as AddressInfo).port}/eventos/red/1.0.0/ws`, servidor };
  }
  return ws.url;
}

/** Grabación de ensayo en curso de uno de estos guiones (las rutas de aquí solo responden mientras dura). */
let activo: Contexto | undefined;
let siempreActivo = false;
const estaActivo = () => siempreActivo || (!!activo && !!activo.app && !activo.app.isClosed());

/** En ensayo: instala las rutas de estos guiones y las páginas de la Consola que faltan. Oficial: nada. */
export async function prepararEnsayo(c: Contexto): Promise<void> {
  if (!c.ensayo) return;
  activo = c;
  instalarEnsayoGuiones();
  await c.appContext.addInitScript({ path: resolve(PAQUETE, "ensayo/consola/bt0x-paginas.js") });
  await c.appContext.route(/^http:\/\/localhost:16686\//, (r) =>
    r.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: paginaJaeger(new URL(r.request().url()).pathname.split("/").pop() ?? ""),
    }),
  );
}

// ── Datos de ensayo ────────────────────────────────────────────────────────────────────────────────────

export const APIS = [
  {
    id: "api-concesiones",
    name: "Concesiones",
    version: "1.0.0",
    type: "HTTP",
    context: "/concesiones/1.0.0",
  },
  {
    id: "api-graphql",
    name: "ConcesionesGraphQL",
    version: "1.0.0",
    type: "GRAPHQL",
    context: "/graphql/concesiones/1.0.0",
  },
  { id: "api-eventos", name: "EventosRed", version: "1.0.0", type: "WS", context: "/eventos/red/1.0.0" },
  {
    id: "api-solicitudes",
    name: "SolicitudesConcesion",
    version: "1.0.0",
    type: "HTTP",
    context: "/solicitudes/1.0.0",
  },
  {
    id: "api-consulta",
    name: "ConsultaPublica",
    version: "1.0.0",
    type: "HTTP",
    context: "/consulta-publica/1.0.0",
  },
];

export const SDL_ENSAYO = `"Concesión de un servicio de telecomunicaciones (datos de ensayo)"
type Concesion {
  id: ID!
  empresa: String!
  servicio: String!
  region: String!
  estado: String!
}

type Query {
  "Lista concesiones filtradas por región y estado"
  concesiones(region: String, estado: String, limite: Int = 20): [Concesion!]!
  "Obtiene una concesión por su identificador"
  concesion(id: ID!): Concesion
  "Cantidad de concesiones por estado"
  totalPorEstado: [ConteoEstado!]!
}

type ConteoEstado {
  estado: String!
  total: Int!
}
`;

const ASYNCAPI = {
  asyncapi: "2.6.0",
  info: { title: "EventosRed (ensayo)", version: "1.0.0" },
  channels: {
    "/ws": {
      subscribe: {
        message: {
          name: "EstadoRed",
          payload: { type: "object", properties: { nodo: { type: "string" }, estado: { type: "string" } } },
        },
      },
    },
  },
};

const OPERACIONES = [
  ["/concesiones", "get", "listarConcesiones"],
  ["/concesiones", "post", "crearConcesion"],
  ["/concesiones/{id}", "get", "obtenerConcesion"],
] as const;

const PLATAFORMA_ENSAYO = `# Configuración de la plataforma (ENSAYO: copia simulada, no es el paquete real)
gatewayEnvironments:
  - name: Desarrollo
  - name: QA
  - name: Default
throttling:
  subscription:
    - name: OperadoresEstandar
    - name: Interno
workflows:
  file: workflow-extensions.xml
governance:
  policies:
    - name: guia-estilo-institucional
    - name: guia-asyncapi
`;

type Flujo =
  | "AM_USER_SIGNUP"
  | "AM_APPLICATION_CREATION"
  | "AM_APPLICATION_REGISTRATION_PRODUCTION"
  | "AM_SUBSCRIPTION_CREATION";
interface Tarea {
  referenceId: string;
  workflowType: Flujo;
  workflowStatus: "CREATED" | "APPROVED" | "REJECTED";
  description: string;
  properties: Record<string, string>;
  createdTime: string;
  aplicar: () => void;
}
interface App {
  applicationId: string;
  name: string;
  owner: string;
  status: "CREATED" | "APPROVED";
  llave?: { consumerKey: string; consumerSecret: string; aprobada: boolean };
  subs: Map<string, { plan: string; aprobada: boolean }>;
}
interface Mensaje {
  id: string;
  error: string;
  attempts: number;
  payloadPreview: string;
  status: "pendiente" | "reprocesado";
  reprocessedBy?: string;
  firstFailedAt: string;
}

const TIPO_TAREA: Record<string, Flujo> = {
  "user-creation": "AM_USER_SIGNUP",
  "application-creation": "AM_APPLICATION_CREATION",
  "application-registration": "AM_APPLICATION_REGISTRATION_PRODUCTION",
  "subscription-creation": "AM_SUBSCRIPTION_CREATION",
};

/** Estado del ensayo de estos guiones (uno por proceso de grabación). */
export class EstadoEnsayoGuiones {
  usuarios = new Map<string, { estado: "pendiente" | "aprobado"; clave: string }>();
  apps = new Map<string, App>();
  tareas: Tarea[] = [];
  sesiones = new Map<string, string>();
  registros = 0;
  fallaDestino = 0;
  dlq: Mensaje[] = [];
  idem = new Map<string, string>();
  uso = new Map<string, number>();
  porSegundo = new Map<string, { s: number; n: number }>();
  exportaciones = new Map<string, Uint8Array>();
  sincronizado = false;

  constructor() {
    for (const [nombre, ck] of [
      ["OperadorDemo", "ck-operadordemo"],
      ["FiscalizacionDemo", "ck-fiscalizacion"],
    ] as const) {
      const id = `app-${nombre.toLowerCase()}`;
      this.apps.set(id, {
        applicationId: id,
        name: nombre,
        owner: "admin",
        status: "APPROVED",
        llave: { consumerKey: ck, consumerSecret: `${ck}-secreto`, aprobada: true },
        subs: new Map([
          [
            "api-concesiones",
            { plan: nombre === "OperadorDemo" ? "Unlimited" : "OperadoresEstandar", aprobada: true },
          ],
        ]),
      });
    }
  }

  tarea(
    workflowType: Flujo,
    properties: Record<string, string>,
    description: string,
    aplicar: () => void,
  ): void {
    this.tareas.push({
      referenceId: randomUUID(),
      workflowType,
      workflowStatus: "CREATED",
      properties,
      description,
      createdTime: new Date().toISOString(),
      aplicar,
    });
  }

  resolver(ref: string, estado: "APPROVED" | "REJECTED"): boolean {
    const t = this.tareas.find((x) => x.referenceId === ref && x.workflowStatus === "CREATED");
    if (!t) return false;
    t.workflowStatus = estado;
    if (estado === "APPROVED") t.aplicar();
    return true;
  }

  appDeLlave(ck: string): App | undefined {
    return [...this.apps.values()].find((a) => a.llave?.consumerKey === ck);
  }
}

let estado = new EstadoEnsayoGuiones();
const envolturas = new WeakSet<object>();

/** Reinicia el estado (pruebas). */
export function reiniciarEstadoEnsayo(): EstadoEnsayoGuiones {
  estado = new EstadoEnsayoGuiones();
  return estado;
}

/**
 * Envuelve el servidor de ensayo del motor con las rutas de estos guiones. Queda por fuera de cualquier otra
 * envoltura (p. ej. la de los guiones D-01..D-05): si otra se instaló después, se vuelve a envolver. Fuera de
 * una grabación de estos guiones (o de las pruebas, con `siempre`), deja pasar todo al servidor de abajo.
 */
export function instalarEnsayoGuiones(o: { siempre?: boolean } = {}): void {
  if (o.siempre) siempreActivo = true;
  const proto = ServidorEnsayo.prototype as unknown as {
    atender(req: IncomingMessage, res: ServerResponse): Promise<void>;
  };
  if (envolturas.has(proto.atender)) return;
  const interior = proto.atender;
  const envoltura = async function (this: unknown, req: IncomingMessage, res: ServerResponse) {
    if (estaActivo()) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await atenderGuiones(req, res, url, () => interior.call(this, req, res))) return;
    }
    return interior.call(this, req, res);
  };
  envolturas.add(envoltura);
  proto.atender = envoltura;
}

// ── Utilidades HTTP ───────────────────────────────────────────────────────────────────────────────────

const json = (res: ServerResponse, status: number, cuerpo: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(JSON.stringify(cuerpo));
  return true;
};
const html = (res: ServerResponse, cuerpo: string, extra: Record<string, string> = {}) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(cuerpo);
  return true;
};
/**
 * Redirección para el navegador del ensayo: una página que navega sola (no un 302). Playwright no desvía con
 * page.route() el destino de un 302 respondido por route.fulfill(), así que un 302 escaparía al laboratorio.
 */
const redirigir = (res: ServerResponse, a: string, extra: Record<string, string> = {}) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-ensayo": "1",
    ...extra,
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>ENSAYO</title><script>location.replace(${JSON.stringify(a)})</script>`,
  );
  return true;
};
const esc = (t: unknown) =>
  String(t ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

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
  if ((req.headers["content-type"] ?? "").includes("json")) {
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(t));
}

/** Sujeto del token de ensayo (JWT sin firma) o usuario de la autenticación básica. */
export function sujeto(req: IncomingMessage): string | undefined {
  const a = String(req.headers.authorization ?? "");
  if (a.startsWith("Basic ")) return Buffer.from(a.slice(6), "base64").toString().split(":")[0];
  if (!a.startsWith("Bearer ")) return undefined;
  try {
    const p = JSON.parse(Buffer.from(a.slice(7).split(".")[1] ?? "", "base64url").toString()) as {
      sub?: string;
      preferred_username?: string;
    };
    return p.preferred_username ?? p.sub;
  } catch {
    return undefined;
  }
}

const cookie = (req: IncomingMessage) => /bt0x_wso2=([^;]+)/.exec(String(req.headers.cookie ?? ""))?.[1];

// ── Enrutador ─────────────────────────────────────────────────────────────────────────────────────────

async function atenderGuiones(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  delegar: () => Promise<void>,
): Promise<boolean> {
  const p = url.pathname;
  const metodo = req.method ?? "GET";
  if (p.startsWith("/bt0x/")) return locales(req, res, url, metodo, p.slice("/bt0x/".length));
  if (p.startsWith("/gateway/")) return gateway(req, res, metodo, p.slice("/gateway".length), delegar);
  if (p.startsWith("/api/v1/")) return consolaApi(req, res, url, metodo, p.slice("/api/v1".length));
  if (p.startsWith("/wso2/api/am/")) return wso2Rest(req, res, url, metodo, p.slice("/wso2/api/am".length));
  if (p.startsWith("/wso2/")) return wso2Paginas(req, res, url, metodo, p.slice("/wso2".length));
  return false;
}

// Destino de BT-008 (concesiones-v1), RabbitMQ (solo lectura) y Jaeger.
async function locales(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  metodo: string,
  resto: string,
): Promise<boolean> {
  const [puerto, ...partes] = resto.split("/");
  const ruta = `/${partes.join("/")}`;
  if (puerto === "7001" && ruta === "/_estadisticas")
    return json(res, 200, { registrosCreados: estado.registros, ensayo: true });
  if (puerto === "7001" && ruta === "/_chaos") {
    if (metodo === "POST") estado.fallaDestino = Number((await cuerpo(req)).failRate ?? 0);
    return json(res, 200, { failRate: estado.fallaDestino, ensayo: true });
  }
  if (puerto === "15672" && ruta.startsWith("/api/queues/")) {
    const cola = decodeURIComponent(ruta.split("/").pop() ?? "");
    const mensajes = cola.endsWith(".dlq") ? estado.dlq.filter((m) => m.status === "pendiente").length : 0;
    return json(res, 200, { name: cola, messages: mensajes, consumers: 1, ensayo: true });
  }
  if (puerto === "16686" && ruta.startsWith("/api/traces/")) {
    return json(res, 200, {
      data: [
        {
          traceID: ruta.split("/").pop(),
          spans: Array.from({ length: 6 }, (_, i) => ({
            spanID: `s${i}`,
            operationName: ["gateway", "validar", "idempotencia", "registro SOAP", "transformar", "publicar"][
              i
            ],
          })),
          processes: {
            p1: { serviceName: "apim-gateway (ensayo)" },
            p2: { serviceName: "micro-integrator (ensayo)" },
          },
        },
      ],
    });
  }
  void url;
  return json(res, 404, { error: "ensayo: ruta local no simulada" });
}

// Gateway: GraphQL, solicitudes de concesión y consumo atribuido (el resto lo atiende el motor).
async function gateway(
  req: IncomingMessage,
  res: ServerResponse,
  metodo: string,
  p: string,
  delegar: () => Promise<void>,
): Promise<boolean> {
  const quien = sujeto(req);
  if (p.startsWith("/graphql/concesiones/1.0.0")) {
    if (!quien)
      return json(res, 401, {
        fault: { code: 900902, message: "Missing Credentials", description: "ensayo: falta el token" },
      });
    const q = String((await cuerpo(req)).query ?? "");
    const desconocido = [...q.matchAll(/\b(campoInexistente)\b/g)][0]?.[1];
    if (desconocido)
      return json(res, 400, {
        fault: {
          code: 900422,
          message: "INVALID QUERY",
          description: `Validation error (ensayo): Field '${desconocido}' in type 'Concesion' is undefined`,
        },
      });
    return json(res, 200, {
      data: {
        totalPorEstado: [
          { estado: "vigente", total: 41 },
          { estado: "en_tramite", total: 7 },
        ],
        concesiones: [
          { id: "CON-000002", empresa: "Operador de ensayo A", servicio: "Internet", estado: "vigente" },
          {
            id: "CON-000009",
            empresa: "Operador de ensayo B",
            servicio: "Telefonía móvil",
            estado: "vigente",
          },
        ],
      },
    });
  }
  if (p.startsWith("/solicitudes/1.0.0")) {
    if (!quien) return json(res, 401, { fault: { message: "Missing Credentials" } });
    const b = await cuerpo(req);
    const clave = String(req.headers["idempotency-key"] ?? "");
    const previa = clave ? estado.idem.get(clave) : undefined;
    if (previa)
      return json(res, 202, { correlacion: previa, estado: "aceptada", repeticion: true, ensayo: true });
    const rut = String(b.rutEmpresa ?? "");
    if (
      !/^\d{1,2}\.\d{3}\.\d{3}-[\dK]$/.test(rut) ||
      typeof b.servicio !== "string" ||
      typeof b.region !== "string"
    )
      return json(res, 422, {
        error: "la solicitud no cumple el esquema EsquemaSolicitud (ensayo)",
        detalle: ["rutEmpresa: formato inválido", "region: obligatorio"],
      });
    const correlacion = `urn:uuid:${randomUUID()}`;
    if (clave) estado.idem.set(clave, correlacion);
    const falla = estado.fallaDestino;
    setTimeout(
      () => {
        if (falla > 0) {
          estado.dlq.push({
            id: correlacion,
            error: "destino respondió 500 (ensayo)",
            attempts: 3,
            payloadPreview: `{"rutEmpresa":"${rut.slice(0, 4)}…","servicio":"${String(b.servicio)}"}`,
            status: "pendiente",
            firstFailedAt: new Date().toISOString(),
          });
        } else estado.registros++;
      },
      falla > 0 ? 9000 : 1500,
    );
    return json(res, 202, { correlacion, estado: "aceptada", ensayo: true });
  }
  if (p.startsWith("/concesiones/1.0.0/")) {
    const app = quien ? estado.appDeLlave(quien) : undefined;
    if (app) {
      const sub = app.subs.get("api-concesiones");
      if (!sub?.aprobada)
        return json(res, 403, {
          fault: {
            code: 900908,
            message: "Resource forbidden",
            description: "ensayo: la aplicación no tiene una suscripción activa",
          },
        });
      const s = Math.floor(Date.now() / 1000);
      const ventana = estado.porSegundo.get(app.name);
      const n = ventana?.s === s ? ventana.n + 1 : 1;
      estado.porSegundo.set(app.name, { s, n });
      if (sub.plan === "OperadoresEstandar" && n > 20)
        return json(res, 429, {
          fault: {
            code: 900800,
            message: "Message throttled out",
            description: "ensayo: plan de 20 por segundo",
          },
        });
      const endpoint = /^\/concesiones\/1\.0\.0\/concesiones\/[^/?]+/.test(p)
        ? "/concesiones/{id}"
        : "/concesiones";
      for (const k of [`consumer:${app.name}`, `endpoint:${endpoint}`])
        estado.uso.set(k, (estado.uso.get(k) ?? 0) + 1);
      if (endpoint === "/concesiones/{id}")
        return json(res, 200, {
          id: "CON-000002",
          empresa: "Operador de ensayo A",
          servicio: "Internet",
          region: "Los Lagos",
          estado: "vigente",
          ensayo: true,
        });
      return json(res, 200, {
        total: 41,
        items: [{ id: "CON-000002", empresa: "Operador de ensayo A" }],
        ensayo: true,
      });
    }
    await delegar();
    return true;
  }
  void metodo;
  return false;
}

// API de la Consola: catálogo, dependencias, mensajes fallidos, consumo, exportación y auditoría.
const FICHAS = APIS.map((a, i) => ({
  id: `asset-${a.name.toLowerCase()}`,
  wso2ApiId: a.id,
  name: a.name,
  version: a.version,
  context: `/${a.context.split("/")[1]}${a.type === "GRAPHQL" ? "/concesiones" : ""}`,
  type: a.type,
  purpose: `Propósito de ensayo de ${a.name}`,
  ownerTeam: "Equipo de ensayo",
  ownerContact: "ensayo@ejemplo.invalid",
  audience: "operadores",
  state: "PUBLISHED",
  authType: "oauth2",
  contractRef: `ensayo:/contratos/${a.name.toLowerCase()}`,
  classification: "publica",
  completeness: i === 0 ? 100 : 90 - i * 5,
  consumers:
    i === 0
      ? [
          { name: "OperadorDemo", plan: "Unlimited" },
          { name: "FiscalizacionDemo", plan: "OperadoresEstandar" },
        ]
      : [],
  dependencies: i === 0 ? [{ from: a.name, to: "concesiones-v1:7001", relation: "llama a" }] : [],
}));

function zipExportacion(): Uint8Array {
  const archivos: Record<string, Uint8Array> = {};
  const items: Array<{ tipo: string; nombre: string; archivo: string; sha256: string }> = [];
  const add = (tipo: string, nombre: string, archivo: string, data: Uint8Array) => {
    archivos[archivo] = data;
    items.push({ tipo, nombre, archivo, sha256: createHash("sha256").update(data).digest("hex") });
  };
  for (const a of APIS.slice(0, 3)) {
    const raiz = `${a.name}-${a.version}`;
    const interno: Record<string, Uint8Array> = {
      [`${raiz}/api.yaml`]: strToU8(
        `type: api\ndata:\n  name: ${a.name}\n  version: ${a.version}\n  context: ${a.context}\n  policies: [Unlimited]\n# ENSAYO\n`,
      ),
    };
    if (a.type === "GRAPHQL") interno[`${raiz}/Definitions/schema.graphql`] = strToU8(SDL_ENSAYO);
    else if (a.type === "WS")
      interno[`${raiz}/Definitions/asyncapi.yaml`] = strToU8(JSON.stringify(ASYNCAPI));
    else
      interno[`${raiz}/Definitions/swagger.yaml`] = strToU8(
        `openapi: 3.0.1\ninfo:\n  title: ${a.name} (ENSAYO)\n  version: ${a.version}\npaths:\n${OPERACIONES.map(([r, m, o]) => `  ${r}:\n    ${m}:\n      operationId: ${o}\n      responses:\n        "200":\n          description: ok`).join("\n")}\n`,
      );
    add("api", `${a.name} ${a.version}`, `apis/${raiz}.zip`, zipSync(interno));
  }
  add(
    "flujo",
    "SolicitudesConcesion",
    "flujos/SolicitudesConcesion.xml",
    strToU8(
      '<api xmlns="http://ws.apache.org/ns/synapse" name="SolicitudesConcesion" context="/solicitudes"><resource methods="POST"/></api>',
    ),
  );
  add("metadatos", "catálogo de APIs", "metadatos/catalogo.json", strToU8(JSON.stringify(FICHAS, null, 1)));
  add(
    "metadatos",
    "grafo de dependencias",
    "metadatos/grafo.json",
    strToU8(JSON.stringify({ nodes: FICHAS.map((f) => ({ id: f.id })), edges: [] })),
  );
  add(
    "configuracion",
    "configuración de la plataforma",
    "configuracion/platform.yaml",
    strToU8(PLATAFORMA_ENSAYO),
  );
  archivos["manifiesto.json"] = strToU8(
    JSON.stringify(
      { version: "ensayo", generadoEn: new Date().toISOString(), origen: "ensayo", items },
      null,
      2,
    ),
  );
  return zipSync(archivos);
}

async function consolaApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  metodo: string,
  p: string,
): Promise<boolean> {
  const quien = sujeto(req) ?? "persona";
  if (p === "/catalog/sync" && metodo === "POST") {
    estado.sincronizado = true;
    return json(res, 200, {
      apis: FICHAS.length,
      consumers: 2,
      subscriptions: 2,
      durationMs: 412,
      ensayo: true,
    });
  }
  if (p === "/apis" && metodo === "GET") return json(res, 200, FICHAS);
  const ficha = /^\/apis\/([^/]+)$/.exec(p);
  if (ficha && metodo === "GET") {
    const f = FICHAS.find((x) => x.id === decodeURIComponent(ficha[1]!));
    return f ? json(res, 200, f) : json(res, 404, { message: "no existe (ensayo)" });
  }
  if (p === "/graph" && metodo === "GET")
    return json(res, 200, {
      nodes: [
        ...FICHAS.map((f) => ({ id: f.id, kind: "api", label: `${f.name} ${f.version}` })),
        { id: "flujo:SolicitudesConcesion", kind: "flujo", label: "SolicitudesConcesion" },
      ],
      edges: [],
    });
  if (p === "/dead-letters" && metodo === "GET")
    return json(
      res,
      200,
      estado.dlq.map((m) => ({ ...m, queue: "solicitudes.dlq", flow: "SolicitudesConcesion" })),
    );
  const rep = /^\/dead-letters\/([^/]+)\/reprocess$/.exec(p);
  if (rep && metodo === "POST") {
    const m = estado.dlq.find((x) => x.id === decodeURIComponent(rep[1]!));
    if (!m || m.status !== "pendiente")
      return json(res, 404, { message: "El mensaje ya no está en la cola de fallidos (ensayo)" });
    m.status = "reprocesado";
    m.reprocessedBy = quien;
    setTimeout(() => (estado.fallaDestino > 0 ? undefined : estado.registros++), 2000);
    return json(res, 200, { id: m.id, queue: "solicitudes.dlq", status: m.status, reprocessedBy: quien });
  }
  if (p === "/usage" && metodo === "GET") {
    const g = url.searchParams.get("groupBy") === "endpoint" ? "endpoint" : "consumer";
    const filas = [...estado.uso.entries()]
      .filter(([k]) => k.startsWith(`${g}:`))
      .map(([k, n]) => ({
        key: k.slice(g.length + 1),
        label: k.slice(g.length + 1),
        llamadas: n,
        errores: 0,
      }));
    return json(res, 200, filas);
  }
  if (p === "/usage/export" && metodo === "GET") {
    const csv = [
      "tipo,clave,llamadas,errores",
      ...[...estado.uso.entries()].map(
        ([k, n]) =>
          `${k.split(":")[0] === "consumer" ? "consumidor" : "endpoint"},${k.slice(k.indexOf(":") + 1)},${n},0`,
      ),
    ].join("\n");
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="consumo.csv"',
      "x-ensayo": "1",
    });
    res.end(`${csv}\n`);
    return true;
  }
  if (p === "/exports" && metodo === "POST") {
    const id = `exp-${randomUUID().slice(0, 8)}`;
    estado.exportaciones.set(id, zipExportacion());
    return json(res, 201, {
      id,
      status: "listo",
      downloadUrl: `/api/v1/exports/${id}/download`,
      ensayo: true,
    });
  }
  const exp = /^\/exports\/([^/]+)(\/download)?$/.exec(p);
  if (exp && metodo === "GET") {
    const z = estado.exportaciones.get(exp[1]!);
    if (!z) return json(res, 404, { message: "no existe (ensayo)" });
    if (!exp[2])
      return json(res, 200, {
        id: exp[1],
        status: "listo",
        downloadUrl: `/api/v1/exports/${exp[1]}/download`,
      });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="nexo-export-${exp[1]}.zip"`,
      "x-ensayo": "1",
    });
    res.end(Buffer.from(z));
    return true;
  }
  if (p === "/audit-events" && metodo === "GET") {
    let previo = "0".repeat(64);
    const eventos = Array.from({ length: 24 }, (_, i) => {
      const hash = createHash("sha256").update(`${previo}|${i}`).digest("hex");
      const e = {
        seq: i + 1,
        action: ["exportacion.generar", "catalogo.sincronizar", "mensajes.reprocesar"][i % 3],
        actor: "persona.ensayo",
        prevHash: previo,
        hash,
        ensayo: true,
      };
      previo = hash;
      return e;
    });
    return json(res, 200, eventos);
  }
  if (p === "/audit-events/verify" && metodo === "GET")
    return json(res, 200, { ok: true, checked: 24, ensayo: true });
  return false;
}

// REST de WSO2 (Dev Portal, Publisher y Admin) que usan estos guiones.
function sdkZip(lenguaje: string): Uint8Array {
  const clase: Record<string, [string, (o: string) => string]> = {
    java: ["src/main/java/cl/yago/nexo/client/api/ConcesionesApi.java", (o) => o],
    android: ["src/main/java/cl/yago/nexo/client/api/ConcesionesApi.java", (o) => o],
    javascript: ["src/api/ConcesionesApi.js", (o) => o],
    python: [
      "swagger_client/api/concesiones_api.py",
      (o) => o.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
    ],
    csharp: ["src/IO.Swagger/Api/ConcesionesApi.cs", (o) => o.charAt(0).toUpperCase() + o.slice(1)],
  };
  const [ruta, nombre] = clase[lenguaje] ?? ["README.md", (o: string) => o];
  const raiz = `concesiones-sdk-${lenguaje}`;
  const archivos: Record<string, Uint8Array> = {
    [`${raiz}/${ruta}`]: strToU8(
      `// ENSAYO: SDK simulado\n${OPERACIONES.map(([, , o]) => `function ${nombre(o)}() {}`).join("\n")}\n`,
    ),
  };
  for (let i = 0; i < 14; i++) archivos[`${raiz}/docs/Modelo${i}.md`] = strToU8(`# Modelo ${i} (ensayo)\n`);
  archivos[`${raiz}/README.md`] = strToU8("# SDK de ensayo\n");
  return zipSync(archivos);
}

const appsDe = (u: string) =>
  [...estado.apps.values()].filter((a) => a.owner === u || (u === "admin" && a.owner === "admin"));
const appJson = (a: App) => ({
  applicationId: a.applicationId,
  name: a.name,
  throttlingPolicy: "Unlimited",
  status: a.status,
  owner: a.owner,
});

async function wso2Rest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  metodo: string,
  p: string,
): Promise<boolean> {
  const quien = sujeto(req) ?? "admin";
  // Dev Portal
  if (p === "/devportal/v3/apis" && metodo === "GET")
    return json(res, 200, {
      count: APIS.length,
      list: APIS.map((a) => ({ ...a, lifeCycleStatus: "PUBLISHED" })),
    });
  let m = /^\/devportal\/v3\/apis\/([^/]+)\/(swagger|graphql-schema)$/.exec(p);
  if (m && metodo === "GET") {
    if (m[2] === "graphql-schema") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-ensayo": "1" });
      res.end(SDL_ENSAYO);
      return true;
    }
    if (m[1] === "api-eventos") return json(res, 200, ASYNCAPI);
    return json(res, 200, {
      openapi: "3.0.1",
      info: { title: "Concesiones (ensayo)", version: "1.0.0" },
      paths: Object.fromEntries(
        OPERACIONES.map(([r]) => [
          r,
          Object.fromEntries(
            OPERACIONES.filter((o) => o[0] === r).map(([, mm, o]) => [mm, { operationId: o }]),
          ),
        ]),
      ),
    });
  }
  if (p === "/devportal/v3/sdk-gen/languages")
    return json(res, 200, ["java", "javascript", "python", "csharp", "android"]);
  m = /^\/devportal\/v3\/apis\/([^/]+)\/sdks\/([a-z]+)$/.exec(p);
  if (m) {
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="concesiones-sdk-${m[2]}.zip"`,
      "x-ensayo": "1",
    });
    res.end(Buffer.from(sdkZip(m[2]!)));
    return true;
  }
  if (p === "/devportal/v3/applications" && metodo === "GET")
    return json(res, 200, { count: appsDe(quien).length, list: appsDe(quien).map(appJson) });
  if (p === "/devportal/v3/applications" && metodo === "POST") {
    const b = await cuerpo(req);
    return json(res, 201, appJson(crearApp(String(b.name ?? "app"), quien)));
  }
  m = /^\/devportal\/v3\/applications\/([^/]+)(\/(oauth-keys|generate-keys))?$/.exec(p);
  if (m) {
    const a = estado.apps.get(m[1]!);
    if (!a) return json(res, 404, { message: "no existe (ensayo)" });
    if (!m[2] && metodo === "DELETE") {
      estado.apps.delete(a.applicationId);
      res.writeHead(200).end();
      return true;
    }
    if (m[3] === "oauth-keys")
      return json(res, 200, {
        count: a.llave?.aprobada ? 1 : 0,
        list: a.llave?.aprobada ? [{ keyManager: "Keycloak", keyType: "PRODUCTION", ...a.llave }] : [],
      });
    if (m[3] === "generate-keys") return json(res, 200, pedirLlaves(a));
    return json(res, 200, appJson(a));
  }
  if (p === "/devportal/v3/subscriptions" && metodo === "GET") {
    const a = estado.apps.get(url.searchParams.get("applicationId") ?? "");
    const list = a
      ? [...a.subs.entries()].map(([apiId, s]) => ({
          apiId,
          apiInfo: { id: apiId },
          throttlingPolicy: s.plan,
          status: s.aprobada ? "UNBLOCKED" : "ON_HOLD",
        }))
      : [];
    return json(res, 200, { count: list.length, list });
  }
  if (p === "/devportal/v3/subscriptions" && metodo === "POST") {
    const b = await cuerpo(req);
    const a = estado.apps.get(String(b.applicationId ?? ""));
    if (!a) return json(res, 404, { message: "no existe (ensayo)" });
    pedirSuscripcion(a, String(b.apiId ?? "api-concesiones"), String(b.throttlingPolicy ?? "Unlimited"));
    return json(res, 201, { applicationId: a.applicationId, apiId: b.apiId, status: "ON_HOLD" });
  }
  // Publisher
  m = /^\/publisher\/v4\/apis\/([^/]+)(\/(graphql-schema|asyncapi))?$/.exec(p);
  if (m && metodo === "GET") {
    const a = APIS.find((x) => x.id === m![1]);
    if (!a) return json(res, 404, { message: "no existe (ensayo)" });
    if (m[3] === "graphql-schema") return json(res, 200, { name: a.name, schemaDefinition: SDL_ENSAYO });
    if (m[3] === "asyncapi") return json(res, 200, ASYNCAPI);
    const f = FICHAS.find((x) => x.wso2ApiId === a.id)!;
    return json(res, 200, {
      ...a,
      context: f.context,
      lifeCycleStatus: "PUBLISHED",
      policies: a.type === "GRAPHQL" ? ["Interno", "Unlimited"] : ["OperadoresEstandar", "Unlimited"],
      securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
      businessInformation: { businessOwner: f.ownerTeam, businessOwnerEmail: f.ownerContact },
      additionalProperties: [
        { name: "contrato", value: f.contractRef },
        { name: "proposito", value: f.purpose },
      ],
      operations:
        a.type === "GRAPHQL"
          ? ["concesiones", "concesion", "totalPorEstado"].map((t) => ({
              target: t,
              verb: "QUERY",
              throttlingPolicy: "Unlimited",
            }))
          : [],
    });
  }
  if (p === "/publisher/v4/subscriptions" && metodo === "GET") {
    const apiId = url.searchParams.get("apiId") ?? "";
    const list = [...estado.apps.values()]
      .filter((a) => a.subs.get(apiId)?.aprobada)
      .map((a) => ({ applicationInfo: { name: a.name }, subscriptionStatus: "UNBLOCKED" }));
    return json(res, 200, { count: list.length, list });
  }
  // Admin
  if (p === "/admin/v4/workflows" && metodo === "GET") {
    const tipo = url.searchParams.get("workflowType");
    const list = estado.tareas
      .filter((t) => t.workflowStatus === "CREATED" && (!tipo || t.workflowType === tipo))
      .map(({ aplicar: _a, ...t }) => t);
    return json(res, 200, { count: list.length, list });
  }
  if (p === "/admin/v4/workflows/update-workflow-status" && metodo === "POST") {
    const b = await cuerpo(req);
    const ok = estado.resolver(
      url.searchParams.get("workflowReferenceId") ?? "",
      b.status === "REJECTED" ? "REJECTED" : "APPROVED",
    );
    return json(res, ok ? 200 : 404, { ok });
  }
  if (p === "/admin/v4/throttling/policies/subscription")
    return json(res, 200, {
      count: 4,
      list: [
        {
          policyName: "OperadoresEstandar",
          billingPlan: "FREE",
          defaultLimit: { requestCount: { requestCount: 20, timeUnit: "sec" } },
        },
        {
          policyName: "Interno",
          billingPlan: "FREE",
          defaultLimit: { requestCount: { requestCount: 200, timeUnit: "sec" } },
        },
        {
          policyName: "PublicoBasico",
          billingPlan: "FREE",
          defaultLimit: { requestCount: { requestCount: 5, timeUnit: "sec" } },
        },
        {
          policyName: "Unlimited",
          billingPlan: "FREE",
          defaultLimit: { requestCount: { requestCount: 2147483647, timeUnit: "min" } },
        },
      ],
    });
  return false;
}

function crearApp(nombre: string, duenio: string): App {
  const a: App = {
    applicationId: `app-${randomUUID().slice(0, 8)}`,
    name: nombre,
    owner: duenio,
    status: "CREATED",
    subs: new Map(),
  };
  estado.apps.set(a.applicationId, a);
  estado.tarea(
    "AM_APPLICATION_CREATION",
    { applicationName: nombre, userName: duenio },
    `Creación de la aplicación ${nombre}`,
    () => (a.status = "APPROVED"),
  );
  return a;
}
function pedirLlaves(a: App) {
  if (!a.llave) {
    a.llave = {
      consumerKey: `ck-${a.applicationId}`,
      consumerSecret: `cs-${a.applicationId}`,
      aprobada: false,
    };
    estado.tarea(
      "AM_APPLICATION_REGISTRATION_PRODUCTION",
      { applicationName: a.name, keyType: "PRODUCTION" },
      `Credenciales de producción de ${a.name}`,
      () => (a.llave!.aprobada = true),
    );
  }
  return {
    keyState: a.llave.aprobada ? "COMPLETED" : "CREATED",
    keyManager: "Keycloak",
    keyType: "PRODUCTION",
  };
}
function pedirSuscripcion(a: App, apiId: string, plan: string) {
  if (a.subs.has(apiId)) return;
  const s = { plan, aprobada: false };
  a.subs.set(apiId, s);
  estado.tarea(
    "AM_SUBSCRIPTION_CREATION",
    {
      applicationName: a.name,
      apiName: APIS.find((x) => x.id === apiId)?.name ?? apiId,
      throttlingPolicy: plan,
    },
    `Suscripción de ${a.name}`,
    () => (s.aprobada = true),
  );
}

// ── Páginas de los portales de WSO2 (ensayo) ──────────────────────────────────────────────────────────

const PORTAL = (
  nombre: string,
  cuerpoHtml: string,
  usuario?: string,
  portal = "devportal",
) => `<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><title>WSO2 ${esc(nombre)} · ENSAYO</title>
<style>
 body{margin:0;font:15px/1.45 "Liberation Sans","DejaVu Sans",Arial,sans-serif;color:#1f2933;background:#f4f6f8}
 header{display:flex;align-items:center;gap:18px;background:#1d2733;color:#fff;padding:12px 24px}
 header b{font-size:18px} header .esp{flex:1} header a{color:#ffb15c;text-decoration:none;font-weight:bold}
 .ensayo{position:fixed;top:0;right:0;background:#c62828;color:#fff;font:bold 12px/1 Arial;letter-spacing:.14em;padding:6px 12px;border-bottom-left-radius:8px;z-index:10;animation:latido 2s ease-in-out infinite}
 @keyframes latido{50%{opacity:.8}}
 main{display:flex;gap:20px;padding:22px 26px} nav{width:200px;display:flex;flex-direction:column;gap:6px} nav a{color:#1d4f91;text-decoration:none;padding:6px 8px;border-radius:4px} nav a:hover{background:#e3ebf5}
 .contenido{flex:1;max-width:1000px} .tarjeta{background:#fff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12);padding:18px 22px;margin-bottom:16px}
 table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #e1e5ea;padding:8px 10px;text-align:left}
 button,.boton{background:#ff7300;color:#fff;border:0;border-radius:4px;padding:8px 14px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
 button.sec{background:#5c6b7a} .chip{display:inline-block;background:#e3ebf5;color:#1d4f91;border-radius:10px;padding:2px 10px;font-size:13px}
 .aviso{background:#fff4e5;border-left:4px solid #ff7300;padding:10px 14px;margin:10px 0} .bien{background:#e8f5e9;border-left-color:#2e7d32}
 pre{background:#0f1720;color:#cfe3ff;padding:14px;border-radius:6px;font-size:13px;overflow:auto}
 label{display:block;margin:12px 0 4px;color:#3e4c59} input,textarea{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #b8c2cc;border-radius:4px;font-size:15px}
 .tarjetas{display:grid;grid-template-columns:repeat(3,1fr);gap:14px} .tarjetas .tarjeta{margin:0}
 [role=dialog]{position:fixed;inset:12% 18% auto 18%;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.35);border-radius:8px;padding:20px 24px;z-index:20}
 [role=listbox]{position:absolute;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.25);list-style:none;margin:4px 0;padding:4px 0;z-index:30} [role=option]{padding:8px 16px;cursor:pointer} [role=option]:hover{background:#e3ebf5}
 #policy-select{border:1px solid #b8c2cc;border-radius:4px;padding:6px 12px;cursor:pointer;min-width:190px;display:inline-block}
</style></head><body><div class="ensayo">ENSAYO</div><header><b>WSO2 ${esc(nombre)}</b><span class="chip">simulado</span><span class="esp"></span>${
  usuario
    ? `<span>${esc(usuario)}</span><a href="/bt0x-salir?portal=${portal}">Cerrar sesión</a>`
    : `<a href="/authenticationendpoint/login.do?portal=${portal}">REGISTRARSE</a>`
}</header>${cuerpoHtml}</body></html>`;

const NAV_DEVPORTAL = `<nav><a href="/devportal/apis">APIs</a><a href="/devportal/applications">Aplicaciones</a></nav>`;

function listaApis(): string {
  return `<div class="contenido"><h2>APIs publicadas</h2><div class="tarjetas">${APIS.map(
    (a) =>
      `<div class="tarjeta"><a href="/devportal/apis/${a.id}/overview" style="font-size:18px;color:#1d4f91;text-decoration:none">${a.name}</a><p><span class="chip">${a.type}</span> ${a.version}</p><small>${a.context}</small></div>`,
  ).join("")}</div></div>`;
}

function paginaApi(id: string, vista: string): string {
  const a = APIS.find((x) => x.id === id) ?? APIS[0]!;
  const menu = `<nav><a href="/devportal/apis/${a.id}/overview">Resumen</a><a href="/devportal/apis/${a.id}/api-console">Probar</a><a href="/devportal/apis/${a.id}/definition">Definición</a><a href="/devportal/apis/${a.id}/sdk">SDK</a></nav>`;
  let cuerpoHtml = `<div class="tarjeta"><h2>${a.name} <span class="chip">${a.type}</span></h2><p>Versión ${a.version} · contexto ${a.context} · estado PUBLISHED</p></div>`;
  if (vista === "overview" && a.type === "GRAPHQL")
    cuerpoHtml += `<div class="tarjeta"><h3>Esquema GraphQL</h3><pre>${esc(SDL_ENSAYO)}</pre></div>`;
  if (vista === "definition")
    cuerpoHtml += `<div class="tarjeta"><h3>Operations · Channels (AsyncAPI ${ASYNCAPI.asyncapi})</h3><pre>${esc(JSON.stringify(ASYNCAPI, null, 2))}</pre></div>`;
  if (vista === "api-console")
    cuerpoHtml += `<div class="tarjeta"><h3>Consola de la API (OpenAPI)</h3><table>${OPERACIONES.map(([r, m, o]) => `<tr><td><span class="chip">${m.toUpperCase()}</span></td><td>${r}</td><td>${o}</td></tr>`).join("")}</table></div>`;
  if (vista === "sdk")
    cuerpoHtml += `<div class="tarjetas">${["java", "javascript", "python", "csharp", "android"]
      .map(
        (l) =>
          `<div class="tarjeta"><b>${l.toUpperCase()}</b><p><a class="boton" href="#" data-sdk="${l}">Download</a></p></div>`,
      )
      .join("")}</div>
      <script>
      // Como el Dev Portal: el SDK se pide por la REST API y se descarga como blob.
      document.querySelectorAll("[data-sdk]").forEach((b) => (b.onclick = async (e) => {
        e.preventDefault();
        const r = await fetch("/api/am/devportal/v3/apis/${a.id}/sdks/" + b.dataset.sdk);
        const url = URL.createObjectURL(await r.blob());
        const x = document.createElement("a");
        x.href = url; x.download = "concesiones-sdk-" + b.dataset.sdk + ".zip"; document.body.appendChild(x); x.click(); x.remove();
      }));
      </script>`;
  return `<main>${menu}<div class="contenido">${cuerpoHtml}</div></main>`;
}

function paginaApp(a: App): string {
  const llave = a.llave;
  const panel = !llave
    ? `<button id="generate-keys">Generate Keys</button>`
    : llave.aprobada
      ? `<div class="aviso bien"><b>Consumer Key</b>: <code>${esc(llave.consumerKey)}</code><br><b>Consumer Secret</b>: <code>••••••••</code></div>`
      : `<div class="aviso">Pending approval: la solicitud de credenciales espera la aprobación de la institución.</div>`;
  const sub = a.subs.get("api-concesiones");
  return `<main><nav><a href="#" id="production-keys">Production Keys</a><a href="#" id="left-menu-subscriptions">Suscripciones</a></nav><div class="contenido">
    <div class="tarjeta"><h2>${esc(a.name)}</h2><p>Estado: ${a.status === "APPROVED" ? "aprobada" : "en espera de la aprobación"}</p></div>
    <div class="tarjeta" id="llaves"><h3>Llaves de producción</h3><p><button id="Keycloak" class="sec">Keycloak</button></p><div id="panel-keycloak" style="display:none">${panel}</div></div>
    <div class="tarjeta" id="suscripciones" style="display:none"><h3>Suscripciones</h3><p>${sub ? `Concesiones · plan ${esc(sub.plan)} · ${sub.aprobada ? "activa" : "ON_HOLD (pendiente)"}` : "Sin suscripciones."}</p><button id="abrir-suscribir">Subscribe APIs</button></div>
    <div role="dialog" id="dialogo" style="display:none"><h3>Suscribir APIs</h3><table><tr><td>Concesiones</td><td><span id="policy-select">Unlimited</span></td><td><button id="policy-subscribe-btn-api-concesiones">Subscribe</button></td></tr></table></div>
  </div></main><script>
  const $=(s)=>document.querySelector(s);
  $("#production-keys").onclick=(e)=>{e.preventDefault();$("#llaves").scrollIntoView();};
  $("#Keycloak").onclick=()=>{$("#panel-keycloak").style.display="block";};
  const g=$("#generate-keys"); if(g) g.onclick=async()=>{await fetch("/bt0x-llaves?app=${a.applicationId}",{method:"POST"});$("#panel-keycloak").innerHTML='<div class="aviso">Pending approval: la solicitud de credenciales espera la aprobación de la institución.</div>';};
  $("#left-menu-subscriptions").onclick=(e)=>{e.preventDefault();$("#suscripciones").style.display="block";};
  $("#abrir-suscribir").onclick=()=>{$("#dialogo").style.display="block";};
  let plan="Unlimited";
  $("#policy-select").onclick=()=>{const ul=document.createElement("ul");ul.setAttribute("role","listbox");for(const p of ["Unlimited","OperadoresEstandar","Interno"]){const li=document.createElement("li");li.setAttribute("role","option");li.textContent=p;li.onclick=()=>{plan=p;$("#policy-select").textContent=p;ul.remove();};ul.appendChild(li);}$("#policy-select").after(ul);};
  $("#policy-subscribe-btn-api-concesiones").onclick=async(e)=>{await fetch("/bt0x-suscribir?app=${a.applicationId}&plan="+encodeURIComponent(plan),{method:"POST"});e.target.textContent="Suscripción solicitada";};
  document.addEventListener("keydown",(e)=>{if(e.key==="Escape")$("#dialogo").style.display="none";});
  </script>`;
}

function paginaTareas(tipo: string): string {
  const flujo = TIPO_TAREA[tipo];
  const filas = estado.tareas
    .filter((t) => t.workflowStatus === "CREATED" && t.workflowType === flujo)
    .map(
      (t) =>
        `<tr><td>${esc(t.properties.tenantAwareUserName ?? t.properties.applicationName ?? "")}</td><td>${esc(t.description)}</td><td>${esc(t.createdTime.slice(11, 19))}</td><td><button onclick="resolver('${t.referenceId}','APPROVED')">Approve</button> <button class="sec" onclick="resolver('${t.referenceId}','REJECTED')">Reject</button></td></tr>`,
    )
    .join("");
  const menu = Object.keys(TIPO_TAREA)
    .map((k) => `<a href="/admin/tasks/${k}">${k}</a>`)
    .join("");
  return `<main><nav><b>Tareas</b>${menu}</nav><div class="contenido"><div class="tarjeta"><h2>Tareas pendientes · ${esc(tipo)}</h2><table><thead><tr><th>Solicitante</th><th>Descripción</th><th>Hora</th><th>Acción</th></tr></thead><tbody>${
    filas || '<tr><td colspan="4">No hay tareas pendientes.</td></tr>'
  }</tbody></table></div></div></main><script>async function resolver(r,s){await fetch("/bt0x-resolver?ref="+r+"&estado="+s,{method:"POST"});location.reload();}</script>`;
}

const LOGIN = (portal: string, error = "") =>
  PORTAL(
    "Identity",
    `<main><div class="contenido" style="max-width:440px;margin:6vh auto"><div class="tarjeta"><h2>Iniciar sesión</h2>${error ? `<div class="aviso">${esc(error)}</div>` : ""}<form method="post" action="/commonauth?portal=${esc(portal)}">
      <label for="username">Usuario</label><input id="username" name="username" autocomplete="off"><label for="password">Contraseña</label><input id="password" name="password" type="password">
      <p><button type="submit">Continuar</button></p></form><p>¿No tiene cuenta? <a href="/accountrecoveryendpoint/register.do?portal=${esc(portal)}">Create Account</a></p></div></div></main>`,
  ).replace(/<a href="\/authenticationendpoint[^"]*">REGISTRARSE<\/a>/, "");

async function wso2Paginas(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  metodo: string,
  p: string,
): Promise<boolean> {
  const sid = cookie(req);
  const usuario = sid ? estado.sesiones.get(sid) : undefined;
  if (p.startsWith("/authenticationendpoint/login.do"))
    return html(res, LOGIN(url.searchParams.get("portal") ?? "publisher"));
  if (p === "/commonauth" && metodo === "POST") {
    const b = await cuerpo(req);
    const portal = url.searchParams.get("portal") ?? "publisher";
    const u = String(b.username ?? "");
    const conocido = u === "admin" || estado.usuarios.has(u);
    if (!conocido) return html(res, LOGIN(portal, "Usuario o contraseña incorrectos (ensayo)."));
    const nuevo = `b${randomUUID().slice(0, 12)}`;
    estado.sesiones.set(nuevo, u);
    return redirigir(res, `/${portal}/${portal === "admin" ? "" : "apis"}`, {
      "set-cookie": `bt0x_wso2=${nuevo}; Path=/; HttpOnly`,
    });
  }
  if (p === "/bt0x-salir") {
    if (sid) estado.sesiones.delete(sid);
    return redirigir(res, `/${url.searchParams.get("portal") ?? "devportal"}/apis`, {
      "set-cookie": "bt0x_wso2=; Path=/; Max-Age=0",
    });
  }
  if (p.startsWith("/accountrecoveryendpoint/register.do")) {
    const b = metodo === "POST" ? await cuerpo(req) : {};
    if (metodo === "POST" && b.paso === "datos") {
      const u = String(b.username ?? "");
      estado.usuarios.set(u, { estado: "pendiente", clave: String(b.password ?? "") });
      estado.tarea(
        "AM_USER_SIGNUP",
        { tenantAwareUserName: u, organizacion: String(b["http://wso2.org/claims/organization"] ?? "") },
        `Registro de ${u} (${String(b.email ?? "")})`,
        () => (estado.usuarios.get(u)!.estado = "aprobado"),
      );
      return html(
        res,
        PORTAL(
          "Identity",
          `<main><div class="contenido" style="max-width:520px;margin:6vh auto"><div class="tarjeta"><h2>Registration completed successfully</h2><p>Registro completado. La cuenta ${esc(u)} queda pendiente de la aprobación de la institución.</p></div></div></main>`,
        ),
      );
    }
    if (metodo === "POST") {
      const u = String(b.username ?? "");
      return html(
        res,
        PORTAL(
          "Identity",
          `<main><div class="contenido" style="max-width:560px;margin:3vh auto"><div class="tarjeta"><h2>Crear cuenta · ${esc(u)}</h2><form method="post"><input type="hidden" name="paso" value="datos"><input type="hidden" name="username" value="${esc(u)}">
           <label for="firstname">Nombre</label><input id="firstname" name="firstname"><label for="lastname">Apellido</label><input id="lastname" name="lastname">
           <label for="password">Contraseña</label><input id="password" name="password" type="password"><label for="password2">Repita la contraseña</label><input id="password2" name="password2" type="password">
           <label for="email">Correo</label><input id="email" name="email"><label for="org">Organización</label><input id="org" name="http://wso2.org/claims/organization">
           <p style="margin-top:18px"><input type="checkbox" id="termsCheckbox" style="width:auto"> Acepto los términos de uso</p><p><button id="registrationSubmit" type="submit">Register</button></p></form></div></div></main>`,
        ),
      );
    }
    return html(
      res,
      PORTAL(
        "Identity",
        `<main><div class="contenido" style="max-width:440px;margin:6vh auto"><div class="tarjeta"><h2>Create Account</h2><form method="post"><label for="username">Usuario</label><input id="username" name="username" autocomplete="off"><p><button id="registrationSubmit" type="submit">Proceed to Self Register</button></p></form></div></div></main>`,
      ),
    );
  }
  if (p === "/bt0x-resolver" && metodo === "POST")
    return json(res, 200, {
      ok: estado.resolver(
        url.searchParams.get("ref") ?? "",
        url.searchParams.get("estado") === "REJECTED" ? "REJECTED" : "APPROVED",
      ),
    });
  if (p === "/bt0x-llaves" && metodo === "POST") {
    const a = estado.apps.get(url.searchParams.get("app") ?? "");
    return a ? json(res, 200, pedirLlaves(a)) : json(res, 404, {});
  }
  if (p === "/bt0x-suscribir" && metodo === "POST") {
    const a = estado.apps.get(url.searchParams.get("app") ?? "");
    if (a) pedirSuscripcion(a, "api-concesiones", url.searchParams.get("plan") ?? "Unlimited");
    return json(res, a ? 200 : 404, {});
  }
  if (p === "/bt0x-crear-app" && metodo === "POST") {
    const b = await cuerpo(req);
    if (!usuario) return json(res, 401, {});
    return json(res, 201, appJson(crearApp(String(b.name ?? "app"), usuario)));
  }
  const m = /^\/(publisher|devportal|admin)(\/.*)?$/.exec(p);
  if (!m) return false;
  const portal = m[1]!;
  const resto = m[2] ?? "/";
  if (!usuario && portal !== "devportal")
    return redirigir(res, `/authenticationendpoint/login.do?portal=${portal}`);
  if (portal === "devportal" && usuario && estado.usuarios.get(usuario)?.estado === "pendiente")
    return html(
      res,
      PORTAL(
        "Developer Portal",
        `<main><div class="contenido"><div class="tarjeta"><h2>Error 403 · Forbidden</h2><p>No tiene privilegios suficientes para entrar al portal: su registro espera la aprobación de la institución.</p></div></div></main>`,
        usuario,
      ),
    );
  if (portal === "admin") {
    const t = /^\/tasks\/([a-z-]+)/.exec(resto);
    return html(
      res,
      PORTAL(
        "Admin Portal",
        t
          ? paginaTareas(t[1]!)
          : `<main><nav><b>Tareas</b>${Object.keys(TIPO_TAREA)
              .map((k) => `<a href="/admin/tasks/${k}">${k}</a>`)
              .join(
                "",
              )}</nav><div class="contenido"><div class="tarjeta"><h2>Admin Portal</h2></div></div></main>`,
        usuario,
        portal,
      ),
    );
  }
  if (portal === "publisher") {
    const a = /^\/apis\/([^/]+)/.exec(resto);
    const api = APIS.find((x) => x.id === a?.[1]);
    const f = api ? FICHAS.find((x) => x.wso2ApiId === api.id) : undefined;
    return html(
      res,
      PORTAL(
        "Publisher",
        api && f
          ? `<main><nav><a href="/publisher/apis">APIs</a></nav><div class="contenido"><div class="tarjeta"><h2>${api.name} ${api.version} <span class="chip">PUBLISHED</span></h2><table><tr><td>Contexto</td><td>${f.context}</td></tr><tr><td>Propietario</td><td>${f.ownerTeam} &lt;${f.ownerContact}&gt;</td></tr><tr><td>Seguridad</td><td>oauth2</td></tr><tr><td>Contrato</td><td>${f.contractRef}</td></tr></table></div></div></main>`
          : `<main><div class="contenido">${listaApis().replaceAll("/devportal/apis/", "/publisher/apis/")}</div></main>`,
        usuario,
        portal,
      ),
    );
  }
  // Dev Portal
  if (resto === "/apis" || resto === "/")
    return html(res, PORTAL("Developer Portal", `<main>${NAV_DEVPORTAL}${listaApis()}</main>`, usuario));
  const api = /^\/apis\/([^/]+)\/([a-z-]+)/.exec(resto);
  if (api) return html(res, PORTAL("Developer Portal", paginaApi(api[1]!, api[2]!), usuario));
  if (resto === "/applications/create")
    return html(
      res,
      PORTAL(
        "Developer Portal",
        `<main>${NAV_DEVPORTAL}<div class="contenido"><div class="tarjeta"><h2>Crear aplicación</h2><label for="application-name">Nombre</label><input id="application-name"><label for="application-description">Descripción</label><textarea id="application-description"></textarea><p><button id="itest-application-create-save">Guardar</button></p><div id="resultado"></div></div></div></main>
         <script>document.getElementById("itest-application-create-save").onclick=async()=>{await fetch("/bt0x-crear-app",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:document.getElementById("application-name").value})});document.getElementById("resultado").innerHTML='<div class="aviso">La aplicación quedó en espera de la aprobación de la institución.</div>';};</script>`,
        usuario,
      ),
    );
  if (resto === "/applications") {
    const filas = usuario
      ? appsDe(usuario)
          .map(
            (a) =>
              `<tr><td><a href="/devportal/applications/${a.applicationId}/overview">${esc(a.name)}</a></td><td>${a.status}</td></tr>`,
          )
          .join("")
      : "";
    return html(
      res,
      PORTAL(
        "Developer Portal",
        `<main>${NAV_DEVPORTAL}<div class="contenido"><div class="tarjeta"><h2>Aplicaciones</h2><table>${filas || "<tr><td>Sin aplicaciones.</td></tr>"}</table></div></div></main>`,
        usuario,
      ),
    );
  }
  const app = /^\/applications\/([^/]+)/.exec(resto);
  if (app) {
    const a = estado.apps.get(app[1]!);
    return html(
      res,
      PORTAL("Developer Portal", a ? paginaApp(a) : "<main><p>No existe.</p></main>", usuario),
    );
  }
  return html(res, PORTAL("Developer Portal", `<main>${NAV_DEVPORTAL}${listaApis()}</main>`, usuario));
}

function paginaJaeger(traza: string): string {
  const tramos = [
    "apim-gateway · POST /solicitudes",
    "micro-integrator · validar esquema",
    "micro-integrator · idempotencia",
    "micro-integrator · RegistroOperadores (SOAP 1.2)",
    "micro-integrator · transformar",
    "micro-integrator · publicar en cola",
  ];
  return `<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><title>Jaeger · ENSAYO</title><style>body{margin:0;font:14px/1.4 Arial,sans-serif;background:#fff;color:#222}header{background:#1b1b1b;color:#fff;padding:12px 20px;font-weight:bold}
  .ensayo{position:fixed;top:0;right:0;background:#c62828;color:#fff;font:bold 12px Arial;letter-spacing:.14em;padding:6px 12px;animation:latido 2s ease-in-out infinite}@keyframes latido{50%{opacity:.8}}.fila{display:flex;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid #eee}.fila span{width:380px}.barra{height:14px;background:#5a8dee;border-radius:3px}</style></head>
  <body><div class="ensayo">ENSAYO</div><header>Jaeger UI (simulado) · traza ${esc(traza.slice(0, 16))}…</header>${tramos
    .map(
      (t, i) =>
        `<div class="fila"><span>${esc(t)}</span><div class="barra" style="margin-left:${i * 40}px;width:${420 - i * 50}px"></div></div>`,
    )
    .join("")}</body></html>`;
}
