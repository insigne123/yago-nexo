/**
 * Backends de ejemplo del laboratorio Nexo (datos sintéticos, BT-056).
 *
 * Modos (variable MODE):
 *  - "concesiones": API REST de concesiones de telecomunicaciones. VERSION y FAIL_RATE permiten
 *    simular una versión estable y una versión defectuosa para la demo de despliegue canary (D-04).
 *  - "registro": servicio SOAP 1.2 estilo PISEE (consulta de operadores por RUT) con su WSDL (BT-010/011).
 *  - "ocultas": APIs no gobernadas, expuestas por NGINX o APISIX "actuales", para la demo de descubrimiento (D-01).
 *  - "graphql": API GraphQL de concesiones (D-06).
 *  - "eventos": eventos de red y de concesiones por WebSocket, descritos con AsyncAPI (D-06).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildSchema, graphql } from "graphql";
import { WebSocketServer, WebSocket } from "ws";
import { SyntheticData, isValidRut } from "@nexo/shared";

const MODE = process.env.MODE ?? "concesiones";
const PORT = Number(process.env.PORT ?? 7001);
const VERSION = process.env.VERSION ?? "1.0.0";
let failRate = Number(process.env.FAIL_RATE ?? 0);
let latencyMs = Number(process.env.LATENCY_MS ?? 0);
const CHAOS_TOKEN = process.env.CHAOS_TOKEN ?? "nexo-lab-chaos";

const data = new SyntheticData(2026);
const concesiones = data.concessions(250);
const operadores = Array.from({ length: 40 }, () => {
  const c = data.concession(0);
  return { rut: c.rutEmpresa, razonSocial: c.empresa, servicio: c.servicio, region: c.region, estado: c.estado };
});

const counters = new Map<string, number>();
function count(key: string): void {
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "x-backend-version": VERSION,
    "x-backend-mode": MODE,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("payload demasiado grande");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ REST concesiones

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Concesiones de Telecomunicaciones", version: VERSION, description: "API de ejemplo con datos sintéticos" },
  paths: {
    "/concesiones": {
      get: {
        summary: "Lista concesiones",
        parameters: [
          { name: "region", in: "query", schema: { type: "string" } },
          { name: "estado", in: "query", schema: { type: "string", enum: ["vigente", "en_tramite", "caducada"] } },
        ],
        responses: { "200": { description: "Lista de concesiones" } },
      },
      post: { summary: "Registra una solicitud de concesión", responses: { "201": { description: "Creada" } } },
    },
    "/concesiones/{id}": {
      get: {
        summary: "Obtiene una concesión",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Concesión" }, "404": { description: "No existe" } },
      },
    },
  },
};

/** Respuestas ya entregadas por Idempotency-Key: un reintento no duplica el registro (BT-051). */
const idempotentes = new Map<string, { status: number; body: unknown }>();
let registrosCreados = 0;

async function concesionesHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/openapi.json") return send(res, 200, OPENAPI);
  if (url.pathname === "/concesiones" && req.method === "GET") {
    const region = url.searchParams.get("region");
    const estado = url.searchParams.get("estado");
    const items = concesiones.filter((c) => (!region || c.region === region) && (!estado || c.estado === estado));
    return send(res, 200, { total: items.length, items: items.slice(0, 50), version: VERSION });
  }
  if (url.pathname === "/_estadisticas") return send(res, 200, { registrosCreados, clavesIdempotencia: idempotentes.size });
  if (url.pathname === "/concesiones" && req.method === "POST") {
    const idemKey = String(req.headers["idempotency-key"] ?? "");
    const previa = idemKey ? idempotentes.get(idemKey) : undefined;
    if (previa) {
      res.setHeader("x-idempotent-replay", "true");
      return send(res, previa.status, previa.body);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "JSON inválido" });
    }
    const rut = String(body.rutEmpresa ?? "");
    if (!isValidRut(rut)) return send(res, 422, { error: "rutEmpresa inválido", campo: "rutEmpresa" });
    if (typeof body.servicio !== "string" || typeof body.region !== "string")
      return send(res, 422, { error: "servicio y region son obligatorios" });
    const id = `REG-${Date.now().toString(36).toUpperCase()}`;
    const respuesta = { id, estado: "en_tramite", recibidoEn: new Date().toISOString(), version: VERSION };
    registrosCreados++;
    if (idemKey) idempotentes.set(idemKey, { status: 201, body: respuesta });
    return send(res, 201, respuesta);
  }
  const m = /^\/concesiones\/([A-Z0-9-]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const item = concesiones.find((c) => c.id === m[1]);
    return item ? send(res, 200, { ...item, version: VERSION }) : send(res, 404, { error: "no existe" });
  }
  return send(res, 404, { error: "ruta no encontrada" });
}

// ------------------------------------------------------------------ SOAP 1.2 estilo PISEE

const NS = "urn:subtel:registro:operadores:v1";

function wsdl(baseUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="RegistroOperadores" targetNamespace="${NS}" xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:tns="${NS}" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types>
    <xsd:schema targetNamespace="${NS}" elementFormDefault="qualified">
      <xsd:element name="ConsultarOperadorRequest">
        <xsd:complexType><xsd:sequence><xsd:element name="rut" type="xsd:string"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="ConsultarOperadorResponse">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="rut" type="xsd:string"/>
          <xsd:element name="razonSocial" type="xsd:string"/>
          <xsd:element name="servicio" type="xsd:string"/>
          <xsd:element name="region" type="xsd:string"/>
          <xsd:element name="estado" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>
  <message name="ConsultarOperadorIn"><part name="parameters" element="tns:ConsultarOperadorRequest"/></message>
  <message name="ConsultarOperadorOut"><part name="parameters" element="tns:ConsultarOperadorResponse"/></message>
  <portType name="RegistroOperadoresPort">
    <operation name="ConsultarOperador"><input message="tns:ConsultarOperadorIn"/><output message="tns:ConsultarOperadorOut"/></operation>
  </portType>
  <binding name="RegistroOperadoresSoap12" type="tns:RegistroOperadoresPort">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="ConsultarOperador">
      <soap12:operation soapAction="${NS}/ConsultarOperador"/>
      <input><soap12:body use="literal"/></input><output><soap12:body use="literal"/></output>
    </operation>
  </binding>
  <service name="RegistroOperadores">
    <port name="RegistroOperadoresSoap12Port" binding="tns:RegistroOperadoresSoap12"><soap12:address location="${baseUrl}/soap/registro"/></port>
  </service>
</definitions>`;
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
}

function soapFault(code: "soap:Sender" | "soap:Receiver", reason: string): string {
  return soapEnvelope(
    `<soap:Fault><soap:Code><soap:Value>${code}</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="es">${reason}</soap:Text></soap:Reason></soap:Fault>`,
  );
}

async function registroHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname !== "/soap/registro") return send(res, 404, { error: "ruta no encontrada" });
  if (req.method === "GET" && url.searchParams.has("wsdl")) {
    return send(res, 200, wsdl(`http://${req.headers.host ?? "localhost"}`), "text/xml");
  }
  if (req.method !== "POST") return send(res, 405, soapFault("soap:Sender", "Método no permitido"), "application/soap+xml");
  const body = await readBody(req);
  const rut = /<(?:\w+:)?rut>([^<]+)<\/(?:\w+:)?rut>/.exec(body)?.[1]?.trim();
  if (!rut || !isValidRut(rut)) return send(res, 400, soapFault("soap:Sender", "RUT inválido"), "application/soap+xml");
  const op = operadores.find((o) => o.rut === rut) ?? operadores[0]!;
  const xml = soapEnvelope(
    `<tns:ConsultarOperadorResponse xmlns:tns="${NS}"><tns:rut>${rut}</tns:rut><tns:razonSocial>${op.razonSocial}</tns:razonSocial><tns:servicio>${op.servicio}</tns:servicio><tns:region>${op.region}</tns:region><tns:estado>${op.estado}</tns:estado></tns:ConsultarOperadorResponse>`,
  );
  return send(res, 200, xml, "application/soap+xml");
}

// ------------------------------------------------------------------ APIs no gobernadas (D-01)

/** Contrato OpenAPI que la API directa de espectro publica en la ruta típica (/openapi.json). */
const ESPECTRO_OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Asignaciones de espectro (sistema departamental)", version: "1.2.0" },
  paths: {
    "/espectro/asignaciones": {
      get: {
        summary: "Asignaciones vigentes con su titular",
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Asignaciones" } } } } },
      },
    },
    "/espectro/asignaciones/{id}": {
      get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok" } } },
    },
  },
  components: {
    schemas: {
      Asignaciones: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                banda: { type: "string" },
                region: { type: "string" },
                titular: { type: "object", properties: { nombre: { type: "string" }, rut: { type: "string" }, email: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};

async function ocultasHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/interno/reportes/titulares") {
    // Expone datos personales sin autenticación: el motor de descubrimiento debe marcarla con riesgo alto.
    return send(res, 200, { items: Array.from({ length: 5 }, () => data.person()) });
  }
  // API "directa" (sin gateway): publica su contrato y entrega titulares con RUT y correo.
  if (url.pathname === "/openapi.json") return send(res, 200, ESPECTRO_OPENAPI);
  if (url.pathname === "/espectro/asignaciones") {
    return send(res, 200, { items: Array.from({ length: 3 }, (_, i) => ({ banda: ["700 MHz", "3,5 GHz", "26 GHz"][i], region: "Biobío", titular: data.person() })) });
  }
  // Detrás de APISIX con key-auth (la verificación de la llave la hace APISIX).
  if (url.pathname === "/fiscalizacion/inspecciones") {
    return send(res, 200, { items: [{ id: "INS-2026-0041", operador: "Red Austral", resultado: "observada" }], via: req.headers["x-forwarded-for"] ? "apisix" : "directo" });
  }
  if (url.pathname === "/legacy/tarifas") return send(res, 200, { tarifas: [{ plan: "base", valor: 9990 }] });
  if (url.pathname === "/legacy/v2/api-docs") {
    return send(res, 200, {
      swagger: "2.0",
      info: { title: "Tarifas (legado)", version: "0.9" },
      paths: { "/legacy/tarifas": { get: { responses: { "200": { description: "ok" } } } } },
    });
  }
  return send(res, 404, { error: "ruta no encontrada" });
}

// ------------------------------------------------------------------ GraphQL (D-06)

const SDL = `
"Concesión de un servicio de telecomunicaciones (datos sintéticos)"
type Concesion {
  id: ID!
  empresa: String!
  rutEmpresa: String!
  servicio: String!
  region: String!
  estado: String!
  fechaOtorgamiento: String!
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
const schema = buildSchema(SDL);
const rootValue = {
  concesiones: ({ region, estado, limite }: { region?: string; estado?: string; limite?: number }) =>
    concesiones.filter((c) => (!region || c.region === region) && (!estado || c.estado === estado)).slice(0, limite ?? 20),
  concesion: ({ id }: { id: string }) => concesiones.find((c) => c.id === id) ?? null,
  totalPorEstado: () =>
    ["vigente", "en_tramite", "caducada"].map((estado) => ({ estado, total: concesiones.filter((c) => c.estado === estado).length })),
};

async function graphqlHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/schema.graphql") return send(res, 200, SDL, "text/plain");
  if (url.pathname !== "/graphql") return send(res, 404, { error: "ruta no encontrada" });
  let query = url.searchParams.get("query") ?? "";
  let variables: Record<string, unknown> | undefined;
  if (req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { query?: string; variables?: Record<string, unknown> };
    query = body.query ?? "";
    variables = body.variables;
  }
  const result = await graphql({ schema, source: query, rootValue, variableValues: variables });
  return send(res, result.errors ? 400 : 200, result);
}

// ------------------------------------------------------------------ eventos por WebSocket (D-06)

const TIPOS = ["alerta_red", "cambio_estado_concesion", "mantenimiento_programado"] as const;
let eventoSeq = 0;
function nuevoEvento(tipo?: (typeof TIPOS)[number]) {
  const c = concesiones[Math.floor(Math.random() * concesiones.length)]!;
  eventoSeq++;
  return {
    id: `EVT-${String(eventoSeq).padStart(6, "0")}`,
    tipo: tipo ?? TIPOS[eventoSeq % TIPOS.length],
    ocurridoEn: new Date().toISOString(),
    concesionId: c.id,
    empresa: c.empresa,
    region: c.region,
    detalle: "Evento sintético de laboratorio",
  };
}

async function eventosHandler(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === "/publicar" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as { tipo?: (typeof TIPOS)[number] };
    const evt = nuevoEvento(body.tipo);
    broadcast(evt);
    return send(res, 202, evt);
  }
  return send(res, 404, { error: "use WebSocket en /ws" });
}

let wss: WebSocketServer | undefined;
function broadcast(evt: unknown): void {
  const msg = JSON.stringify(evt);
  for (const client of wss?.clients ?? []) if (client.readyState === WebSocket.OPEN) client.send(msg);
}

// ------------------------------------------------------------------ servidor

const handlers = {
  concesiones: concesionesHandler,
  registro: registroHandler,
  ocultas: ocultasHandler,
  graphql: graphqlHandler,
  eventos: eventosHandler,
} as const;
const handler = handlers[MODE as keyof typeof handlers];
if (!handler) throw new Error(`MODE desconocido: ${MODE}`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/health") return send(res, 200, { status: "ok", mode: MODE, version: VERSION });
    if (url.pathname === "/metrics") {
      const lines = [...counters].map(([k, v]) => `nexo_demo_requests_total{${k}} ${v}`);
      return send(res, 200, `# TYPE nexo_demo_requests_total counter\n${lines.join("\n")}\n`, "text/plain");
    }
    if (url.pathname === "/_chaos" && req.method === "POST") {
      if (req.headers["x-chaos-token"] !== CHAOS_TOKEN) return send(res, 403, { error: "prohibido" });
      const cfg = JSON.parse((await readBody(req)) || "{}") as { failRate?: number; latencyMs?: number };
      failRate = Math.min(1, Math.max(0, Number(cfg.failRate ?? failRate)));
      latencyMs = Math.max(0, Number(cfg.latencyMs ?? latencyMs));
      return send(res, 200, { failRate, latencyMs, version: VERSION });
    }
    if (latencyMs > 0) await sleep(latencyMs);
    if (failRate > 0 && Math.random() < failRate) {
      count(`mode="${MODE}",version="${VERSION}",status="500"`);
      return send(res, 500, { error: "falla simulada", version: VERSION });
    }
    await handler(req, res, url);
    count(`mode="${MODE}",version="${VERSION}",status="${res.statusCode}"`);
  } catch (err) {
    count(`mode="${MODE}",version="${VERSION}",status="500"`);
    send(res, 500, { error: err instanceof Error ? err.message : "error" });
  }
});

if (MODE === "eventos") {
  // Acepta cualquier ruta: el gateway puede agregar el canal (topic) definido en el contrato AsyncAPI.
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.send(JSON.stringify({ tipo: "bienvenida", ocurridoEn: new Date().toISOString() })));
  setInterval(() => broadcast(nuevoEvento()), Number(process.env.EVENT_INTERVAL_MS ?? 5000));
}

server.listen(PORT, () => {
  console.log(JSON.stringify({ msg: "demo-backend iniciado", mode: MODE, version: VERSION, port: PORT, failRate, latencyMs }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
