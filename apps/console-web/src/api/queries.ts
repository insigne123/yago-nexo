import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "../components/ui/toast-store";
import { formatNumber, formatMs } from "../lib/format";
import { api } from "./client";
import { unwrap } from "./errors";
import type {
  AnomalyRuleInput,
  AnomalyStatus,
  ApiAssetPatch,
  Audience,
  ContinuityMode,
  DiscoveryScanRequest,
  FindingStatus,
  ImpactRequest,
  RolloutInput,
  UsageGroupBy,
} from "./types";

/** Claves de caché de TanStack Query, una por recurso del contrato. */
export const keys = {
  me: (userId: string) => ["me", userId] as const,
  overview: ["overview"] as const,
  apis: (filters: ApiFilters) => ["apis", "list", filters] as const,
  apisAll: ["apis"] as const,
  api: (id: string) => ["apis", "detail", id] as const,
  graph: ["graph"] as const,
  discovery: ["discovery"] as const,
  scans: ["discovery", "scans"] as const,
  findings: (status?: FindingStatus) => ["discovery", "findings", status ?? "todos"] as const,
  rules: ["anomaly-rules"] as const,
  anomaliesAll: ["anomalies"] as const,
  anomalies: (status?: AnomalyStatus) => ["anomalies", status ?? "todas"] as const,
  blocks: ["blocks"] as const,
  rolloutsAll: ["rollouts"] as const,
  rollouts: ["rollouts", "list"] as const,
  rollout: (id: string) => ["rollouts", "detail", id] as const,
  continuityAll: ["continuity"] as const,
  continuity: ["continuity", "state"] as const,
  failovers: ["continuity", "events"] as const,
  usage: (params: UsageParams) => ["usage", params] as const,
  deadLetters: ["dead-letters"] as const,
  audit: (filters: AuditFilters) => ["audit", filters] as const,
  roleMatrix: ["compliance", "role-matrix"] as const,
  tls: ["compliance", "tls"] as const,
  exportJob: (id: string) => ["exports", id] as const,
};

export interface ApiFilters {
  q?: string;
  audience?: Audience;
  state?: string;
}

export interface UsageParams {
  from?: string;
  to?: string;
  groupBy: UsageGroupBy;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  limit?: number;
}

const clean = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;

/* ------------------------------------------------------------------ Consultas */

export function useMe(userId: string) {
  return useQuery({
    queryKey: keys.me(userId),
    queryFn: ({ signal }) => unwrap(api().GET("/me", { signal })),
    staleTime: 5 * 60_000,
    retry: 1,
    meta: { silent: true },
  });
}

export function useOverview() {
  return useQuery({
    queryKey: keys.overview,
    queryFn: ({ signal }) => unwrap(api().GET("/overview", { signal })),
    refetchInterval: 15_000,
  });
}

export function useApis(filters: ApiFilters = {}, enabled = true) {
  return useQuery({
    queryKey: keys.apis(filters),
    queryFn: ({ signal }) => unwrap(api().GET("/apis", { params: { query: clean(filters) }, signal })),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useApiDetail(id: string) {
  return useQuery({
    queryKey: keys.api(id),
    queryFn: ({ signal }) => unwrap(api().GET("/apis/{id}", { params: { path: { id } }, signal })),
  });
}

export function useGraph(enabled = true) {
  return useQuery({
    queryKey: keys.graph,
    queryFn: ({ signal }) => unwrap(api().GET("/graph", { signal })),
    staleTime: 60_000,
    enabled,
  });
}

export function useScans(enabled = true) {
  return useQuery({
    queryKey: keys.scans,
    queryFn: ({ signal }) => unwrap(api().GET("/discovery/scans", { signal })),
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "en_curso") ? 2000 : false),
    enabled,
  });
}

export function useFindings(status?: FindingStatus, enabled = true) {
  return useQuery({
    queryKey: keys.findings(status),
    queryFn: ({ signal }) =>
      unwrap(api().GET("/discovery/findings", { params: { query: status ? { status } : {} }, signal })),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useAnomalyRules(enabled = true) {
  return useQuery({
    queryKey: keys.rules,
    queryFn: ({ signal }) => unwrap(api().GET("/anomaly-rules", { signal })),
    enabled,
  });
}

export function useAnomalies(status?: AnomalyStatus, enabled = true) {
  return useQuery({
    queryKey: keys.anomalies(status),
    queryFn: ({ signal }) =>
      unwrap(api().GET("/anomalies", { params: { query: status ? { status } : {} }, signal })),
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
    enabled,
  });
}

export function useBlocks(enabled = true) {
  return useQuery({
    queryKey: keys.blocks,
    queryFn: ({ signal }) => unwrap(api().GET("/blocks", { signal })),
    refetchInterval: 10_000,
    enabled,
  });
}

export function useRollouts(enabled = true) {
  return useQuery({
    queryKey: keys.rollouts,
    queryFn: ({ signal }) => unwrap(api().GET("/rollouts", { signal })),
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === "en_curso") ? 4000 : false),
    enabled,
  });
}

/** Detalle con sondeo cada 2 s mientras el despliegue está en curso. */
export function useRollout(id: string) {
  return useQuery({
    queryKey: keys.rollout(id),
    queryFn: ({ signal }) => unwrap(api().GET("/rollouts/{id}", { params: { path: { id } }, signal })),
    refetchInterval: (query) => (query.state.data?.status === "en_curso" ? 2000 : false),
  });
}

export function useContinuity(fast = false, enabled = true) {
  return useQuery({
    queryKey: keys.continuity,
    queryFn: ({ signal }) => unwrap(api().GET("/continuity", { signal })),
    refetchInterval: fast ? 2000 : 10_000,
    enabled,
  });
}

export function useFailoverEvents(enabled = true) {
  return useQuery({
    queryKey: keys.failovers,
    queryFn: ({ signal }) => unwrap(api().GET("/continuity/events", { signal })),
    refetchInterval: (query) => (query.state.data?.some((e) => e.status === "en_curso") ? 2000 : 15_000),
    enabled,
  });
}

export function useUsage(params: UsageParams, enabled = true) {
  return useQuery({
    queryKey: keys.usage(params),
    queryFn: ({ signal }) => unwrap(api().GET("/usage", { params: { query: clean(params) }, signal })),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useDeadLetters(enabled = true) {
  return useQuery({
    queryKey: keys.deadLetters,
    queryFn: ({ signal }) => unwrap(api().GET("/dead-letters", { signal })),
    enabled,
  });
}

export function useAuditEvents(filters: AuditFilters, enabled = true) {
  return useQuery({
    queryKey: keys.audit(filters),
    queryFn: ({ signal }) =>
      unwrap(api().GET("/audit-events", { params: { query: clean(filters) }, signal })),
    placeholderData: (previous) => previous,
    enabled,
  });
}

export function useRoleMatrix(enabled = true) {
  return useQuery({
    queryKey: keys.roleMatrix,
    queryFn: ({ signal }) => unwrap(api().GET("/compliance/role-matrix", { signal })),
    retry: false,
    meta: { silent: true },
    enabled,
  });
}

export function useTlsChannels(enabled = true) {
  return useQuery({
    queryKey: keys.tls,
    queryFn: ({ signal }) => unwrap(api().GET("/compliance/tls-channels", { signal })),
    enabled,
  });
}

export function useExportJob(id: string | null) {
  return useQuery({
    queryKey: keys.exportJob(id ?? "ninguno"),
    queryFn: ({ signal }) =>
      unwrap(api().GET("/exports/{id}", { params: { path: { id: id ?? "" } }, signal })),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === "en_curso" ? 2000 : false),
  });
}

/**
 * Cuando un proceso en segundo plano termina (escaneo, simulacro, despliegue), vuelve a consultar
 * los datos que dependen de él: el sondeo se detiene justo al terminar y podría quedar atrasado.
 */
export function useRefreshWhenFinished(active: boolean, ...queryKeys: QueryKey[]) {
  const client = useQueryClient();
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) {
      for (const queryKey of queryKeys) void client.invalidateQueries({ queryKey });
    }
    wasActive.current = active;
  });
}

/* ------------------------------------------------------------------ Descargas */

export function fetchDiscoveryReportCsv(): Promise<string> {
  return unwrap(api().GET("/discovery/report", { params: { query: { format: "csv" } }, parseAs: "text" }));
}

export function fetchUsageCsv(from?: string, to?: string): Promise<string> {
  return unwrap(api().GET("/usage/export", { params: { query: clean({ from, to }) }, parseAs: "text" }));
}

/* ------------------------------------------------------------------ Mutaciones */

function useInvalidate() {
  const client = useQueryClient();
  return (...queryKeys: QueryKey[]) =>
    Promise.all(queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function usePatchApi(id: string) {
  const invalidate = useInvalidate();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: ApiAssetPatch) =>
      unwrap(api().PATCH("/apis/{id}", { params: { path: { id } }, body: patch })),
    onSuccess: async (data) => {
      client.setQueryData(keys.api(id), data);
      await invalidate(keys.apisAll, keys.overview);
      toast.success(
        "Cambios guardados",
        `La ficha de ${data.name} quedó con ${formatNumber(data.completeness)} % de completitud.`,
      );
    },
  });
}

export function useCatalogSync() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => unwrap(api().POST("/catalog/sync")),
    onSuccess: async (r) => {
      await invalidate(keys.apisAll, keys.overview, keys.graph);
      toast.success(
        "Catálogo sincronizado con WSO2",
        `${formatNumber(r.apis)} APIs, ${formatNumber(r.consumers)} consumidores y ${formatNumber(r.subscriptions)} suscripciones en ${formatMs(r.durationMs)}.`,
      );
    },
  });
}

export function useImpactSimulation() {
  return useMutation({
    mutationFn: (request: ImpactRequest) => unwrap(api().POST("/impact/simulate", { body: request })),
  });
}

export function useCreateScan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (request: DiscoveryScanRequest) => unwrap(api().POST("/discovery/scans", { body: request })),
    onSuccess: async () => {
      await invalidate(keys.scans);
      toast.info("Escaneo iniciado", "Los hallazgos se actualizan cuando el escaneo termina.");
    },
  });
}

export function usePatchFinding() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; status: FindingStatus; note?: string }) =>
      unwrap(
        api().PATCH("/discovery/findings/{id}", {
          params: { path: { id: vars.id } },
          body: { status: vars.status, note: vars.note },
        }),
      ),
    onSuccess: async () => {
      await invalidate(keys.discovery, keys.overview);
      toast.success("Hallazgo clasificado");
    },
  });
}

export function useSaveRule() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id?: string; input: AnomalyRuleInput }) =>
      vars.id
        ? unwrap(api().PATCH("/anomaly-rules/{id}", { params: { path: { id: vars.id } }, body: vars.input }))
        : unwrap(api().POST("/anomaly-rules", { body: vars.input })),
    onSuccess: async (rule, vars) => {
      await invalidate(keys.rules);
      toast.success(vars.id ? "Regla actualizada" : "Regla creada", rule.name);
    },
  });
}

export function useApproveBlock() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api().POST("/anomalies/{id}/approve-block", { params: { path: { id } } })),
    onSuccess: async () => {
      await invalidate(keys.anomaliesAll, keys.blocks, keys.overview);
      toast.success("Bloqueo aprobado", "La política de denegación quedó activa en el gateway.");
    },
  });
}

export function useDismissAnomaly() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; reason?: string }) =>
      unwrap(
        api().POST("/anomalies/{id}/dismiss", {
          params: { path: { id: vars.id } },
          body: { reason: vars.reason },
        }),
      ),
    onSuccess: async () => {
      await invalidate(keys.anomaliesAll, keys.overview);
      toast.success("Anomalía descartada");
    },
  });
}

export function useReleaseBlock() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; reason?: string }) =>
      unwrap(
        api().POST("/blocks/{id}/release", {
          params: { path: { id: vars.id } },
          body: { reason: vars.reason },
        }),
      ),
    onSuccess: async () => {
      await invalidate(keys.blocks, keys.anomaliesAll, keys.overview);
      toast.success("Bloqueo liberado", "El consumidor puede volver a usar la API.");
    },
  });
}

export function useCreateRollout() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RolloutInput) => unwrap(api().POST("/rollouts", { body: input })),
    onSuccess: async () => {
      await invalidate(keys.rolloutsAll, keys.overview);
      toast.success("Despliegue creado");
    },
  });
}

export function useApproveRollout() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(api().POST("/rollouts/{id}/approve", { params: { path: { id } } })),
    onSuccess: async () => {
      await invalidate(keys.rolloutsAll, keys.overview);
      toast.success("Despliegue aprobado", "El controlador inició el primer paso.");
    },
  });
}

export function useAbortRollout() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; reason?: string }) =>
      unwrap(
        api().POST("/rollouts/{id}/abort", {
          params: { path: { id: vars.id } },
          body: { reason: vars.reason },
        }),
      ),
    onSuccess: async () => {
      await invalidate(keys.rolloutsAll, keys.overview);
      toast.warning("Despliegue detenido", "El tráfico volvió al backend estable.");
    },
  });
}

export function useSetContinuityMode() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (mode: ContinuityMode) => unwrap(api().PUT("/continuity/mode", { body: { mode } })),
    onSuccess: async (state) => {
      await invalidate(keys.continuityAll);
      toast.success(`Modo ${state.mode === "automatico" ? "automático" : "manual"} activado`);
    },
  });
}

export function useStartDrill() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => unwrap(api().POST("/continuity/drill")),
    onSuccess: async () => {
      await invalidate(keys.continuityAll, keys.overview);
      toast.info("Simulacro iniciado", "Los pasos aparecen a medida que se ejecutan.");
    },
  });
}

export function useApproveFailback() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (reason?: string) => unwrap(api().POST("/continuity/failback", { body: { reason } })),
    onSuccess: async () => {
      await invalidate(keys.continuityAll, keys.overview);
      toast.info("Retorno aprobado", "Se inició el retorno guiado al sitio principal.");
    },
  });
}

export function useReprocessDeadLetter() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      unwrap(
        api().POST("/dead-letters/{id}/reprocess", {
          params: { path: { id: vars.id } },
          body: { reason: vars.reason },
        }),
      ),
    onSuccess: async () => {
      await invalidate(keys.deadLetters, keys.overview);
      toast.success("Mensaje reprocesado", "La acción quedó registrada en la auditoría.");
    },
  });
}

export function useVerifyAudit() {
  return useMutation({
    mutationFn: () => unwrap(api().GET("/audit-events/verify")),
  });
}

export function useCreateExport() {
  return useMutation({
    mutationFn: () => unwrap(api().POST("/exports")),
    onSuccess: () => {
      toast.info("Exportación iniciada", "El paquete se arma en segundo plano.");
    },
  });
}
