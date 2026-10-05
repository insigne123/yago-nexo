/** Configuración de la API de la Consola, solo por variables de entorno (12-factor). Las credenciales no tienen valor por defecto. */
const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${k}`);
  return v;
};
const opt = (k: string): string | undefined => process.env[k] || undefined;
const bool = (k: string, d = false) => (process.env[k] ? process.env[k] === "true" : d);

export const config = {
  port: Number(env("NEXO_PORT", "8090")),
  version: env("NEXO_VERSION", "0.1.0"),
  environmentLabel: env("NEXO_ENVIRONMENT_LABEL", "Laboratorio Yago"),
  databaseUrl: env("NEXO_DATABASE_URL"),
  corsOrigins: env("NEXO_CORS_ORIGINS", "http://localhost:5173").split(",").map((s) => s.trim()),
  auth: {
    /** JWKS del proveedor: Keycloak (institución) o Supabase Auth (demo). */
    jwksUrl: env("NEXO_AUTH_JWKS_URL", "http://keycloak:8080/realms/nexo/protocol/openid-connect/certs"),
    issuer: env("NEXO_AUTH_ISSUER", "http://keycloak:8080/realms/nexo"),
    audience: opt("NEXO_AUTH_AUDIENCE"),
    /** Ruta del claim con los roles, por ejemplo resource_access.nexo-console.roles o app_metadata.nexo_roles */
    rolesClaimPath: env("NEXO_AUTH_ROLES_CLAIM", "resource_access.nexo-console.roles"),
  },
  wso2: {
    url: env("NEXO_WSO2_URL", "https://apim:9443"),
    user: env("NEXO_WSO2_USER", "admin"),
    password: env("NEXO_WSO2_PASSWORD"),
    insecureTls: bool("NEXO_WSO2_INSECURE_TLS", true),
    gateways: env("NEXO_WSO2_PROD_GATEWAYS", "Default:apim,Operadores:operadores.nexo.lab").split(",").map((g) => {
      const [name, vhost] = g.split(":");
      return { name: name!, vhost: vhost ?? "localhost" };
    }),
  },
  mi: {
    url: env("NEXO_MI_URL", "https://mi:9164"),
    user: env("NEXO_MI_USER", "admin"),
    password: env("NEXO_MI_PASSWORD"),
  },
  opensearchUrl: env("NEXO_OPENSEARCH_URL", "http://opensearch:9200"),
  /** Credenciales de OpenSearch cuando tiene la seguridad activa (producción); las mismas variables que usan los motores. */
  opensearchUser: opt("NEXO_OPENSEARCH_USER"),
  opensearchPassword: opt("NEXO_OPENSEARCH_PASSWORD"),
  opensearchMetricsIndex: env("NEXO_OPENSEARCH_METRICS_INDEX", "nexo-apim-metrics-*"),
  prometheusUrl: env("NEXO_PROMETHEUS_URL", "http://prometheus:9090"),
  rabbitmq: {
    api: env("NEXO_RABBITMQ_API", "http://rabbitmq:15672/api"),
    user: env("NEXO_RABBITMQ_USER", "nexo"),
    password: env("NEXO_RABBITMQ_PASSWORD"),
    dlq: env("NEXO_RABBITMQ_DLQ", "solicitudes.dlq"),
    reprocessExchange: env("NEXO_RABBITMQ_REPROCESS_EXCHANGE", "nexo.solicitudes"),
    reprocessRoutingKey: env("NEXO_RABBITMQ_REPROCESS_KEY", "nueva"),
  },
  exportDir: env("NEXO_EXPORT_DIR", "/tmp/nexo-exports"),
  /** Endpoints que la matriz TLS sondea (canal|host:puerto|descripción). */
  tlsProbes: env(
    "NEXO_TLS_PROBES",
    "Gateway interno|apim:8243|Consumidores internos y operadores;Control plane|apim:9443|Portales y REST API;Gateway público|gw-publico:8243|Consumo público;Integrador|mi:8253|Gateway → integrador",
  )
    .split(";")
    .map((p) => {
      const [canal, hostPort, desc] = p.split("|");
      const [host, port] = (hostPort ?? "").split(":");
      return { canal: canal!, host: host!, port: Number(port), descripcion: desc ?? "" };
    }),
};

export type Config = typeof config;
