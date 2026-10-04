import { permissionMatrix, seededRandom } from "@nexo/shared/browser";
import type {
  AnomalyEvent,
  AnomalyRule,
  AnomalyRuleInput,
  AnomalyStatus,
  ApiAsset,
  ApiAssetDetail,
  ApiAssetPatch,
  AuditEvent,
  Block,
  ChainVerification,
  ContinuityMode,
  ContinuityState,
  DiscoveryFinding,
  DiscoveryScan,
  DiscoveryScanRequest,
  ExportJob,
  FailoverEvent,
  FindingStatus,
  Graph,
  ImpactRequest,
  ImpactResult,
  Me,
  Overview,
  Rollout,
  RolloutInput,
  SiteHealth,
  SyncResult,
  TlsChannel,
  UsageGroupBy,
  UsageRow,
} from "../api/types";
import { toCsv } from "../lib/csv";
import { formatMs, formatPercent, isoDate } from "../lib/format";
import { sha256Hex } from "../lib/sha256";
import { appendAudit, verifyAudit } from "./audit";
import { badRequest, conflict, HttpError, notFound } from "./errors";
import { isSameActor, type Actor } from "./identity";
import { simulateImpact } from "./impact";
import { completenessOf, createSeed, DRILL_STEPS, FAILBACK_STEPS, scanTotals, STATE_VERSION } from "./seed";
import type {
  ApiRecord,
  ExportRecord,
  FailoverRecord,
  MockState,
  PlannedStep,
  RolloutRecord,
  ScanRecord,
  UsageDaily,
} from "./types";
import { aggregateUsage, generateUsage, scaledRows } from "./usage";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface MockStoreOptions {
  now?: () => number;
  storage?: StorageLike | null;
  /** Base de la API, para armar URLs de descarga. */
  baseUrl?: string;
  /** Aceleración del tiempo simulado: con 10, un paso de 60 s dura 6 s (mínimo 4 s, máximo 15 s). */
  timeScale?: number;
}

const STORAGE_KEY = "nexo-mock-state";
const DEFAULT_THRESHOLDS = { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 20 };
const FOUR_EYES_MESSAGE =
  "Regla de cuatro ojos: quien aprueba debe ser una persona distinta de quien inició la acción.";

const FINDING_STATUSES: readonly FindingStatus[] = [
  "nuevo",
  "gobernado",
  "riesgo_aceptado",
  "en_migracion",
  "descartado",
];
const METRICS = ["volumen", "errores", "latencia", "tamano", "ips_distintas", "fuera_de_horario"] as const;
const ACTIONS = ["alertar", "bloquear_automatico", "bloquear_con_aprobacion"] as const;

function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Quita campos internos del simulador antes de responder (la respuesta respeta el contrato). */
function publicRollout({ quality: _quality, ...rest }: RolloutRecord): Rollout {
  return structuredClone(rest);
}

function publicFailover({
  initiatedBy: _i,
  plannedSteps: _p,
  rtoAtOffsetMs: _r,
  ...rest
}: FailoverRecord): FailoverEvent {
  return structuredClone(rest);
}

function publicScan({ targets: _t, readyAt: _r, ...rest }: ScanRecord): DiscoveryScan {
  return structuredClone(rest);
}

function publicExport({ readyAt: _r, ...rest }: ExportRecord): ExportJob {
  return structuredClone(rest);
}

function publicAnomaly(record: AnomalyEvent & { initiatedBy?: string }): AnomalyEvent {
  const { initiatedBy: _i, ...rest } = record;
  return structuredClone(rest);
}

function toAsset({ consumers: _c, history: _h, ...rest }: ApiRecord): ApiAsset {
  return structuredClone(rest);
}

const HIDDEN_BY_SOURCE: Record<
  "apisix" | "nginx" | "gcp",
  Omit<DiscoveryFinding, "id" | "scanId" | "status" | "firstSeen" | "lastSeen">
> = {
  apisix: {
    source: "apisix",
    host: "apisix.lab.subtel.invalid",
    port: 9080,
    path: "/interno/fiscalizacion-beta",
    protocol: "HTTP/1.1",
    specFound: false,
    authDetected: "ninguna",
    tls: "Sin TLS",
    personalDataSuspected: false,
    exposureScore: 74,
    reasons: [
      "Ruta publicada en APISIX sin plugin de autenticación",
      "Versión beta de Fiscalización fuera del ciclo de vida de WSO2",
      "Sin dueño registrado",
    ],
  },
  nginx: {
    source: "nginx",
    host: "intranet-legacy.subtel.invalid",
    port: 80,
    path: "/ws/ConcesionesLegacy?wsdl",
    protocol: "SOAP 1.1",
    specFound: true,
    authDetected: "ninguna",
    tls: "Sin TLS",
    personalDataSuspected: true,
    exposureScore: 86,
    reasons: [
      "Servicio SOAP heredado sin autenticación",
      "Tráfico sin cifrar",
      "El WSDL incluye el RUT del representante legal",
    ],
  },
  gcp: {
    source: "gcp",
    host: "tramites-export-k2p9.a.run.app",
    port: 443,
    path: "/v1/export",
    protocol: "HTTPS",
    specFound: true,
    authDetected: "token",
    tls: "TLS 1.3",
    personalDataSuspected: true,
    exposureScore: 58,
    reasons: [
      "Exportación masiva fuera del gateway",
      "La especificación incluye datos personales",
      "No registrada en el catálogo de WSO2",
    ],
  },
};

const SPEC_PATHS = ["/openapi.json", "/swagger.json", "/v3/api-docs", "/graphql", "/servicio?wsdl"];
const AUTHS = ["ninguna", "basica", "token", "mtls"] as const;
const TLS = ["Sin TLS", "TLS 1.0", "TLS 1.2", "TLS 1.3"] as const;

/** Hallazgo determinista para un host o rango autorizado del escaneo activo. */
function findingForTarget(
  target: string,
): Omit<DiscoveryFinding, "id" | "scanId" | "status" | "firstSeen" | "lastSeen"> {
  const h = hashString(target);
  const cidr = /^(\d+\.\d+\.\d+)\.\d+\/\d+$/.exec(target);
  const hostWithPort = cidr ? `${cidr[1]}.${20 + (h % 200)}` : target;
  const [host = hostWithPort, portText] = hostWithPort.split(":");
  const auth = AUTHS[h % AUTHS.length]!;
  const tls = TLS[(h >> 3) % TLS.length]!;
  const path = SPEC_PATHS[(h >> 5) % SPEC_PATHS.length]!;
  const reasons: string[] = ["No registrada en el catálogo de WSO2"];
  let score = 20;
  if (auth === "ninguna") {
    score += 38;
    reasons.unshift("Sin autenticación");
  } else if (auth === "basica") {
    score += 22;
    reasons.unshift("Autenticación básica");
  }
  if (tls === "Sin TLS") {
    score += 24;
    reasons.push("Tráfico sin cifrar");
  } else if (tls === "TLS 1.0") {
    score += 18;
    reasons.push("TLS 1.0 (versión obsoleta)");
  }
  const personal = h % 3 === 0;
  if (personal) {
    score += 12;
    reasons.push("Posibles datos personales en la especificación");
  }
  return {
    source: "red",
    host,
    port: portText ? Number(portText) : tls === "Sin TLS" ? 8080 : 8443,
    path,
    protocol: path.includes("wsdl") ? "SOAP 1.1" : tls === "Sin TLS" ? "HTTP/1.1" : "HTTPS",
    specFound: true,
    authDetected: auth,
    tls,
    personalDataSuspected: personal,
    exposureScore: Math.min(100, score),
    reasons,
  };
}

export class MockStore {
  private state: MockState;
  private usage: UsageDaily[];
  private readonly clock: () => number;
  private readonly storage: StorageLike | null;
  private readonly baseUrl: string;
  private readonly timeScale: number;

  constructor(options: MockStoreOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.storage = options.storage ?? null;
    this.baseUrl = (options.baseUrl ?? "/api/v1").replace(/\/+$/, "");
    this.timeScale = options.timeScale ?? 10;
    this.state = this.restore() ?? createSeed(this.clock());
    this.usage = generateUsage(this.state, this.clock());
  }

  /* -------------------------------------------------------------- utilidades */

  now(): number {
    return this.clock();
  }

  private iso(ms: number = this.clock()): string {
    return new Date(ms).toISOString();
  }

  private nextId(prefix: string, counter: string): string {
    const n = (this.state.counters[counter] ?? 0) + 1;
    this.state.counters[counter] = n;
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  private restore(): MockState | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as MockState;
      return parsed?.version === STATE_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  persist(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Sin almacenamiento disponible: el estado vive solo en memoria.
    }
  }

  reset(): void {
    this.state = createSeed(this.clock());
    this.usage = generateUsage(this.state, this.clock());
    this.persist();
  }

  /** Registra un evento de auditoría encadenado. Un actor de tipo texto es una identidad técnica. */
  audit(
    actor: Actor | string,
    action: string,
    resource?: string,
    result: "exito" | "rechazado" | "error" = "exito",
  ): void {
    const technical = typeof actor === "string";
    appendAudit(this.state.audit, {
      actor: technical ? actor : actor.username,
      actorType: technical ? "tecnico" : "usuario",
      action,
      resource,
      result,
      sourceIp: technical ? "10.40.0.5" : actor.sourceIp,
      ts: this.iso(),
    });
  }

  /* -------------------------------------------------------- avance del tiempo */

  /** Avanza las simulaciones según el reloj. Devuelve true si algo cambió. */
  tick(): boolean {
    const now = this.clock();
    let changed = false;
    changed = this.tickRollouts(now) || changed;
    changed = this.tickScans(now) || changed;
    changed = this.tickFailovers(now) || changed;
    changed = this.tickExports(now) || changed;
    changed = this.tickBlocks(now) || changed;
    for (const site of this.state.continuity.sites) {
      site.lastSeen = this.iso(now - 4000 - (hashString(site.id ?? "") % 9000));
    }
    if (changed) this.persist();
    return changed;
  }

  private stepMs(rollout: Rollout): number {
    return Math.min(15_000, Math.max(4_000, (rollout.stepDurationSec * 1000) / this.timeScale));
  }

  private stepMetrics(rollout: RolloutRecord, weight: number) {
    const random = seededRandom(hashString(`${rollout.id}:${weight}`));
    const requests = Math.round((weight / 100) * 9000 * (0.8 + random() * 0.4) + 60);
    if (rollout.quality === "mala") {
      return { requests, errorRate: 0.06 + random() * 0.04, p99Ms: Math.round(1300 + random() * 400) };
    }
    return { requests, errorRate: 0.002 + random() * 0.006, p99Ms: Math.round(380 + random() * 220) };
  }

  private startRollout(rollout: RolloutRecord, at: number): void {
    const first = rollout.steps[0] ?? 100;
    rollout.status = "en_curso";
    rollout.currentWeight = first;
    rollout.stepsDone = [
      { weight: first, startedAt: this.iso(at), requests: 0, errorRate: 0, p99Ms: 0, decision: "pendiente" },
    ];
  }

  private tickRollouts(now: number): boolean {
    let changed = false;
    for (const rollout of this.state.rollouts) {
      if (rollout.status !== "en_curso") continue;
      const stepMs = this.stepMs(rollout);
      const thresholds = rollout.thresholds ?? DEFAULT_THRESHOLDS;
      for (let guard = 0; guard < 20 && rollout.status === "en_curso"; guard++) {
        const steps = (rollout.stepsDone ??= []);
        const current = steps.at(-1);
        if (!current?.startedAt) break;
        const started = Date.parse(current.startedAt);
        const metrics = this.stepMetrics(rollout, current.weight ?? 0);
        if (now - started < stepMs) {
          // Métricas parciales del paso en curso.
          const progress = (now - started) / stepMs;
          current.requests = Math.round(metrics.requests * progress);
          current.errorRate = metrics.errorRate;
          current.p99Ms = metrics.p99Ms;
          changed = true;
          break;
        }
        const end = started + stepMs;
        Object.assign(current, metrics, { endedAt: this.iso(end) });
        const failed =
          metrics.requests >= thresholds.minRequests &&
          (metrics.errorRate > thresholds.maxErrorRate || metrics.p99Ms > thresholds.maxP99Ms);
        if (failed) {
          current.decision = "revertir";
          rollout.status = "revertido";
          rollout.currentWeight = 0;
          const causes: string[] = [];
          if (metrics.errorRate > thresholds.maxErrorRate)
            causes.push(
              `la tasa de errores fue ${formatPercent(metrics.errorRate)} (umbral ${formatPercent(thresholds.maxErrorRate)})`,
            );
          if (metrics.p99Ms > thresholds.maxP99Ms)
            causes.push(
              `la latencia p99 fue ${formatMs(metrics.p99Ms)} (umbral ${formatMs(thresholds.maxP99Ms)})`,
            );
          rollout.rollbackReason = `Reversa automática: en el paso de ${current.weight} % ${causes.join(" y ")}. El tráfico volvió al backend estable sin corte.`;
          this.audit("nexo-rollout", "rollout.revert.automatic", `rollout/${rollout.id}`);
        } else {
          current.decision = "avanzar";
          const index = rollout.steps.indexOf(current.weight ?? -1);
          const next = rollout.steps[index + 1];
          if (next === undefined) {
            rollout.status = "completado";
            rollout.currentWeight = 100;
            this.audit("nexo-rollout", "rollout.complete", `rollout/${rollout.id}`);
          } else {
            rollout.currentWeight = next;
            steps.push({
              weight: next,
              startedAt: this.iso(end),
              requests: 0,
              errorRate: 0,
              p99Ms: 0,
              decision: "pendiente",
            });
          }
        }
        changed = true;
      }
    }
    return changed;
  }

  private tickScans(now: number): boolean {
    let changed = false;
    for (const scan of this.state.scans) {
      if (scan.status !== "en_curso" || now < scan.readyAt) continue;
      this.completeScan(scan, now);
      changed = true;
    }
    return changed;
  }

  private completeScan(scan: ScanRecord, now: number): void {
    const seenAt = this.iso(now);
    const touch = (finding: DiscoveryFinding) => {
      finding.lastSeen = seenAt;
      finding.scanId = scan.id;
    };
    const upsert = (data: Omit<DiscoveryFinding, "id" | "scanId" | "status" | "firstSeen" | "lastSeen">) => {
      const existing = this.state.findings.find((f) => f.host === data.host && f.path === data.path);
      if (existing) {
        touch(existing);
        return;
      }
      this.state.findings.push({
        ...data,
        id: this.nextId("fnd", "finding"),
        scanId: scan.id,
        status: "nuevo",
        firstSeen: seenAt,
        lastSeen: seenAt,
      });
    };
    for (const source of scan.sources ?? []) {
      if (source === "apisix" || source === "nginx" || source === "gcp") {
        for (const f of this.state.findings.filter((x) => x.source === source)) touch(f);
        upsert(HIDDEN_BY_SOURCE[source]);
      }
    }
    if (scan.sources?.includes("red")) {
      for (const target of scan.targets.slice(0, 5)) upsert(findingForTarget(target));
    }
    scan.status = "terminado";
    scan.finishedAt = seenAt;
    scan.totals = scanTotals(this.state.findings.filter((f) => f.scanId === scan.id));
    this.audit("nexo-discovery", "discovery.scan.complete", `discovery-scan/${scan.id}`);
  }

  private site(id: string | undefined): SiteHealth | undefined {
    return this.state.continuity.sites.find((s) => s.id === id);
  }

  private setActiveSite(id: string | undefined): void {
    if (!id) return;
    this.state.continuity.activeSite = id;
    for (const s of this.state.continuity.sites) s.active = s.id === id;
  }

  private primarySite(): string {
    return this.state.continuity.sites.find((s) => s.role === "primario")?.id ?? "cpd";
  }

  private healAllSites(): void {
    for (const s of this.state.continuity.sites) {
      s.vote = "primario_sano";
      s.checks =
        s.role === "testigo"
          ? {
              gateway: "desconocido",
              controlPlane: "desconocido",
              baseDatos: "desconocido",
              recorridoSintetico: "ok",
            }
          : { gateway: "ok", controlPlane: "ok", baseDatos: "ok", recorridoSintetico: "ok" };
    }
  }

  private applyFailoverEffects(event: FailoverRecord, reached: number): void {
    if (event.kind === "retorno") {
      if (reached >= 5) this.setActiveSite(event.to);
      return;
    }
    const from = this.site(event.from);
    if (reached >= 1 && from) {
      from.checks = { ...from.checks, gateway: "falla", recorridoSintetico: "falla" };
      from.vote = "sin_voto";
    }
    if (reached >= 2) {
      for (const s of this.state.continuity.sites) if (s.id !== event.from) s.vote = "primario_caido";
    }
    if (reached >= 6) this.setActiveSite(event.to);
  }

  private tickFailovers(now: number): boolean {
    let changed = false;
    for (const event of this.state.failovers) {
      if (event.status !== "en_curso" || !event.plannedSteps || !event.startedAt) continue;
      const started = Date.parse(event.startedAt);
      const elapsed = now - started;
      const due = event.plannedSteps.filter((s) => s.offsetMs <= elapsed);
      if (due.length > (event.steps?.length ?? 0)) {
        event.steps = due.map((s) => ({
          name: s.name,
          status: "ok",
          ts: this.iso(started + s.offsetMs),
          detail: s.detail,
        }));
        this.applyFailoverEffects(event, due.length);
        changed = true;
      }
      const last = event.plannedSteps.at(-1);
      if (last && elapsed >= last.offsetMs + 500) {
        event.status = "completado";
        event.finishedAt = this.iso(started + last.offsetMs + 500);
        event.rtoSeconds = Math.round((event.rtoAtOffsetMs ?? last.offsetMs) / 1000);
        event.rpoSecondsEstimated = event.kind === "retorno" ? 0 : 2;
        this.healAllSites();
        this.audit(
          "nexo-failover",
          event.kind === "retorno" ? "continuity.failback.complete" : "continuity.drill.complete",
          `continuity/${event.id}`,
        );
        changed = true;
      }
    }
    return changed;
  }

  private tickExports(now: number): boolean {
    let changed = false;
    for (const job of this.state.exports) {
      if (job.status !== "en_curso" || now < job.readyAt) continue;
      job.status = "listo";
      job.manifest = { version: "nexo-export/1.0", items: this.exportItems(job.id ?? "") };
      job.downloadUrl = `${this.baseUrl}/exports/${job.id}/download`;
      changed = true;
    }
    return changed;
  }

  private tickBlocks(now: number): boolean {
    let changed = false;
    for (const block of this.state.blocks) {
      if (!block.active || !block.expiresAt || Date.parse(block.expiresAt) > now) continue;
      block.active = false;
      block.releasedBy = "nexo-guard (vencimiento)";
      for (const a of this.state.anomalies)
        if (a.blockId === block.id && a.status === "bloqueada") a.status = "resuelta";
      this.audit("nexo-guard", "block.expire", `block/${block.id}`);
      changed = true;
    }
    return changed;
  }

  /* ---------------------------------------------------------------- sesión */

  me(actor: Actor): Me {
    return {
      sub: actor.sub,
      name: actor.name,
      email: actor.email,
      roles: [...actor.roles],
      permissions: [...actor.permissions],
    };
  }

  overview(): Overview {
    const { sites, activeSite } = this.state.continuity;
    const status = (s: SiteHealth): "ok" | "degradado" | "caido" | "desconocido" => {
      const c = s.checks ?? {};
      if (s.role === "testigo") return c.recorridoSintetico === "ok" ? "ok" : "desconocido";
      if (c.gateway === "falla" && c.recorridoSintetico === "falla") return "caido";
      if (Object.values(c).includes("falla")) return "degradado";
      return Object.values(c).every((v) => v === "ok") ? "ok" : "desconocido";
    };
    const apis = this.state.apis.filter((a) => a.state !== "RETIRED");
    const today = scaledRows(this.usage, this.clock(), { from: isoDate(new Date(this.clock())) });
    const llamadas = today.reduce((s, r) => s + r.llamadas, 0);
    const p95 = llamadas ? today.reduce((s, r) => s + r.p95 * r.llamadas, 0) / llamadas : 0;
    const anomalias = this.state.anomalies.filter(
      (a) => a.status === "abierta" || a.status === "bloqueo_propuesto",
    ).length;
    const hallazgos = this.state.findings.filter((f) => f.status === "nuevo").length;
    const mensajesFallidos = this.state.deadLetters.filter((d) => d.status === "pendiente").length;
    const weekAgo = this.clock() - 7 * 86_400_000;
    return {
      sites: sites.map((s) => ({
        id: s.id ?? "",
        name: s.name ?? s.id ?? "",
        status: status(s),
        active: s.id === activeSite,
      })),
      apis: {
        total: apis.length,
        publicadas: apis.filter((a) => a.state === "PUBLISHED").length,
        deprecadas: apis.filter((a) => a.state === "DEPRECATED").length,
        completitudPromedio: Math.round(
          apis.reduce((s, a) => s + a.completeness, 0) / Math.max(1, apis.length),
        ),
      },
      alertas: { abiertas: anomalias + hallazgos + mensajesFallidos, anomalias, hallazgos, mensajesFallidos },
      consumoHoy: {
        llamadas,
        errores: today.reduce((s, r) => s + r.errores, 0),
        latenciaP95Ms: Math.round(p95),
      },
      despliegues: {
        enCurso: this.state.rollouts.filter((r) => r.status === "en_curso").length,
        revertidos7d: this.state.rollouts.filter(
          (r) => r.status === "revertido" && Date.parse(r.createdAt ?? "") >= weekAgo,
        ).length,
      },
    };
  }

  /* -------------------------------------------------------------- catálogo */

  listApis(filters: { q?: string | null; audience?: string | null; state?: string | null }): ApiAsset[] {
    const q = filters.q?.trim().toLowerCase();
    return this.state.apis
      .filter((a) => !filters.audience || a.audience === filters.audience)
      .filter((a) => !filters.state || a.state === filters.state)
      .filter(
        (a) => !q || [a.name, a.context, a.ownerTeam, a.purpose].some((v) => v?.toLowerCase().includes(q)),
      )
      .map(toAsset);
  }

  private findApi(id: string): ApiRecord {
    const api = this.state.apis.find((a) => a.id === id);
    if (!api) throw notFound(`La API ${id}`);
    return api;
  }

  apiDetail(id: string): ApiAssetDetail {
    const api = this.findApi(id);
    const { missing } = completenessOf(api);
    return {
      ...toAsset(api),
      consumers: structuredClone(api.consumers),
      dependencies: this.state.graph.edges.filter((e) => e.from === id || e.to === id).map((e) => ({ ...e })),
      missingFields: missing,
      history: structuredClone(api.history),
    };
  }

  patchApi(id: string, patch: ApiAssetPatch, actor: Actor): ApiAssetDetail {
    const api = this.findApi(id);
    const limits: Record<keyof ApiAssetPatch, number> = {
      purpose: 1000,
      ownerTeam: 200,
      ownerContact: 200,
      audience: 20,
      classification: 30,
      contractRef: 300,
    };
    const changed: string[] = [];
    for (const key of Object.keys(limits) as Array<keyof ApiAssetPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > limits[key])
        throw badRequest(`El campo ${key} no es válido.`);
      if (key === "audience" && !["interna", "operadores", "publica"].includes(value))
        throw badRequest("Audiencia no válida.");
      if (
        key === "classification" &&
        !["publica", "interna", "reservada", "datos_personales"].includes(value)
      )
        throw badRequest("Clasificación no válida.");
      (api as unknown as Record<string, unknown>)[key] = value.trim() === "" ? undefined : value.trim();
      changed.push(key);
    }
    api.completeness = completenessOf(api).completeness;
    api.updatedAt = this.iso();
    if (changed.length > 0) {
      api.history.push({
        ts: api.updatedAt,
        actor: actor.username,
        action: "Metadatos actualizados",
        detail: `Campos modificados: ${changed.join(", ")}.`,
      });
      const node = this.state.graph.nodes.find((n) => n.id === id);
      if (node?.meta && patch.classification) node.meta.classification = patch.classification;
    }
    this.audit(actor, "catalog.update", `api/${id}`);
    this.persist();
    return this.apiDetail(id);
  }

  syncCatalog(actor: Actor): SyncResult {
    const at = this.iso();
    for (const api of this.state.apis)
      api.history.push({
        ts: at,
        actor: actor.username,
        action: "Sincronizada con WSO2",
        detail: "Publisher, suscripciones y aplicaciones.",
      });
    this.audit(actor, "catalog.sync", "wso2/publisher");
    this.persist();
    return {
      apis: this.state.apis.length,
      consumers: this.state.consumers.length,
      subscriptions: this.state.subscriptions.length,
      durationMs: 1100 + (hashString(at) % 900),
    };
  }

  graph(): Graph {
    return structuredClone(this.state.graph);
  }

  simulate(request: ImpactRequest): ImpactResult {
    if (!this.state.graph.nodes.some((n) => n.id === request.nodeId))
      throw notFound(`El nodo ${request.nodeId}`);
    if (!["contrato", "campo", "fuente", "retiro"].includes(request.change?.kind))
      throw badRequest("Tipo de cambio no válido.");
    return simulateImpact(
      this.state.graph.nodes,
      this.state.graph.edges,
      request.nodeId,
      request.change.kind,
    );
  }

  /* --------------------------------------------------------- descubrimiento */

  scans(): DiscoveryScan[] {
    return [...this.state.scans].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(publicScan);
  }

  createScan(request: DiscoveryScanRequest, actor: Actor): DiscoveryScan {
    const sources = (request.sources ?? []).filter((s) => ["apisix", "nginx", "red", "gcp"].includes(s));
    if (sources.length === 0) throw badRequest("Indique al menos una fuente.");
    const targets = (request.targets ?? []).map((t) => t.trim()).filter(Boolean);
    if (sources.includes("red") && targets.length === 0)
      throw badRequest("El escaneo de red necesita hosts o rangos autorizados.");
    const now = this.clock();
    const scan: ScanRecord = {
      id: this.nextId("scan", "scan"),
      status: "en_curso",
      startedAt: this.iso(now),
      sources,
      targets,
      readyAt: now + 6000,
    };
    this.state.scans.push(scan);
    this.audit(actor, "discovery.scan", `discovery-scan/${scan.id}`);
    this.persist();
    return publicScan(scan);
  }

  findings(status?: string | null): DiscoveryFinding[] {
    return this.state.findings
      .filter((f) => !status || f.status === status)
      .sort((a, b) => b.exposureScore - a.exposureScore)
      .map((f) => structuredClone(f));
  }

  triage(id: string, body: { status?: string; note?: string }, actor: Actor): DiscoveryFinding {
    const finding = this.state.findings.find((f) => f.id === id);
    if (!finding) throw notFound(`El hallazgo ${id}`);
    if (!body.status || !FINDING_STATUSES.includes(body.status as FindingStatus))
      throw badRequest("Estado no válido.");
    if (body.note && body.note.length > 1000) throw badRequest("La nota supera los 1000 caracteres.");
    finding.status = body.status as FindingStatus;
    if (body.note?.trim()) {
      finding.reasons = [
        ...(finding.reasons ?? []).filter((r) => !r.startsWith("Nota de clasificación")),
        `Nota de clasificación (${actor.username}): ${body.note.trim()}`,
      ];
    }
    this.audit(actor, "discovery.triage", `finding/${id}`);
    this.persist();
    return structuredClone(finding);
  }

  discoveryReport(format: string | null): { body: string; type: string; filename: string } {
    const list = this.findings();
    if (format === "csv") {
      const csv = toCsv(list, [
        { header: "id", value: (f) => f.id },
        { header: "fuente", value: (f) => f.source },
        { header: "host", value: (f) => f.host },
        { header: "puerto", value: (f) => f.port },
        { header: "ruta", value: (f) => f.path },
        { header: "protocolo", value: (f) => f.protocol },
        { header: "especificacion", value: (f) => (f.specFound ? "si" : "no") },
        { header: "autenticacion", value: (f) => f.authDetected },
        { header: "tls", value: (f) => f.tls },
        { header: "datos_personales", value: (f) => (f.personalDataSuspected ? "si" : "no") },
        { header: "puntaje_exposicion", value: (f) => f.exposureScore },
        { header: "estado", value: (f) => f.status },
        { header: "api_vinculada", value: (f) => f.matchedApiId },
        { header: "motivos", value: (f) => f.reasons },
        { header: "visto_por_primera_vez", value: (f) => f.firstSeen },
        { header: "visto_por_ultima_vez", value: (f) => f.lastSeen },
      ]);
      return {
        body: csv,
        type: "text/csv; charset=utf-8",
        filename: `reporte-exposicion-${isoDate(new Date(this.clock()))}.csv`,
      };
    }
    const body = JSON.stringify(
      { generadoEn: this.iso(), totales: scanTotals(list), hallazgos: list },
      null,
      2,
    );
    return { body, type: "application/json", filename: "reporte-exposicion.json" };
  }

  /* -------------------------------------------------------------- anomalías */

  rules(): AnomalyRule[] {
    return structuredClone(this.state.rules);
  }

  private validateRule(input: Partial<AnomalyRuleInput>): AnomalyRuleInput {
    if (!input.name || input.name.trim().length < 3)
      throw badRequest("El nombre de la regla es obligatorio.");
    if (!input.metric || !(METRICS as readonly string[]).includes(input.metric))
      throw badRequest("Métrica no válida.");
    if (typeof input.sensitivity !== "number" || input.sensitivity < 1 || input.sensitivity > 10)
      throw badRequest("La sensibilidad debe estar entre 1 y 10.");
    if (!input.action || !(ACTIONS as readonly string[]).includes(input.action))
      throw badRequest("Acción no válida.");
    return {
      name: input.name.trim(),
      apiId: input.apiId || undefined,
      consumerId: input.consumerId || undefined,
      metric: input.metric,
      sensitivity: input.sensitivity,
      minVolume: input.minVolume ?? 30,
      action: input.action,
      blockTtlMinutes: input.blockTtlMinutes ?? 30,
      enabled: input.enabled ?? true,
    };
  }

  createRule(input: Partial<AnomalyRuleInput>, actor: Actor): AnomalyRule {
    const rule: AnomalyRule = {
      ...this.validateRule(input),
      id: this.nextId("rule", "rule"),
      createdBy: actor.username,
      updatedAt: this.iso(),
    };
    this.state.rules.push(rule);
    this.audit(actor, "anomaly.rule.create", `anomaly-rule/${rule.id}`);
    this.persist();
    return structuredClone(rule);
  }

  updateRule(id: string, input: Partial<AnomalyRuleInput>, actor: Actor): AnomalyRule {
    const index = this.state.rules.findIndex((r) => r.id === id);
    const current = this.state.rules[index];
    if (!current) throw notFound(`La regla ${id}`);
    const rule: AnomalyRule = {
      ...this.validateRule(input),
      id,
      createdBy: current.createdBy,
      updatedAt: this.iso(),
    };
    this.state.rules[index] = rule;
    this.audit(actor, "anomaly.rule.update", `anomaly-rule/${id}`);
    this.persist();
    return structuredClone(rule);
  }

  anomalies(status?: string | null): AnomalyEvent[] {
    return this.state.anomalies
      .filter((a) => !status || a.status === status)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .map(publicAnomaly);
  }

  private findAnomaly(id: string) {
    const anomaly = this.state.anomalies.find((a) => a.id === id);
    if (!anomaly) throw notFound(`La anomalía ${id}`);
    return anomaly;
  }

  approveBlock(id: string, actor: Actor): AnomalyEvent {
    const anomaly = this.findAnomaly(id);
    if (anomaly.status !== "bloqueo_propuesto")
      throw conflict("La anomalía no tiene un bloqueo propuesto pendiente.");
    if (isSameActor(actor, anomaly.initiatedBy)) throw new HttpError(403, FOUR_EYES_MESSAGE);
    const rule = this.state.rules.find((r) => r.id === anomaly.ruleId);
    const ttl = rule?.blockTtlMinutes ?? 30;
    const now = this.clock();
    const block: Block = {
      id: this.nextId("blk", "block"),
      denyPolicyId: `wso2-deny-${sha256Hex(`${id}${now}`).slice(0, 4)}`,
      conditionType: "APPLICATION",
      conditionValue: anomaly.consumer ?? anomaly.sourceIp ?? "desconocido",
      reason: `${anomaly.metric}: ${anomaly.observed} frente a ${anomaly.baseline} de línea base (regla «${rule?.name ?? anomaly.ruleId}»).`,
      active: true,
      createdAt: this.iso(now),
      expiresAt: this.iso(now + ttl * 60_000),
      createdBy: actor.username,
    };
    this.state.blocks.push(block);
    anomaly.status = "bloqueada";
    anomaly.blockId = block.id;
    anomaly.approvedBy = actor.username;
    anomaly.actionTaken = `Bloqueo aprobado por ${actor.username} por ${ttl} minutos (política ${block.denyPolicyId} en WSO2).`;
    this.audit(actor, "anomaly.block.approve", `anomaly/${id}`);
    this.persist();
    return publicAnomaly(anomaly);
  }

  dismissAnomaly(id: string, reason: string | undefined, actor: Actor): AnomalyEvent {
    const anomaly = this.findAnomaly(id);
    const open: AnomalyStatus[] = ["abierta", "bloqueo_propuesto"];
    if (!open.includes(anomaly.status))
      throw conflict("Solo se pueden descartar anomalías abiertas o con bloqueo propuesto.");
    anomaly.status = "descartada";
    anomaly.approvedBy = actor.username;
    anomaly.actionTaken = `Descartada por ${actor.username}${reason ? `: ${reason}` : "."}`;
    this.audit(actor, "anomaly.dismiss", `anomaly/${id}`);
    this.persist();
    return publicAnomaly(anomaly);
  }

  blocks(): Block[] {
    return [...this.state.blocks]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((b) => structuredClone(b));
  }

  releaseBlock(id: string, reason: string | undefined, actor: Actor): Block {
    const block = this.state.blocks.find((b) => b.id === id);
    if (!block) throw notFound(`El bloqueo ${id}`);
    if (!block.active) throw conflict("El bloqueo ya no está activo.");
    block.active = false;
    block.releasedBy = actor.username;
    if (reason) block.reason = `${block.reason ?? ""} Liberado: ${reason}`.trim();
    for (const a of this.state.anomalies)
      if (a.blockId === id && a.status === "bloqueada") a.status = "resuelta";
    this.audit(actor, "block.release", `block/${id}`);
    this.persist();
    return structuredClone(block);
  }

  /* ------------------------------------------------------------- despliegues */

  rollouts(): Rollout[] {
    return [...this.state.rollouts]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .map(publicRollout);
  }

  private findRollout(id: string): RolloutRecord {
    const rollout = this.state.rollouts.find((r) => r.id === id);
    if (!rollout) throw notFound(`El despliegue ${id}`);
    return rollout;
  }

  rollout(id: string): Rollout {
    return publicRollout(this.findRollout(id));
  }

  createRollout(input: Partial<RolloutInput>, actor: Actor): Rollout {
    const api = this.state.apis.find((a) => a.id === input.apiId);
    if (!api) throw badRequest("La API indicada no existe en el catálogo.");
    if (api.state === "RETIRED") throw conflict("No se puede desplegar una API retirada.");
    if (!input.candidateEndpoint || !/^https?:\/\/\S+$/.test(input.candidateEndpoint))
      throw badRequest("El endpoint candidato debe ser una URL.");
    const strategy = input.strategy === "blue_green" ? "blue_green" : "canary";
    const steps = strategy === "blue_green" ? [100] : (input.steps ?? [5, 25, 50, 100]);
    if (
      steps.length === 0 ||
      steps.some((s, i) => !Number.isInteger(s) || s < 1 || s > 100 || (i > 0 && s <= steps[i - 1]!)) ||
      steps.at(-1) !== 100
    ) {
      throw badRequest("Los pasos deben ser enteros crecientes entre 1 y 100, terminando en 100.");
    }
    const environment = input.environment ?? "prod";
    const slug = api.id.replace(/^api-/, "");
    const rollout: RolloutRecord = {
      id: this.nextId("rol", "rollout"),
      apiId: api.id,
      apiName: `${api.name} ${api.version}`,
      strategy,
      candidateEndpoint: input.candidateEndpoint,
      stableEndpoint: `https://${slug}-estable.interno.subtel.invalid`,
      steps,
      stepDurationSec: input.stepDurationSec ?? 60,
      thresholds: { ...DEFAULT_THRESHOLDS, ...input.thresholds },
      environment,
      status: "pendiente_aprobacion",
      currentWeight: 0,
      stepsDone: [],
      createdBy: actor.username,
      createdAt: this.iso(),
      quality: /mala|falla|defect|bad|error/i.test(input.candidateEndpoint) ? "mala" : "buena",
    };
    // En dev y qa no se exige aprobación: el controlador parte de inmediato.
    if (environment !== "prod") this.startRollout(rollout, this.clock());
    this.state.rollouts.push(rollout);
    this.audit(actor, "rollout.create", `rollout/${rollout.id}`);
    this.persist();
    return publicRollout(rollout);
  }

  approveRollout(id: string, actor: Actor): Rollout {
    const rollout = this.findRollout(id);
    if (rollout.status !== "pendiente_aprobacion")
      throw conflict("El despliegue no está pendiente de aprobación.");
    if (isSameActor(actor, rollout.createdBy)) {
      throw new HttpError(
        403,
        "Regla de cuatro ojos: quien aprueba debe ser una persona distinta de quien creó el despliegue.",
      );
    }
    rollout.approvedBy = actor.username;
    this.startRollout(rollout, this.clock());
    this.audit(actor, "rollout.approve", `rollout/${id}`);
    this.persist();
    return publicRollout(rollout);
  }

  abortRollout(id: string, reason: string | undefined, actor: Actor): Rollout {
    const rollout = this.findRollout(id);
    const why = reason?.trim() || "sin motivo informado";
    if (rollout.status === "en_curso") {
      const current = rollout.stepsDone?.at(-1);
      if (current) {
        current.decision = "revertir";
        current.endedAt = this.iso();
      }
      rollout.status = "revertido";
      rollout.currentWeight = 0;
      rollout.rollbackReason = `Detenido manualmente por ${actor.username}: ${why}. El tráfico volvió al backend estable.`;
    } else if (rollout.status === "pendiente_aprobacion") {
      rollout.status = "abortado";
      rollout.rollbackReason = `Cancelado por ${actor.username} antes de iniciar: ${why}.`;
    } else {
      throw conflict("Solo se puede detener un despliegue en curso o pendiente de aprobación.");
    }
    this.audit(actor, "rollout.abort", `rollout/${id}`);
    this.persist();
    return publicRollout(rollout);
  }

  /* ------------------------------------------------------------- continuidad */

  continuity(): ContinuityState {
    return structuredClone(this.state.continuity);
  }

  setMode(mode: string | undefined, actor: Actor): ContinuityState {
    if (mode !== "manual" && mode !== "automatico") throw badRequest("El modo debe ser manual o automatico.");
    this.state.continuity.mode = mode satisfies ContinuityMode;
    this.audit(actor, "continuity.mode.update", `continuity/modo/${mode}`);
    this.persist();
    return this.continuity();
  }

  private startFailover(
    kind: "simulacro" | "retorno",
    to: string,
    plan: PlannedStep[],
    rtoAt: number,
    actor: Actor,
    approvedBy?: string,
  ): FailoverRecord {
    const event: FailoverRecord = {
      id: this.nextId("fo", "failover"),
      kind,
      trigger: kind === "simulacro" ? "simulacro" : "manual",
      from: this.state.continuity.activeSite,
      to,
      startedAt: this.iso(),
      steps: [],
      status: "en_curso",
      approvedBy,
      initiatedBy: actor.username,
      plannedSteps: plan,
      rtoAtOffsetMs: rtoAt,
    };
    this.state.failovers.push(event);
    this.tickFailovers(this.clock());
    return event;
  }

  startDrill(actor: Actor): FailoverEvent {
    if (this.state.failovers.some((f) => f.status === "en_curso"))
      throw conflict("Ya hay una conmutación o un simulacro en curso.");
    if (this.state.continuity.activeSite !== this.primarySite())
      throw conflict("El sitio principal no está activo. Apruebe primero el retorno.");
    const target = this.state.continuity.sites.find((s) => s.role === "respaldo")?.id ?? "gcp";
    const event = this.startFailover("simulacro", target, DRILL_STEPS, 11_500, actor);
    this.audit(actor, "continuity.drill", `continuity/${event.id}`);
    this.persist();
    return publicFailover(event);
  }

  approveFailback(reason: string | undefined, actor: Actor): FailoverEvent {
    const primary = this.primarySite();
    if (this.state.continuity.activeSite === primary)
      throw conflict("El sitio principal ya está activo: no hay retorno pendiente.");
    if (this.state.failovers.some((f) => f.status === "en_curso"))
      throw conflict("Espere a que termine la operación en curso.");
    const last = [...this.state.failovers]
      .filter((f) => f.kind !== "retorno")
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
    if (last && isSameActor(actor, last.initiatedBy)) throw new HttpError(403, FOUR_EYES_MESSAGE);
    const event = this.startFailover("retorno", primary, FAILBACK_STEPS, 8_500, actor, actor.username);
    this.audit(
      actor,
      "continuity.failback.approve",
      `continuity/${event.id}${reason ? ` (${reason.slice(0, 80)})` : ""}`,
    );
    this.persist();
    return publicFailover(event);
  }

  failoverEvents(): FailoverEvent[] {
    return [...this.state.failovers]
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
      .map(publicFailover);
  }

  /* ----------------------------------------------------------------- consumo */

  private consumerScope(actor: Actor): string | undefined | null {
    if (actor.permissions.has("usage:read:all")) return undefined;
    const own = this.state.consumers.find((c) => c.organization === actor.organization);
    return own ? own.id : null;
  }

  usageRows(
    query: { from?: string | null; to?: string | null; groupBy?: string | null },
    actor: Actor,
  ): UsageRow[] {
    const scope = this.consumerScope(actor);
    if (scope === null) return [];
    const groupBy = (
      ["consumer", "api", "endpoint", "day"].includes(query.groupBy ?? "") ? query.groupBy : "consumer"
    ) as UsageGroupBy;
    const rows = scaledRows(this.usage, this.clock(), {
      from: query.from ?? undefined,
      to: query.to ?? undefined,
      consumerId: scope,
    });
    return aggregateUsage(rows, groupBy, {
      consumer: (id) => {
        const c = this.state.consumers.find((x) => x.id === id);
        return { label: c?.organization ?? id, plan: c?.plan };
      },
      api: (id) => {
        const a = this.state.apis.find((x) => x.id === id);
        return a ? `${a.name} ${a.version}` : id;
      },
    });
  }

  usageCsv(query: { from?: string | null; to?: string | null }, actor: Actor): string {
    const scope = this.consumerScope(actor);
    const rows =
      scope === null
        ? []
        : scaledRows(this.usage, this.clock(), {
            from: query.from ?? undefined,
            to: query.to ?? undefined,
            consumerId: scope,
          });
    const consumer = (id: string) => this.state.consumers.find((c) => c.id === id);
    const api = (id: string) => this.state.apis.find((a) => a.id === id);
    return toCsv(
      [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.consumerId.localeCompare(b.consumerId)),
      [
        { header: "dia", value: (r) => r.day },
        { header: "consumidor", value: (r) => consumer(r.consumerId)?.organization ?? r.consumerId },
        { header: "plan", value: (r) => consumer(r.consumerId)?.plan },
        {
          header: "api",
          value: (r) => (api(r.apiId) ? `${api(r.apiId)?.name} ${api(r.apiId)?.version}` : r.apiId),
        },
        { header: "endpoint", value: (r) => r.endpoint },
        { header: "llamadas", value: (r) => r.llamadas },
        { header: "errores", value: (r) => r.errores },
        { header: "bytes", value: (r) => r.bytes },
        { header: "latencia_p95_ms", value: (r) => r.p95 },
        { header: "cobro", value: () => "desactivado" },
      ],
    );
  }

  /* ------------------------------------------------------- mensajes fallidos */

  deadLetters() {
    return [...this.state.deadLetters]
      .sort((a, b) => (b.firstFailedAt ?? "").localeCompare(a.firstFailedAt ?? ""))
      .map((d) => structuredClone(d));
  }

  reprocess(id: string, reason: string | undefined, actor: Actor) {
    const letter = this.state.deadLetters.find((d) => d.id === id);
    if (!letter) throw notFound(`El mensaje ${id}`);
    if (letter.status !== "pendiente") throw conflict("El mensaje ya no está pendiente.");
    if (!reason || reason.trim().length < 5) throw badRequest("Indique el motivo del reproceso.");
    letter.status = "reprocesado";
    letter.reprocessedBy = actor.username;
    this.audit(actor, "dlq.reprocess", `dead-letter/${id}`);
    this.persist();
    return structuredClone(letter);
  }

  /* --------------------------------------------------------------- auditoría */

  auditEvents(filters: {
    from?: string | null;
    to?: string | null;
    actor?: string | null;
    action?: string | null;
    limit?: string | null;
  }): AuditEvent[] {
    const actor = filters.actor?.toLowerCase();
    const action = filters.action?.toLowerCase();
    const limit = Math.min(1000, Math.max(1, Number(filters.limit) || 200));
    return this.state.audit
      .filter((e) => !filters.from || (e.ts ?? "") >= filters.from)
      .filter((e) => !filters.to || (e.ts ?? "") <= filters.to)
      .filter((e) => !actor || e.actor?.toLowerCase().includes(actor))
      .filter((e) => !action || e.action?.toLowerCase().includes(action))
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  verifyAudit(actor: Actor): ChainVerification {
    const result = verifyAudit(this.state.audit);
    this.audit(actor, "audit.verify", result.ok ? "cadena/integra" : `cadena/rota/${result.brokenAt}`);
    this.persist();
    return result;
  }

  /** Solo modo simulado: altera un evento sin recalcular su hash. */
  tamper(): { seq: number; message: string } {
    if (this.state.tamper)
      return {
        seq: this.state.tamper.seq,
        message: `El evento ${this.state.tamper.seq} ya estaba alterado.`,
      };
    const target = this.state.audit[Math.floor(this.state.audit.length / 2)];
    if (!target?.seq) throw conflict("No hay eventos para alterar.");
    this.state.tamper = { seq: target.seq, originalActor: target.actor ?? "" };
    target.actor = "intruso@externo.invalid";
    this.persist();
    return {
      seq: target.seq,
      message: `Se cambió el actor del evento ${target.seq} sin recalcular su hash.`,
    };
  }

  restoreTamper(): { seq: number; message: string } {
    const tamper = this.state.tamper;
    if (!tamper) return { seq: 0, message: "No había eventos alterados." };
    const target = this.state.audit.find((e) => e.seq === tamper.seq);
    if (target) target.actor = tamper.originalActor;
    this.state.tamper = null;
    this.persist();
    return { seq: tamper.seq, message: `Se restauró el evento ${tamper.seq}.` };
  }

  /* ---------------------------------------------------- cumplimiento y salida */

  roleMatrix(): Array<Record<string, unknown>> {
    return permissionMatrix() as unknown as Array<Record<string, unknown>>;
  }

  tls(): TlsChannel[] {
    return structuredClone(this.state.tls);
  }

  createExport(actor: Actor): ExportJob {
    const now = this.clock();
    const job: ExportRecord = {
      id: this.nextId("exp", "export"),
      status: "en_curso",
      createdAt: this.iso(now),
      readyAt: now + 3500,
    };
    this.state.exports.push(job);
    this.audit(actor, "export.create", `export/${job.id}`);
    this.persist();
    return publicExport(job);
  }

  exportJob(id: string): ExportJob {
    const job = this.state.exports.find((j) => j.id === id);
    if (!job) throw notFound(`El paquete ${id}`);
    return publicExport(job);
  }

  private exportFiles(): Array<{ tipo: string; nombre: string; archivo: string; contenido: string }> {
    const files = this.state.apis.map((api) => {
      const ext = api.type === "SOAP" ? "wsdl" : api.type === "GRAPHQL" ? "graphql" : "yaml";
      return {
        tipo: "contrato",
        nombre: `${api.name} ${api.version}`,
        archivo: `contratos/${api.id.replace(/^api-/, "")}-${api.version}.${ext}`,
        contenido: `# ${api.name} ${api.version}\n# contexto: ${api.context}\n# referencia: ${api.contractRef ?? "sin referencia"}\n`,
      };
    });
    files.push(
      {
        tipo: "politica",
        nombre: "Políticas de cuota y throttling",
        archivo: "politicas/throttling.json",
        contenido: JSON.stringify({
          planes: ["Operador Oro", "Operador Plata", "Operador Bronce", "Interno", "Público"],
        }),
      },
      {
        tipo: "flujo",
        nombre: "Flujos de Micro Integrator (CAR)",
        archivo: "flujos/nexo-flujos-1.0.0.car",
        contenido: "flujos: 9",
      },
      {
        tipo: "metadatos",
        nombre: "Catálogo de gobierno",
        archivo: "metadatos/catalogo.json",
        contenido: JSON.stringify(this.state.apis.map(toAsset)),
      },
      {
        tipo: "metadatos",
        nombre: "Grafo de dependencias",
        archivo: "metadatos/dependencias.json",
        contenido: JSON.stringify(this.state.graph),
      },
      {
        tipo: "configuracion",
        nombre: "Configuración de la plataforma (sin secretos)",
        archivo: "configuracion/deployment.toml",
        contenido: '[server]\nhostname = "api.subtel.invalid"\n',
      },
    );
    return files;
  }

  private exportItems(_id: string): NonNullable<NonNullable<ExportJob["manifest"]>["items"]> {
    return this.exportFiles().map((f) => ({
      tipo: f.tipo,
      nombre: f.nombre,
      archivo: f.archivo,
      sha256: sha256Hex(f.contenido),
    }));
  }

  exportBundle(id: string): { body: string; filename: string } {
    const job = this.exportJob(id);
    if (job.status !== "listo") throw conflict("El paquete aún no está listo.");
    const files = this.exportFiles();
    const body = JSON.stringify(
      {
        nota: "Paquete de demostración generado en modo simulado (sin datos reales).",
        generadoEn: job.createdAt,
        manifiesto: job.manifest,
        archivos: Object.fromEntries(files.map((f) => [f.archivo, f.contenido])),
      },
      null,
      2,
    );
    return { body, filename: `nexo-export-${id}.json` };
  }
}
