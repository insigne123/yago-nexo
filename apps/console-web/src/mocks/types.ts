import type {
  AnomalyEvent,
  AnomalyRule,
  ApiAsset,
  ApiAssetDetail,
  AuditEvent,
  Block,
  ContinuityState,
  DeadLetter,
  DiscoveryFinding,
  DiscoveryScan,
  ExportJob,
  FailoverEvent,
  Graph,
  Rollout,
  TlsChannel,
} from "../api/types";

/** Estado del backend simulado. Se guarda en sessionStorage (salvo el consumo, que se regenera). */

export type ConsumerRef = NonNullable<ApiAssetDetail["consumers"]>[number];
export type HistoryEntry = NonNullable<ApiAssetDetail["history"]>[number];

export interface ApiRecord extends ApiAsset {
  consumers: ConsumerRef[];
  history: HistoryEntry[];
}

export interface ConsumerRecord {
  id: string;
  organization: string;
  application: string;
  rut: string;
  plan: string;
  audience: "interna" | "operadores" | "publica";
}

export interface Subscription {
  consumerId: string;
  apiId: string;
  /** Llamadas diarias aproximadas en un día hábil. */
  dailyBase: number;
  errorRate: number;
}

export interface ScanRecord extends DiscoveryScan {
  targets: string[];
  readyAt: number;
}

export interface AnomalyRecord extends AnomalyEvent {
  /** Quién originó la propuesta de bloqueo (cuatro ojos). */
  initiatedBy?: string;
}

export interface RolloutRecord extends Rollout {
  quality: "buena" | "mala";
}

export interface PlannedStep {
  offsetMs: number;
  name: string;
  detail: string;
}

export interface FailoverRecord extends FailoverEvent {
  initiatedBy?: string;
  plannedSteps?: PlannedStep[];
  /** Instante (ms) en que el RTO se considera cumplido: tráfico atendido en el destino. */
  rtoAtOffsetMs?: number;
}

export interface ExportRecord extends ExportJob {
  readyAt: number;
}

export interface TamperState {
  seq: number;
  originalActor: string;
}

export interface MockState {
  version: number;
  seededAt: number;
  counters: Record<string, number>;
  apis: ApiRecord[];
  consumers: ConsumerRecord[];
  subscriptions: Subscription[];
  endpoints: Record<string, string[]>;
  graph: Required<Graph>;
  scans: ScanRecord[];
  findings: DiscoveryFinding[];
  rules: AnomalyRule[];
  anomalies: AnomalyRecord[];
  blocks: Block[];
  rollouts: RolloutRecord[];
  continuity: Required<
    Pick<ContinuityState, "mode" | "activeSite" | "quorum" | "sites" | "rtoObjetivoMin" | "rpoObjetivoMin">
  >;
  failovers: FailoverRecord[];
  deadLetters: DeadLetter[];
  audit: AuditEvent[];
  tamper: TamperState | null;
  exports: ExportRecord[];
  tls: TlsChannel[];
}

export interface UsageDaily {
  day: string;
  consumerId: string;
  apiId: string;
  endpoint: string;
  llamadas: number;
  errores: number;
  bytes: number;
  p95: number;
}
