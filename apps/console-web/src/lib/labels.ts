import type {
  AnomalyAction,
  AnomalyMetric,
  Audience,
  Classification,
  DiscoverySource,
  FailoverEvent,
  GraphEdge,
  GraphNodeType,
  ImpactChangeKind,
  ImpactSeverity,
  SiteHealth,
} from "../api/types";

/** Textos en español para los valores enumerados del contrato. */

export const AUDIENCE_LABELS: Record<Audience, string> = {
  interna: "Interna",
  operadores: "Operadores",
  publica: "Pública",
};

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  publica: "Pública",
  interna: "Interna",
  reservada: "Reservada",
  datos_personales: "Datos personales",
};

export const NODE_TYPE_LABELS: Record<GraphNodeType, string> = {
  api: "API",
  flujo: "Flujo",
  sistema: "Sistema",
  dato: "Dato",
  consumidor: "Consumidor",
  reporte: "Reporte",
};

export const RELATION_LABELS: Record<GraphEdge["relation"], string> = {
  llama: "llama a",
  lee: "lee",
  escribe: "escribe en",
  publica: "publica",
  transforma: "transforma",
  consume: "consume",
};

export const EDGE_SOURCE_LABELS: Record<NonNullable<GraphEdge["source"]>, string> = {
  manual: "Registro manual",
  analizador_mi: "Analizador de flujos MI",
  trafico_observado: "Tráfico observado",
  openmetadata: "OpenMetadata",
};

export const CHANGE_KIND_LABELS: Record<ImpactChangeKind, string> = {
  contrato: "Cambio de contrato (OpenAPI o WSDL)",
  campo: "Cambio de un campo",
  fuente: "Cambio de la fuente de datos",
  retiro: "Retiro del activo",
};

export const SEVERITY_LABELS: Record<ImpactSeverity, string> = {
  bajo: "Impacto bajo",
  medio: "Impacto medio",
  alto: "Impacto alto",
};

export const DISCOVERY_SOURCE_LABELS: Record<DiscoverySource, string> = {
  apisix: "APISIX",
  nginx: "NGINX",
  red: "Red (escaneo activo)",
  gcp: "Google Cloud",
};

export const AUTH_DETECTED_LABELS: Record<string, string> = {
  ninguna: "Ninguna",
  basica: "Básica",
  token: "Token",
  mtls: "mTLS",
  desconocida: "Desconocida",
};

export const METRIC_LABELS: Record<AnomalyMetric, string> = {
  volumen: "Volumen de llamadas",
  errores: "Tasa de errores",
  latencia: "Latencia",
  tamano: "Tamaño de mensajes",
  ips_distintas: "IPs distintas",
  fuera_de_horario: "Uso fuera de horario",
};

export const ACTION_LABELS: Record<AnomalyAction, string> = {
  alertar: "Solo alertar",
  bloquear_automatico: "Bloquear automáticamente",
  bloquear_con_aprobacion: "Bloquear con aprobación",
};

export const SITE_ROLE_LABELS: Record<NonNullable<SiteHealth["role"]>, string> = {
  primario: "Primario",
  respaldo: "Respaldo",
  testigo: "Testigo",
};

export const VOTE_LABELS: Record<NonNullable<SiteHealth["vote"]>, string> = {
  primario_sano: "Primario sano",
  primario_caido: "Primario caído",
  sin_voto: "Sin voto",
};

export const CHECK_LABELS: Record<keyof NonNullable<SiteHealth["checks"]>, string> = {
  gateway: "Gateway",
  controlPlane: "Plano de control",
  baseDatos: "Base de datos",
  recorridoSintetico: "Recorrido sintético",
};

export const FAILOVER_KIND_LABELS: Record<NonNullable<FailoverEvent["kind"]>, string> = {
  conmutacion: "Conmutación",
  retorno: "Retorno al sitio principal",
  simulacro: "Simulacro de conmutación",
};

export const FAILOVER_TRIGGER_LABELS: Record<NonNullable<FailoverEvent["trigger"]>, string> = {
  automatico: "Automático (quórum)",
  manual: "Manual",
  simulacro: "Simulacro",
};

export const ENVIRONMENT_LABELS: Record<string, string> = { dev: "Desarrollo", qa: "QA", prod: "Producción" };

export const STRATEGY_LABELS: Record<string, string> = { canary: "Canary", blue_green: "Blue-green" };

export function labelOf<T extends string>(
  map: Record<T, string>,
  value: T | string | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  return (map as Record<string, string>)[value] ?? value;
}
