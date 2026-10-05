import { formatRut, SyntheticData } from "@nexo/shared/browser";
import type {
  AnomalyRule,
  ApiAsset,
  Audience,
  Block,
  Classification,
  DeadLetter,
  DiscoveryFinding,
  GraphEdge,
  GraphNode,
  SiteHealth,
  TlsChannel,
} from "../api/types";
import { GOVERNANCE_FIELDS } from "../features/catalog/governance";
import { appendAudit } from "./audit";
import type {
  AnomalyRecord,
  ApiRecord,
  ConsumerRecord,
  FailoverRecord,
  MockState,
  RolloutRecord,
  ScanRecord,
  Subscription,
} from "./types";

export const STATE_VERSION = 3;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Completitud de la ficha: porcentaje de los 8 campos de gobierno con valor. */
export function completenessOf(api: ApiAsset): { completeness: number; missing: string[] } {
  const missing = GOVERNANCE_FIELDS.filter((f) => {
    const value = api[f.key];
    return value === undefined || value === null || String(value).trim() === "";
  }).map((f) => f.key);
  return {
    completeness: Math.round(((GOVERNANCE_FIELDS.length - missing.length) / GOVERNANCE_FIELDS.length) * 100),
    missing,
  };
}

/** Enmascara un RUT dejando visibles los dos primeros dígitos y el dígito verificador. */
export function maskRut(rut: string): string {
  const [body = "", dv = ""] = rut.split("-");
  let seen = 0;
  const masked = body.replace(/\d/g, (d) => (seen++ < 2 ? d : "*"));
  return `${masked}-${dv}`;
}

interface ApiSeed {
  slug: string;
  name: string;
  version: string;
  context: string;
  type: NonNullable<ApiAsset["type"]>;
  audience: Audience;
  state: string;
  classification?: Classification;
  authType?: string;
  ownerTeam?: string;
  withContact?: boolean;
  purpose?: string;
  contractRef?: string;
  endpoints: string[];
  consumers: string[];
  flow?: string;
}

const API_SEEDS: ApiSeed[] = [
  {
    slug: "concesiones",
    name: "Concesiones",
    version: "1.2.0",
    context: "/concesiones/v1",
    type: "HTTP",
    audience: "operadores",
    state: "PUBLISHED",
    classification: "interna",
    authType: "OAuth2 (client credentials) con Keycloak",
    ownerTeam: "División de Concesiones",
    withContact: true,
    purpose:
      "Consulta de concesiones de servicios de telecomunicaciones vigentes, en trámite y caducadas, por empresa y región.",
    contractRef: "nexo-contratos@4f9c2a1",
    endpoints: [
      "GET /concesiones/v1/concesiones",
      "GET /concesiones/v1/concesiones/{id}",
      "GET /concesiones/v1/concesiones/{id}/historial",
    ],
    consumers: ["telecom-andina", "red-austral", "fibra-pacifico", "enlace-norte", "portal-tramites"],
    flow: "flujo-concesiones",
  },
  {
    slug: "registro-operadores",
    name: "Registro de Operadores (SOAP, PISEE)",
    version: "1.0.0",
    context: "/pisee/registro-operadores",
    type: "SOAP",
    audience: "operadores",
    state: "PUBLISHED",
    classification: "reservada",
    authType: "WS-Security y mTLS (PISEE)",
    ownerTeam: "Unidad de Interoperabilidad",
    withContact: true,
    purpose:
      "Servicio SOAP 1.2 expuesto vía PISEE para validar operadores inscritos y su representante legal.",
    contractRef: "nexo-contratos@a17e03b",
    endpoints: [
      "POST /pisee/registro-operadores (ConsultarOperador)",
      "POST /pisee/registro-operadores (ValidarRepresentante)",
    ],
    consumers: ["telecom-andina", "red-austral", "conecta-sur", "satelital-chile"],
    flow: "flujo-pisee",
  },
  {
    slug: "reclamos",
    name: "Reclamos",
    version: "2.1.0",
    context: "/reclamos/v2",
    type: "HTTP",
    audience: "publica",
    state: "PUBLISHED",
    classification: "datos_personales",
    authType: "OAuth2 (authorization code con PKCE)",
    ownerTeam: "Atención Ciudadana",
    withContact: false,
    purpose: "Ingreso y seguimiento de reclamos de usuarios contra empresas de telecomunicaciones.",
    contractRef: "nexo-contratos@c3d9e77",
    endpoints: [
      "POST /reclamos/v2/reclamos",
      "GET /reclamos/v2/reclamos/{id}",
      "GET /reclamos/v2/reclamos?rut={rut}",
    ],
    consumers: ["portal-tramites", "mesa-ayuda", "telecom-andina", "red-austral", "conecta-sur"],
    flow: "flujo-reclamos",
  },
  {
    slug: "espectro",
    name: "Espectro radioeléctrico",
    version: "1.0.0",
    context: "/espectro/v1",
    type: "HTTP",
    audience: "interna",
    state: "PUBLISHED",
    classification: "interna",
    authType: "OAuth2 (client credentials)",
    ownerTeam: "División de Espectro",
    withContact: true,
    purpose: "Asignaciones de bandas de frecuencia por concesionario y región.",
    endpoints: ["GET /espectro/v1/asignaciones", "GET /espectro/v1/bandas/{banda}"],
    consumers: ["portal-tramites"],
    flow: "flujo-espectro",
  },
  {
    slug: "portabilidad",
    name: "Portabilidad numérica",
    version: "3.0.0",
    context: "/portabilidad/v3",
    type: "HTTP",
    audience: "operadores",
    state: "PUBLISHED",
    classification: "datos_personales",
    authType: "OAuth2 con mTLS",
    ownerTeam: "Unidad de Portabilidad",
    withContact: true,
    purpose: "Solicitudes y estado de la portabilidad de números entre operadores.",
    contractRef: "nexo-contratos@9b2f610",
    endpoints: [
      "POST /portabilidad/v3/solicitudes",
      "GET /portabilidad/v3/solicitudes/{id}",
      "GET /portabilidad/v3/numeros/{numero}",
    ],
    consumers: [
      "telecom-andina",
      "red-austral",
      "fibra-pacifico",
      "enlace-norte",
      "conecta-sur",
      "satelital-chile",
    ],
    flow: "flujo-portabilidad",
  },
  {
    slug: "infraestructura",
    name: "Antenas e infraestructura",
    version: "1.1.0",
    context: "/infraestructura/v1",
    type: "HTTP",
    audience: "publica",
    state: "PUBLISHED",
    classification: "publica",
    authType: "API key (plan público)",
    ownerTeam: "División de Fiscalización",
    withContact: true,
    purpose: "Ubicación de antenas y torres autorizadas, para consulta ciudadana.",
    contractRef: "nexo-contratos@1e0d4c8",
    endpoints: ["GET /infraestructura/v1/antenas", "GET /infraestructura/v1/antenas/{id}"],
    consumers: ["datos-abiertos", "portal-tramites"],
    flow: "flujo-infraestructura",
  },
  {
    slug: "calidad",
    name: "Indicadores de calidad de servicio",
    version: "1.0.0",
    context: "/calidad/v1",
    type: "HTTP",
    audience: "publica",
    state: "PUBLISHED",
    classification: "publica",
    authType: "API key (plan público)",
    ownerTeam: "Estudios y Estadísticas",
    withContact: false,
    purpose: "Indicadores trimestrales de calidad de servicio por operador y tecnología.",
    endpoints: ["GET /calidad/v1/indicadores"],
    consumers: ["datos-abiertos"],
    flow: "flujo-calidad",
  },
  {
    slug: "fiscalizacion",
    name: "Fiscalización",
    version: "0.9.0",
    context: "/fiscalizacion/v1",
    type: "HTTP",
    audience: "interna",
    state: "CREATED",
    authType: "OAuth2 (client credentials)",
    endpoints: ["GET /fiscalizacion/v1/inspecciones"],
    consumers: [],
    flow: "flujo-concesiones",
  },
  {
    slug: "tramites",
    name: "Trámites ciudadanos",
    version: "1.0.0",
    context: "/tramites/graphql",
    type: "GRAPHQL",
    audience: "publica",
    state: "PUBLISHED",
    classification: "datos_personales",
    authType: "OAuth2 (authorization code con PKCE) y ClaveÚnica",
    ownerTeam: "Atención Ciudadana",
    withContact: true,
    purpose: "Consulta unificada del estado de trámites ciudadanos (reclamos y solicitudes).",
    contractRef: "nexo-contratos@77ab301",
    endpoints: ["POST /tramites/graphql"],
    consumers: ["portal-tramites", "mesa-ayuda"],
    flow: "flujo-tramites",
  },
  {
    slug: "incidentes",
    name: "Notificación de incidentes de red",
    version: "1.0.0",
    context: "/incidentes/eventos",
    type: "WEBSUB",
    audience: "operadores",
    state: "PUBLISHED",
    classification: "interna",
    authType: "Firma HMAC por suscriptor",
    ownerTeam: "División de Fiscalización",
    withContact: true,
    purpose: "Eventos de incidentes de red que los operadores deben informar (fallas masivas, cortes).",
    contractRef: "nexo-contratos@0c5d2fe",
    endpoints: ["POST /incidentes/eventos (publicación)"],
    consumers: ["telecom-andina", "red-austral", "fibra-pacifico"],
    flow: "flujo-incidentes",
  },
  {
    slug: "concesiones-v1-0",
    name: "Concesiones",
    version: "1.0.0",
    context: "/concesiones/v1.0",
    type: "HTTP",
    audience: "operadores",
    state: "DEPRECATED",
    classification: "interna",
    authType: "OAuth2 (client credentials)",
    ownerTeam: "División de Concesiones",
    withContact: true,
    purpose: "Versión anterior de Concesiones. Deprecada: se retira el 31-12-2026.",
    contractRef: "nexo-contratos@1b77e90",
    endpoints: ["GET /concesiones/v1.0/concesiones"],
    consumers: ["enlace-norte"],
    flow: "flujo-concesiones",
  },
  {
    slug: "estadisticas",
    name: "Estadísticas de mercado",
    version: "1.0.0",
    context: "/estadisticas/v1",
    type: "HTTP",
    audience: "publica",
    state: "PUBLISHED",
    classification: "publica",
    authType: "API key (plan público)",
    ownerTeam: "Estudios y Estadísticas",
    withContact: true,
    purpose: "Series de suscriptores, tráfico y participación de mercado por servicio.",
    contractRef: "nexo-contratos@5a0e7c3",
    endpoints: ["GET /estadisticas/v1/mercado"],
    consumers: ["datos-abiertos"],
    flow: "flujo-calidad",
  },
];

const CONSUMER_SEEDS: Array<{
  slug: string;
  organization: string;
  application: string;
  plan: string;
  audience: ConsumerRecord["audience"];
}> = [
  {
    slug: "telecom-andina",
    organization: "Telecom Andina",
    application: "telecom-andina-app",
    plan: "Operador Oro",
    audience: "operadores",
  },
  {
    slug: "red-austral",
    organization: "Red Austral",
    application: "red-austral-portabilidad",
    plan: "Operador Plata",
    audience: "operadores",
  },
  {
    slug: "fibra-pacifico",
    organization: "Fibra Pacífico",
    application: "fibra-pacifico-core",
    plan: "Operador Plata",
    audience: "operadores",
  },
  {
    slug: "enlace-norte",
    organization: "Enlace Norte",
    application: "enlace-norte-legado",
    plan: "Operador Bronce",
    audience: "operadores",
  },
  {
    slug: "conecta-sur",
    organization: "Conecta Sur",
    application: "conecta-sur-batch",
    plan: "Operador Bronce",
    audience: "operadores",
  },
  {
    slug: "satelital-chile",
    organization: "Satelital Chile",
    application: "satelital-chile-gw",
    plan: "Operador Bronce",
    audience: "operadores",
  },
  {
    slug: "portal-tramites",
    organization: "Portal de Trámites",
    application: "portal-tramites",
    plan: "Interno",
    audience: "interna",
  },
  {
    slug: "mesa-ayuda",
    organization: "Mesa de Ayuda Ciudadana",
    application: "mesa-ayuda-crm",
    plan: "Interno",
    audience: "interna",
  },
  {
    slug: "datos-abiertos",
    organization: "Datos Abiertos (Gobierno Digital)",
    application: "datos-abiertos-harvester",
    plan: "Público",
    audience: "publica",
  },
];

const apiId = (slug: string) => `api-${slug}`;
const consumerId = (slug: string) => `cons-${slug}`;

function buildGraph(
  apis: ApiRecord[],
  consumers: ConsumerRecord[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const c of consumers) {
    nodes.push({
      id: c.id,
      type: "consumidor",
      label: c.organization,
      meta: { aplicación: c.application, plan: c.plan, audience: c.audience },
    });
  }
  for (const api of apis) {
    nodes.push({
      id: api.id,
      type: "api",
      label: `${api.name} ${api.version}`,
      meta: { apiId: api.id, contexto: api.context, estado: api.state, classification: api.classification },
    });
  }
  const flows: Array<[string, string, string]> = [
    ["flujo-concesiones", "Orquestación de concesiones", "Valida el operador en PISEE y consulta Oracle."],
    ["flujo-pisee", "Mediación SOAP con PISEE", "Transforma SOAP 1.2 y firma WS-Security."],
    ["flujo-reclamos", "Ingreso de reclamos", "Valida con JSON Schema, guarda y publica en la cola."],
    ["flujo-portabilidad", "Sincronización de portabilidad", "Orquesta la solicitud con el sistema OAP."],
    ["flujo-espectro", "Consulta de espectro", "Lee asignaciones desde el sistema SAE."],
    ["flujo-calidad", "ETL de indicadores", "Consulta vistas analíticas en BigQuery."],
    ["flujo-incidentes", "Publicación de incidentes", "Distribuye eventos a los suscriptores."],
    ["flujo-tramites", "Resolución GraphQL de trámites", "Une reclamos y solicitudes en una sola consulta."],
    ["flujo-infraestructura", "Consulta de infraestructura", "Lee antenas autorizadas desde Oracle."],
  ];
  for (const [id, label, detalle] of flows)
    nodes.push({ id, type: "flujo", label, meta: { motor: "Micro Integrator 4.6.0", detalle } });
  const systems: Array<[string, string, string]> = [
    ["sis-oracle", "Oracle Concesiones (CPD)", "Oracle 19c"],
    ["sis-pisee", "PISEE (interoperabilidad del Estado)", "SOAP 1.2"],
    ["sis-rabbitmq", "RabbitMQ Nexo", "RabbitMQ 4.3"],
    ["sis-cloudsql", "Cloud SQL Reclamos (GCP)", "PostgreSQL 16"],
    ["sis-oap", "Sistema de portabilidad (OAP)", "REST externo"],
    ["sis-sae", "Sistema de administración de espectro", "Oracle 19c"],
    ["sis-bigquery", "BigQuery Analítica (GCP)", "BigQuery"],
  ];
  for (const [id, label, tecnologia] of systems)
    nodes.push({ id, type: "sistema", label, meta: { tecnologia } });
  const data: Array<[string, string, string]> = [
    ["dato-concesion", "Tabla CONCESION", "interna"],
    ["dato-operador", "Tabla OPERADOR", "reservada"],
    ["dato-reclamo", "Tabla RECLAMO", "datos_personales"],
    ["dato-portabilidad", "Tabla SOLICITUD_PORTABILIDAD", "datos_personales"],
    ["dato-banda", "Tabla BANDA_FRECUENCIA", "interna"],
    ["dato-indicadores", "Vista INDICADORES_CALIDAD", "publica"],
    ["dato-antena", "Tabla ANTENA", "publica"],
  ];
  for (const [id, label, clasificacion] of data)
    nodes.push({ id, type: "dato", label, meta: { clasificacion } });
  const reports: Array<[string, string]> = [
    ["rep-reclamos", "Reporte mensual de reclamos"],
    ["rep-calidad", "Tablero de calidad de servicio"],
    ["rep-espectro", "Informe de espectro asignado"],
    ["rep-mercado", "Estadísticas trimestrales de mercado"],
  ];
  for (const [id, label] of reports)
    nodes.push({ id, type: "reporte", label, meta: { herramienta: "OpenMetadata / Looker Studio" } });

  for (const seed of API_SEEDS) {
    for (const c of seed.consumers)
      edges.push({
        from: consumerId(c),
        to: apiId(seed.slug),
        relation: "consume",
        source: "trafico_observado",
      });
    if (seed.flow)
      edges.push({ from: apiId(seed.slug), to: seed.flow, relation: "llama", source: "analizador_mi" });
  }
  const link = (from: string, to: string, relation: GraphEdge["relation"], source: GraphEdge["source"]) =>
    edges.push({ from, to, relation, source });
  link("flujo-concesiones", "sis-oracle", "lee", "analizador_mi");
  link("flujo-concesiones", "sis-pisee", "llama", "analizador_mi");
  link("flujo-pisee", "sis-pisee", "llama", "analizador_mi");
  link("flujo-pisee", "sis-oracle", "lee", "analizador_mi");
  link("flujo-reclamos", "sis-cloudsql", "escribe", "analizador_mi");
  link("flujo-reclamos", "sis-rabbitmq", "publica", "analizador_mi");
  link("flujo-portabilidad", "sis-oap", "llama", "analizador_mi");
  link("flujo-portabilidad", "sis-rabbitmq", "publica", "analizador_mi");
  link("flujo-espectro", "sis-sae", "lee", "analizador_mi");
  link("flujo-calidad", "sis-bigquery", "lee", "analizador_mi");
  link("flujo-incidentes", "sis-rabbitmq", "publica", "analizador_mi");
  link("flujo-tramites", "sis-cloudsql", "lee", "analizador_mi");
  link("flujo-tramites", "sis-oracle", "lee", "analizador_mi");
  link("flujo-infraestructura", "sis-oracle", "lee", "analizador_mi");
  link("sis-oracle", "dato-concesion", "escribe", "openmetadata");
  link("sis-oracle", "dato-operador", "escribe", "openmetadata");
  link("sis-oracle", "dato-antena", "escribe", "openmetadata");
  link("sis-pisee", "dato-operador", "lee", "openmetadata");
  link("sis-cloudsql", "dato-reclamo", "escribe", "openmetadata");
  link("sis-oap", "dato-portabilidad", "escribe", "openmetadata");
  link("sis-sae", "dato-banda", "escribe", "openmetadata");
  link("sis-bigquery", "dato-indicadores", "escribe", "openmetadata");
  link("dato-reclamo", "rep-reclamos", "transforma", "openmetadata");
  link("dato-indicadores", "rep-calidad", "transforma", "openmetadata");
  link("dato-indicadores", "rep-mercado", "transforma", "openmetadata");
  link("dato-concesion", "rep-mercado", "transforma", "openmetadata");
  link("dato-banda", "rep-espectro", "transforma", "openmetadata");
  return { nodes, edges };
}

function sites(now: number): SiteHealth[] {
  const seen = new Date(now - 20_000).toISOString();
  return [
    {
      id: "cpd",
      name: "CPD institucional (Santiago)",
      role: "primario",
      active: true,
      checks: { gateway: "ok", controlPlane: "ok", baseDatos: "ok", recorridoSintetico: "ok" },
      vote: "primario_sano",
      lastSeen: seen,
    },
    {
      id: "gcp",
      name: "Google Cloud (southamerica-west1)",
      role: "respaldo",
      active: false,
      checks: { gateway: "ok", controlPlane: "ok", baseDatos: "ok", recorridoSintetico: "ok" },
      vote: "primario_sano",
      lastSeen: seen,
    },
    {
      id: "testigo",
      name: "Sitio testigo (tercer proveedor)",
      role: "testigo",
      active: false,
      checks: {
        gateway: "desconocido",
        controlPlane: "desconocido",
        baseDatos: "desconocido",
        recorridoSintetico: "ok",
      },
      vote: "primario_sano",
      lastSeen: seen,
    },
  ];
}

export const DRILL_STEPS = [
  {
    offsetMs: 0,
    name: "Inicio del simulacro",
    detail: "Se aísla el sitio CPD del recorrido sintético (sin afectar el tráfico real).",
  },
  {
    offsetMs: 1500,
    name: "Votación de los agentes",
    detail: "GCP y el testigo informan «primario caído»: quórum 2 de 3 alcanzado.",
  },
  {
    offsetMs: 3000,
    name: "Cerrar la escritura en el CPD",
    detail: "Se bloquea la escritura en PostgreSQL del CPD para evitar dos sitios activos.",
  },
  {
    offsetMs: 5000,
    name: "Promover la réplica en GKE",
    detail: "CloudNativePG promueve la réplica de PostgreSQL a primaria.",
  },
  {
    offsetMs: 7500,
    name: "Escalar gateways e integrador en GKE",
    detail: "Gateways de WSO2 y Micro Integrator pasan de 1 a 3 réplicas.",
  },
  {
    offsetMs: 9500,
    name: "Actualizar DNS y balanceador global",
    detail: "api.cliente.invalid apunta al balanceador de Google Cloud.",
  },
  {
    offsetMs: 11500,
    name: "Recorrido sintético en GCP",
    detail: "Token, API Concesiones y flujo SOAP responden correctamente.",
  },
  {
    offsetMs: 12500,
    name: "Aviso a mesa de soporte y SIEM",
    detail: "Se registra el evento con el RTO y el RPO medidos.",
  },
];

export const FAILBACK_STEPS = [
  { offsetMs: 0, name: "Retorno aprobado", detail: "Aprobación registrada en la auditoría." },
  {
    offsetMs: 1500,
    name: "Replicación inversa GKE → CPD",
    detail: "El CPD recupera los cambios hechos mientras operó el respaldo.",
  },
  {
    offsetMs: 3500,
    name: "Congelar la escritura en GCP",
    detail: "Ventana de escritura cerrada para el corte final.",
  },
  {
    offsetMs: 5000,
    name: "Promover la base de datos del CPD",
    detail: "PostgreSQL del CPD vuelve a ser la primaria.",
  },
  {
    offsetMs: 7000,
    name: "Actualizar DNS y balanceador global",
    detail: "api.cliente.invalid vuelve a apuntar al CPD.",
  },
  {
    offsetMs: 8500,
    name: "Recorrido sintético en el CPD",
    detail: "Token, API Concesiones y flujo SOAP responden correctamente.",
  },
  { offsetMs: 9500, name: "Reducir réplicas en GKE", detail: "El respaldo vuelve a modo en espera." },
  { offsetMs: 10000, name: "Aviso a mesa de soporte y SIEM", detail: "Se cierra el evento de continuidad." },
];

function stepsAt(base: number, plan: typeof DRILL_STEPS): FailoverRecord["steps"] {
  return plan.map((s) => ({
    name: s.name,
    status: "ok",
    ts: new Date(base + s.offsetMs * 30).toISOString(),
    detail: s.detail,
  }));
}

function findings(now: number): DiscoveryFinding[] {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const base = { firstSeen: ago(2 * DAY), lastSeen: ago(3 * HOUR) };
  return [
    {
      id: "fnd-001",
      scanId: "scan-002",
      source: "apisix",
      host: "apisix.lab.cliente.invalid",
      port: 9080,
      path: "/legacy/reclamos-export",
      protocol: "HTTP/1.1",
      specFound: true,
      authDetected: "ninguna",
      tls: "Sin TLS",
      personalDataSuspected: true,
      exposureScore: 94,
      reasons: [
        "Sin autenticación",
        "Accesible desde Internet a través de APISIX",
        "La especificación expone campos con datos personales (rut, teléfono, correo)",
        "Sin dueño registrado en el catálogo",
      ],
      status: "nuevo",
      ...base,
    },
    {
      id: "fnd-002",
      scanId: "scan-002",
      source: "nginx",
      host: "intranet-legacy.cliente.invalid",
      port: 80,
      path: "/ws/OperadoresService?wsdl",
      protocol: "SOAP 1.1",
      specFound: true,
      authDetected: "basica",
      tls: "Sin TLS",
      personalDataSuspected: false,
      exposureScore: 81,
      reasons: [
        "Autenticación básica sobre HTTP sin cifrar",
        "WSDL publicado sin control de acceso",
        "Duplica funciones del Registro de Operadores publicado en PISEE",
      ],
      status: "nuevo",
      ...base,
    },
    {
      id: "fnd-003",
      scanId: "scan-001",
      source: "red",
      host: "10.20.3.15",
      port: 8443,
      path: "/v3/api-docs",
      protocol: "HTTPS",
      specFound: true,
      authDetected: "token",
      tls: "TLS 1.0",
      personalDataSuspected: false,
      exposureScore: 66,
      reasons: [
        "TLS 1.0 (versión obsoleta)",
        "Certificado vencido el 31-03-2026",
        "No registrada en el catálogo de WSO2",
      ],
      status: "en_migracion",
      ...base,
    },
    {
      id: "fnd-004",
      scanId: "scan-001",
      source: "gcp",
      host: "espectro-reportes-7f3k2.a.run.app",
      port: 443,
      path: "/graphql",
      protocol: "HTTPS",
      specFound: true,
      authDetected: "ninguna",
      tls: "TLS 1.3",
      personalDataSuspected: false,
      exposureScore: 72,
      reasons: [
        "Servicio de Cloud Run sin autenticación (allUsers)",
        "Introspección de GraphQL habilitada",
        "Sin dueño registrado",
      ],
      status: "nuevo",
      ...base,
    },
    {
      id: "fnd-005",
      scanId: "scan-002",
      source: "apisix",
      host: "apisix.lab.cliente.invalid",
      port: 9080,
      path: "/concesiones/v1",
      protocol: "HTTP/1.1",
      specFound: true,
      authDetected: "token",
      tls: "TLS 1.2",
      personalDataSuspected: false,
      matchedApiId: "api-concesiones",
      exposureScore: 12,
      reasons: ["Coincide con la API Concesiones 1.2.0 publicada en WSO2"],
      status: "gobernado",
      ...base,
    },
    {
      id: "fnd-006",
      scanId: "scan-001",
      source: "nginx",
      host: "portal.cliente.invalid",
      port: 443,
      path: "/api/antenas/buscar",
      protocol: "HTTPS",
      specFound: false,
      authDetected: "ninguna",
      tls: "TLS 1.2",
      personalDataSuspected: false,
      exposureScore: 48,
      reasons: [
        "Endpoint de solo lectura sin autenticación",
        "Datos públicos (antenas autorizadas)",
        "Fuera del gateway: sin límites de consumo",
      ],
      status: "riesgo_aceptado",
      ...base,
    },
    {
      id: "fnd-007",
      scanId: "scan-001",
      source: "red",
      host: "10.20.7.40",
      port: 8080,
      path: "/actuator/env",
      protocol: "HTTP/1.1",
      specFound: false,
      authDetected: "ninguna",
      tls: "Sin TLS",
      personalDataSuspected: true,
      exposureScore: 89,
      reasons: [
        "Endpoint de administración de Spring Boot expuesto",
        "Puede revelar variables de entorno y credenciales",
        "Tráfico sin cifrar",
      ],
      status: "nuevo",
      ...base,
    },
    {
      id: "fnd-008",
      scanId: "scan-001",
      source: "gcp",
      host: "calidad-etl-x92ma.a.run.app",
      port: 443,
      path: "/openapi.json",
      protocol: "HTTPS",
      specFound: true,
      authDetected: "token",
      tls: "TLS 1.3",
      personalDataSuspected: false,
      exposureScore: 35,
      reasons: ["Requiere token de Google (IAM)", "No registrada en el catálogo de WSO2"],
      status: "en_migracion",
      ...base,
    },
    {
      id: "fnd-009",
      scanId: "scan-001",
      source: "nginx",
      host: "intranet-legacy.cliente.invalid",
      port: 80,
      path: "/reportes/exportar.csv",
      protocol: "HTTP/1.1",
      specFound: false,
      authDetected: "basica",
      tls: "Sin TLS",
      personalDataSuspected: true,
      exposureScore: 77,
      reasons: [
        "Exportación masiva sobre HTTP",
        "Autenticación básica",
        "Retirado el 15-09-2026 según la División de Fiscalización",
      ],
      status: "descartado",
      ...base,
    },
    {
      id: "fnd-010",
      scanId: "scan-002",
      source: "apisix",
      host: "apisix.lab.cliente.invalid",
      port: 9080,
      path: "/portabilidad/v3",
      protocol: "HTTP/1.1",
      specFound: true,
      authDetected: "mtls",
      tls: "TLS 1.3",
      personalDataSuspected: true,
      matchedApiId: "api-portabilidad",
      exposureScore: 8,
      reasons: ["Coincide con la API Portabilidad numérica 3.0.0 publicada en WSO2"],
      status: "gobernado",
      ...base,
    },
  ];
}

export function scanTotals(list: readonly DiscoveryFinding[]): NonNullable<ScanRecord["totals"]> {
  const governed = list.filter((f) => f.status === "gobernado" || f.matchedApiId).length;
  return {
    endpoints: list.length,
    gobernados: governed,
    noGobernados: list.length - governed,
    riesgoAlto: list.filter((f) => f.exposureScore >= 70 && !f.matchedApiId).length,
  };
}

function rules(now: number): AnomalyRule[] {
  const updatedAt = new Date(now - 6 * DAY).toISOString();
  return [
    {
      id: "rule-001",
      name: "Volumen anómalo por consumidor",
      metric: "volumen",
      sensitivity: 6,
      minVolume: 30,
      action: "bloquear_con_aprobacion",
      blockTtlMinutes: 30,
      enabled: true,
      createdBy: "admin.nexo",
      updatedAt,
    },
    {
      id: "rule-002",
      name: "Errores sobre la línea base",
      metric: "errores",
      sensitivity: 5,
      minVolume: 50,
      action: "alertar",
      blockTtlMinutes: 30,
      enabled: true,
      createdBy: "admin.nexo",
      updatedAt,
    },
    {
      id: "rule-003",
      name: "Latencia de Portabilidad",
      apiId: "api-portabilidad",
      metric: "latencia",
      sensitivity: 4,
      minVolume: 20,
      action: "alertar",
      blockTtlMinutes: 30,
      enabled: true,
      createdBy: "admin.nexo",
      updatedAt,
    },
    {
      id: "rule-004",
      name: "IPs distintas por aplicación",
      metric: "ips_distintas",
      sensitivity: 7,
      minVolume: 30,
      action: "bloquear_automatico",
      blockTtlMinutes: 15,
      enabled: true,
      createdBy: "admin.nexo",
      updatedAt,
    },
    {
      id: "rule-005",
      name: "Uso fuera de horario en Espectro",
      apiId: "api-espectro",
      metric: "fuera_de_horario",
      sensitivity: 3,
      minVolume: 10,
      action: "alertar",
      blockTtlMinutes: 30,
      enabled: false,
      createdBy: "admin.nexo",
      updatedAt,
    },
  ];
}

function anomalies(now: number): AnomalyRecord[] {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      id: "anm-001",
      ts: ago(6 * MIN),
      ruleId: "rule-001",
      apiName: "Reclamos 2.1.0",
      consumer: "Conecta Sur · conecta-sur-batch",
      sourceIp: "200.54.12.34",
      metric: "volumen",
      observed: 1840,
      baseline: 95,
      score: 14.2,
      actionTaken:
        "Bloqueo propuesto: requiere la aprobación de un aprobador (regla «Volumen anómalo por consumidor»).",
      status: "bloqueo_propuesto",
      initiatedBy: "nexo-guard",
    },
    {
      id: "anm-002",
      ts: ago(25 * MIN),
      ruleId: "rule-003",
      apiName: "Portabilidad numérica 3.0.0",
      consumer: "Red Austral · red-austral-portabilidad",
      sourceIp: "190.98.1.20",
      metric: "latencia",
      observed: 2350,
      baseline: 410,
      score: 6.1,
      actionTaken: "Alerta enviada a Alertmanager, al SIEM y a la mesa de soporte.",
      status: "abierta",
      initiatedBy: "nexo-guard",
    },
    {
      id: "anm-003",
      ts: ago(3 * MIN),
      ruleId: "rule-004",
      apiName: "Concesiones 1.2.0",
      consumer: "Telecom Andina · telecom-andina-app",
      sourceIp: "186.10.4.0/24 (48 IPs)",
      metric: "ips_distintas",
      observed: 48,
      baseline: 3,
      score: 9.8,
      actionTaken: "Bloqueo automático por 15 minutos (política de denegación en WSO2).",
      blockId: "blk-001",
      status: "bloqueada",
      initiatedBy: "nexo-guard",
    },
    {
      id: "anm-004",
      ts: ago(26 * HOUR),
      ruleId: "rule-002",
      apiName: "Espectro radioeléctrico 1.0.0",
      consumer: "Portal de Trámites · portal-tramites",
      sourceIp: "10.30.0.12",
      metric: "errores",
      observed: 0.22,
      baseline: 0.004,
      score: 11.3,
      actionTaken: "Alerta. Se corrigió el backend SAE; resuelta por la mesa de soporte.",
      status: "resuelta",
      initiatedBy: "nexo-guard",
    },
    {
      id: "anm-005",
      ts: ago(2 * DAY),
      ruleId: "rule-001",
      apiName: "Indicadores de calidad de servicio 1.0.0",
      consumer: "Datos Abiertos · datos-abiertos-harvester",
      sourceIp: "164.77.200.5",
      metric: "volumen",
      observed: 620,
      baseline: 140,
      score: 5.2,
      actionTaken: "Descartada: cosecha mensual programada del portal de datos abiertos.",
      status: "descartada",
      approvedBy: "luis.aprobador",
      initiatedBy: "nexo-guard",
    },
    {
      id: "anm-006",
      ts: ago(50 * MIN),
      ruleId: "rule-002",
      apiName: "Trámites ciudadanos 1.0.0",
      consumer: "Mesa de Ayuda Ciudadana · mesa-ayuda-crm",
      sourceIp: "10.30.0.40",
      metric: "errores",
      observed: 0.08,
      baseline: 0.01,
      score: 7.4,
      actionTaken: "Alerta enviada a Alertmanager y al SIEM.",
      status: "abierta",
      initiatedBy: "nexo-guard",
    },
  ];
}

function blocks(now: number): Block[] {
  return [
    {
      id: "blk-001",
      denyPolicyId: "wso2-deny-7f21",
      conditionType: "APPLICATION",
      conditionValue: "telecom-andina-app (Telecom Andina)",
      reason: "IPs distintas: 48 frente a 3 de línea base (regla «IPs distintas por aplicación»).",
      active: true,
      createdAt: new Date(now - 3 * MIN).toISOString(),
      expiresAt: new Date(now + 12 * MIN).toISOString(),
      createdBy: "nexo-guard (automático)",
    },
    {
      id: "blk-002",
      denyPolicyId: "wso2-deny-6c02",
      conditionType: "IP",
      conditionValue: "45.227.10.8",
      reason: "Volumen anómalo desde una IP externa sin suscripción.",
      active: false,
      createdAt: new Date(now - 2 * DAY).toISOString(),
      expiresAt: new Date(now - 2 * DAY + 30 * MIN).toISOString(),
      createdBy: "luis.aprobador",
      releasedBy: "luis.aprobador",
    },
  ];
}

function rollouts(now: number): RolloutRecord[] {
  const thresholds = { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 20 };
  const t = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      id: "rol-0001",
      apiId: "api-concesiones",
      apiName: "Concesiones 1.2.0",
      strategy: "canary",
      candidateEndpoint: "https://concesiones-v13.interno.cliente.invalid",
      stableEndpoint: "https://concesiones-v12.interno.cliente.invalid",
      steps: [5, 25, 50, 100],
      stepDurationSec: 60,
      thresholds,
      environment: "prod",
      status: "en_curso",
      currentWeight: 25,
      stepsDone: [
        {
          weight: 5,
          startedAt: t(9000),
          endedAt: t(3000),
          requests: 412,
          errorRate: 0.004,
          p99Ms: 520,
          decision: "avanzar",
        },
        {
          weight: 25,
          startedAt: t(3000),
          requests: 980,
          errorRate: 0.005,
          p99Ms: 540,
          decision: "pendiente",
        },
      ],
      createdBy: "ana.desarrollo",
      approvedBy: "luis.aprobador",
      createdAt: t(20 * MIN),
      quality: "buena",
    },
    {
      id: "rol-0002",
      apiId: "api-reclamos",
      apiName: "Reclamos 2.1.0",
      strategy: "canary",
      candidateEndpoint: "https://reclamos-v22-mala.interno.cliente.invalid",
      stableEndpoint: "https://reclamos-v21.interno.cliente.invalid",
      steps: [5, 25, 50, 100],
      stepDurationSec: 60,
      thresholds,
      environment: "prod",
      status: "revertido",
      currentWeight: 0,
      stepsDone: [
        {
          weight: 5,
          startedAt: t(3 * HOUR),
          endedAt: t(3 * HOUR - MIN),
          requests: 386,
          errorRate: 0.074,
          p99Ms: 1480,
          decision: "revertir",
        },
      ],
      rollbackReason:
        "Reversa automática: en el paso de 5 % la tasa de errores fue 7,4 % (umbral 2 %) y la latencia p99 1.480 ms (umbral 800 ms). El tráfico volvió al backend estable sin corte.",
      createdBy: "ana.desarrollo",
      approvedBy: "luis.aprobador",
      createdAt: t(3 * HOUR + 10 * MIN),
      quality: "mala",
    },
    {
      id: "rol-0003",
      apiId: "api-espectro",
      apiName: "Espectro radioeléctrico 1.0.0",
      strategy: "blue_green",
      candidateEndpoint: "https://espectro-azul.interno.cliente.invalid",
      stableEndpoint: "https://espectro-verde.interno.cliente.invalid",
      steps: [100],
      stepDurationSec: 120,
      thresholds,
      environment: "prod",
      status: "completado",
      currentWeight: 100,
      stepsDone: [
        {
          weight: 100,
          startedAt: t(2 * DAY),
          endedAt: t(2 * DAY - 2 * MIN),
          requests: 2210,
          errorRate: 0.002,
          p99Ms: 410,
          decision: "avanzar",
        },
      ],
      createdBy: "ana.desarrollo",
      approvedBy: "luis.aprobador",
      createdAt: t(2 * DAY + 30 * MIN),
      quality: "buena",
    },
    {
      id: "rol-0004",
      apiId: "api-portabilidad",
      apiName: "Portabilidad numérica 3.0.0",
      strategy: "canary",
      candidateEndpoint: "https://portabilidad-v31.interno.cliente.invalid",
      stableEndpoint: "https://portabilidad-v30.interno.cliente.invalid",
      steps: [5, 25, 50, 100],
      stepDurationSec: 60,
      thresholds: { maxErrorRate: 0.01, maxP99Ms: 900, minRequests: 30 },
      environment: "prod",
      status: "pendiente_aprobacion",
      currentWeight: 0,
      stepsDone: [],
      createdBy: "ana.desarrollo",
      createdAt: t(40 * MIN),
      quality: "buena",
    },
  ];
}

function failovers(now: number): FailoverRecord[] {
  const drillStart = now - 9 * DAY;
  const backStart = drillStart + 2 * HOUR;
  return [
    {
      id: "fo-0001",
      kind: "simulacro",
      trigger: "simulacro",
      from: "cpd",
      to: "gcp",
      startedAt: new Date(drillStart).toISOString(),
      finishedAt: new Date(drillStart + 412_000).toISOString(),
      rtoSeconds: 412,
      rpoSecondsEstimated: 3,
      steps: stepsAt(drillStart, DRILL_STEPS),
      status: "completado",
      initiatedBy: "carla.operacion",
    },
    {
      id: "fo-0002",
      kind: "retorno",
      trigger: "manual",
      from: "gcp",
      to: "cpd",
      startedAt: new Date(backStart).toISOString(),
      finishedAt: new Date(backStart + 380_000).toISOString(),
      rtoSeconds: 380,
      rpoSecondsEstimated: 0,
      steps: stepsAt(backStart, FAILBACK_STEPS),
      status: "completado",
      approvedBy: "luis.aprobador",
      initiatedBy: "luis.aprobador",
    },
  ];
}

function deadLetters(now: number, synth: SyntheticData): DeadLetter[] {
  const c = (i: number) => synth.concession(i);
  const person = () => synth.person();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const a = c(101);
  const b = c(102);
  const p1 = person();
  const p2 = person();
  return [
    {
      id: "dlq-0001",
      queue: "nexo.concesiones.dlq",
      flow: "Orquestación de concesiones",
      error: "Tiempo de espera agotado al invocar PISEE (30 s).",
      attempts: 5,
      firstFailedAt: ago(40 * MIN),
      status: "pendiente",
      payloadPreview: JSON.stringify(
        {
          rutEmpresa: maskRut(a.rutEmpresa),
          servicio: a.servicio,
          region: a.region,
          solicitud: "CON-2026-08812",
        },
        null,
        2,
      ),
    },
    {
      id: "dlq-0002",
      queue: "nexo.reclamos.dlq",
      flow: "Ingreso de reclamos",
      error: "Validación JSON Schema: falta el campo obligatorio «region».",
      attempts: 3,
      firstFailedAt: ago(2 * HOUR),
      status: "pendiente",
      payloadPreview: JSON.stringify(
        { rut: maskRut(p1.rut), nombre: "*** ***", empresa: b.empresa, motivo: "Cobro indebido" },
        null,
        2,
      ),
    },
    {
      id: "dlq-0003",
      queue: "nexo.portabilidad.dlq",
      flow: "Sincronización de portabilidad",
      error: "El sistema OAP respondió 503 Service Unavailable.",
      attempts: 6,
      firstFailedAt: ago(5 * HOUR),
      status: "pendiente",
      payloadPreview: JSON.stringify(
        { numero: "+569 **** **12", donante: "Red Austral", receptor: "Telecom Andina" },
        null,
        2,
      ),
    },
    {
      id: "dlq-0004",
      queue: "nexo.edi.dlq",
      flow: "Transformación EDI X12",
      error: "Segmento ISA con longitud inválida (se esperaban 106 caracteres).",
      attempts: 2,
      firstFailedAt: ago(9 * HOUR),
      status: "pendiente",
      payloadPreview: "ISA*00*          *00*          *ZZ*CLIENTE*ZZ*********...",
    },
    {
      id: "dlq-0005",
      queue: "nexo.reclamos.dlq",
      flow: "Ingreso de reclamos",
      error: "Clave de idempotencia duplicada: el mensaje ya fue procesado.",
      attempts: 1,
      firstFailedAt: ago(26 * HOUR),
      status: "descartado",
      reprocessedBy: "luis.aprobador",
      payloadPreview: JSON.stringify({ rut: maskRut(p2.rut), idempotencia: "rcl-7781" }, null, 2),
    },
    {
      id: "dlq-0006",
      queue: "nexo.concesiones.dlq",
      flow: "Orquestación de concesiones",
      error: "Oracle ORA-12541: no hay listener (mantención programada).",
      attempts: 5,
      firstFailedAt: ago(3 * DAY),
      status: "reprocesado",
      reprocessedBy: "luis.aprobador",
      payloadPreview: JSON.stringify(
        { rutEmpresa: maskRut(c(103).rutEmpresa), solicitud: "CON-2026-07730" },
        null,
        2,
      ),
    },
  ];
}

function tlsChannels(now: number): TlsChannel[] {
  const v = new Date(now - 2 * HOUR).toISOString();
  return [
    {
      canal: "Consumidores → Gateway",
      origen: "Internet",
      destino: "Gateway WSO2 (CPD)",
      protocolo: "HTTPS",
      versiones: ["TLSv1.3", "TLSv1.2"],
      cifrado: "TLS_AES_256_GCM_SHA384; ECDHE-RSA-AES256-GCM-SHA384",
      verificado: v,
    },
    {
      canal: "Operadores (mTLS) → Gateway",
      origen: "Redes de operadores",
      destino: "Gateway WSO2 (CPD)",
      protocolo: "HTTPS con mTLS",
      versiones: ["TLSv1.3"],
      cifrado: "TLS_AES_256_GCM_SHA384",
      verificado: v,
    },
    {
      canal: "Gateway → Micro Integrator",
      origen: "Gateway WSO2",
      destino: "Micro Integrator",
      protocolo: "HTTPS con mTLS",
      versiones: ["TLSv1.3"],
      cifrado: "TLS_AES_128_GCM_SHA256",
      verificado: v,
    },
    {
      canal: "Micro Integrator → PISEE",
      origen: "Micro Integrator",
      destino: "PISEE",
      protocolo: "HTTPS y WS-Security",
      versiones: ["TLSv1.2"],
      cifrado: "ECDHE-RSA-AES256-GCM-SHA384",
      verificado: v,
    },
    {
      canal: "Consola → API de la Consola",
      origen: "Navegador",
      destino: "API de la Consola",
      protocolo: "HTTPS",
      versiones: ["TLSv1.3"],
      cifrado: "TLS_AES_256_GCM_SHA384",
      verificado: v,
    },
    {
      canal: "API de la Consola → PostgreSQL",
      origen: "API de la Consola",
      destino: "PostgreSQL (nexo_console)",
      protocolo: "TLS (verify-full)",
      versiones: ["TLSv1.3"],
      cifrado: "TLS_AES_256_GCM_SHA384",
      verificado: v,
    },
    {
      canal: "Replicación CPD → GKE",
      origen: "PostgreSQL CPD",
      destino: "CloudNativePG (GKE)",
      protocolo: "TLS",
      versiones: ["TLSv1.3"],
      cifrado: "TLS_AES_256_GCM_SHA384",
      verificado: v,
    },
    {
      canal: "Fluent Bit → SIEM",
      origen: "Fluent Bit",
      destino: "SIEM institucional",
      protocolo: "Syslog sobre TLS",
      versiones: ["TLSv1.2"],
      cifrado: "ECDHE-RSA-AES128-GCM-SHA256",
      verificado: v,
    },
  ];
}

const AUDIT_SEED: Array<{
  minutesAgo: number;
  actor: string;
  type?: "tecnico";
  action: string;
  resource?: string;
  result?: "rechazado" | "error";
  ip?: string;
}> = [
  { minutesAgo: 7 * 1440, actor: "admin.nexo", action: "sesion.inicio", ip: "10.20.1.10" },
  {
    minutesAgo: 7 * 1440 - 5,
    actor: "admin.nexo",
    action: "anomaly.rule.create",
    resource: "anomaly-rule/rule-001",
    ip: "10.20.1.10",
  },
  {
    minutesAgo: 7 * 1440 - 4,
    actor: "admin.nexo",
    action: "anomaly.rule.create",
    resource: "anomaly-rule/rule-004",
    ip: "10.20.1.10",
  },
  {
    minutesAgo: 6 * 1440,
    actor: "admin.nexo",
    action: "catalog.sync",
    resource: "wso2/publisher",
    ip: "10.20.1.10",
  },
  { minutesAgo: 6 * 1440 - 30, actor: "ana.desarrollo", action: "sesion.inicio", ip: "10.20.1.21" },
  {
    minutesAgo: 6 * 1440 - 28,
    actor: "ana.desarrollo",
    action: "catalog.update",
    resource: "api/api-concesiones",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 9 * 1440,
    actor: "carla.operacion",
    action: "continuity.drill",
    resource: "continuity/fo-0001",
    ip: "10.20.1.43",
  },
  {
    minutesAgo: 9 * 1440 - 120,
    actor: "luis.aprobador",
    action: "continuity.failback.approve",
    resource: "continuity/fo-0002",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 3 * 1440,
    actor: "luis.aprobador",
    action: "dlq.reprocess",
    resource: "dead-letter/dlq-0006",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 2 * 1440 + 40,
    actor: "ana.desarrollo",
    action: "rollout.create",
    resource: "rollout/rol-0003",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 2 * 1440 + 20,
    actor: "ana.desarrollo",
    action: "rollout.approve",
    resource: "rollout/rol-0003",
    result: "rechazado",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 2 * 1440 + 10,
    actor: "luis.aprobador",
    action: "rollout.approve",
    resource: "rollout/rol-0003",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 2 * 1440,
    actor: "luis.aprobador",
    action: "anomaly.dismiss",
    resource: "anomaly/anm-005",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 2 * 1440 - 30,
    actor: "luis.aprobador",
    action: "block.release",
    resource: "block/blk-002",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 2 * 1440 - 60,
    actor: "carla.operacion",
    action: "discovery.scan",
    resource: "discovery-scan/scan-001",
    ip: "10.20.1.43",
  },
  {
    minutesAgo: 1440 + 120,
    actor: "luis.aprobador",
    action: "discovery.triage",
    resource: "finding/fnd-003",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 1440 + 60,
    actor: "luis.aprobador",
    action: "dlq.discard",
    resource: "dead-letter/dlq-0005",
    ip: "10.20.1.32",
  },
  { minutesAgo: 1440, actor: "pedro.auditoria", action: "audit.verify", ip: "10.20.1.54" },
  {
    minutesAgo: 1440 - 5,
    actor: "pedro.auditoria",
    action: "export.create",
    resource: "export/exp-0001",
    ip: "10.20.1.54",
  },
  {
    minutesAgo: 1440 - 10,
    actor: "consumidor.demo",
    action: "audit.read",
    result: "rechazado",
    ip: "200.27.14.8",
  },
  {
    minutesAgo: 190,
    actor: "ana.desarrollo",
    action: "rollout.create",
    resource: "rollout/rol-0002",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 182,
    actor: "luis.aprobador",
    action: "rollout.approve",
    resource: "rollout/rol-0002",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 179,
    actor: "nexo-rollout",
    type: "tecnico",
    action: "rollout.revert.automatic",
    resource: "rollout/rol-0002",
    ip: "10.40.0.5",
  },
  {
    minutesAgo: 180,
    actor: "carla.operacion",
    action: "discovery.scan",
    resource: "discovery-scan/scan-002",
    ip: "10.20.1.43",
  },
  {
    minutesAgo: 40,
    actor: "ana.desarrollo",
    action: "rollout.create",
    resource: "rollout/rol-0004",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 20,
    actor: "ana.desarrollo",
    action: "rollout.create",
    resource: "rollout/rol-0001",
    ip: "10.20.1.21",
  },
  {
    minutesAgo: 12,
    actor: "luis.aprobador",
    action: "rollout.approve",
    resource: "rollout/rol-0001",
    ip: "10.20.1.32",
  },
  {
    minutesAgo: 6,
    actor: "nexo-guard",
    type: "tecnico",
    action: "anomaly.block.propose",
    resource: "anomaly/anm-001",
    ip: "10.40.0.6",
  },
  {
    minutesAgo: 3,
    actor: "nexo-guard",
    type: "tecnico",
    action: "anomaly.block.automatic",
    resource: "block/blk-001",
    ip: "10.40.0.6",
  },
];

/** Estado inicial determinista del laboratorio simulado, relativo al instante `now`. */
export function createSeed(now: number): MockState {
  const synth = new SyntheticData(2026);

  const consumers: ConsumerRecord[] = CONSUMER_SEEDS.map((c, i) => ({
    id: consumerId(c.slug),
    organization: c.organization,
    application: c.application,
    plan: c.plan,
    audience: c.audience,
    rut: c.audience === "operadores" ? synth.concession(i + 1).rutEmpresa : formatRut(61_002_000 + i * 17),
  }));
  const consumerBySlug = new Map(CONSUMER_SEEDS.map((c, i) => [c.slug, consumers[i]!]));

  const apis: ApiRecord[] = API_SEEDS.map((seed, i) => {
    const contact = seed.withContact ? synth.person() : null;
    const asset: ApiAsset = {
      id: apiId(seed.slug),
      wso2ApiId: `${(0x5a1c0000 + i * 7919).toString(16)}-${seed.slug.slice(0, 4)}-4b2e-9c11-${(1000 + i).toString(16).padStart(12, "0")}`,
      name: seed.name,
      version: seed.version,
      context: seed.context,
      type: seed.type,
      purpose: seed.purpose,
      ownerTeam: seed.ownerTeam,
      ownerContact: contact ? contact.email.replace("@ejemplo.invalid", "@cliente.invalid") : undefined,
      audience: seed.audience,
      state: seed.state,
      authType: seed.authType,
      contractRef: seed.contractRef,
      classification: seed.classification,
      consumersCount: seed.consumers.length,
      dependenciesCount: 0,
      completeness: 0,
      updatedAt: new Date(now - (i + 1) * 9 * HOUR).toISOString(),
    };
    asset.completeness = completenessOf(asset).completeness;
    return {
      ...asset,
      consumers: seed.consumers.map((slug) => {
        const c = consumerBySlug.get(slug)!;
        return {
          id: `${c.id}-${seed.slug}`,
          name: c.application,
          organization: c.organization,
          plan: c.plan,
          status: "activa",
        };
      }),
      history: [
        {
          ts: new Date(now - 30 * DAY + i * HOUR).toISOString(),
          actor: "admin.nexo",
          action: "Importada desde WSO2",
          detail: "Sincronización inicial del catálogo.",
        },
        {
          ts: asset.updatedAt,
          actor: seed.ownerTeam ? "ana.desarrollo" : "sistema",
          action: "Metadatos actualizados",
          detail: seed.ownerTeam ? "Se registró el equipo dueño y el propósito." : "Ficha creada sin dueño.",
        },
      ],
    };
  });

  const subscriptions: Subscription[] = [];
  API_SEEDS.forEach((seed, i) => {
    seed.consumers.forEach((slug, j) => {
      const c = consumerBySlug.get(slug)!;
      const base =
        c.audience === "publica"
          ? 5200
          : c.audience === "interna"
            ? 3600
            : 1400 + ((i * 7 + j * 13) % 9) * 260;
      subscriptions.push({
        consumerId: c.id,
        apiId: apiId(seed.slug),
        dailyBase: base,
        errorRate: 0.004 + ((i + j) % 5) * 0.0025,
      });
    });
  });

  const graph = buildGraph(apis, consumers);
  for (const api of apis)
    api.dependenciesCount = graph.edges.filter((e) => e.from === api.id || e.to === api.id).length;

  const findingList = findings(now);
  const scanFindings = (id: string) => findingList.filter((f) => f.scanId === id);
  const scans: ScanRecord[] = [
    {
      id: "scan-001",
      status: "terminado",
      startedAt: new Date(now - 2 * DAY).toISOString(),
      finishedAt: new Date(now - 2 * DAY + 4 * MIN).toISOString(),
      sources: ["apisix", "nginx", "red", "gcp"],
      totals: scanTotals(findingList),
      targets: ["10.20.0.0/16", "intranet-legacy.cliente.invalid"],
      readyAt: now - 2 * DAY,
    },
    {
      id: "scan-002",
      status: "terminado",
      startedAt: new Date(now - 3 * HOUR).toISOString(),
      finishedAt: new Date(now - 3 * HOUR + 2 * MIN).toISOString(),
      sources: ["apisix", "nginx"],
      totals: scanTotals(scanFindings("scan-002")),
      targets: [],
      readyAt: now - 3 * HOUR,
    },
  ];

  const audit: MockState["audit"] = [];
  for (const entry of [...AUDIT_SEED].sort((a, b) => b.minutesAgo - a.minutesAgo)) {
    appendAudit(audit, {
      actor: entry.actor,
      actorType: entry.type ?? "usuario",
      action: entry.action,
      resource: entry.resource,
      result: entry.result ?? "exito",
      sourceIp: entry.ip,
      ts: new Date(now - entry.minutesAgo * MIN).toISOString(),
    });
  }

  return {
    version: STATE_VERSION,
    seededAt: now,
    counters: { scan: 2, finding: 10, rule: 5, block: 2, rollout: 4, failover: 2, export: 1 },
    apis,
    consumers,
    subscriptions,
    endpoints: Object.fromEntries(API_SEEDS.map((s) => [apiId(s.slug), s.endpoints])),
    graph,
    scans,
    findings: findingList,
    rules: rules(now),
    anomalies: anomalies(now),
    blocks: blocks(now),
    rollouts: rollouts(now),
    continuity: {
      mode: "automatico",
      activeSite: "cpd",
      quorum: "2 de 3",
      sites: sites(now),
      rtoObjetivoMin: 15,
      rpoObjetivoMin: 5,
    },
    failovers: failovers(now),
    deadLetters: deadLetters(now, synth),
    audit,
    tamper: null,
    exports: [],
    tls: tlsChannels(now),
  };
}
