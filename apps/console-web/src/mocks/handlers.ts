import type { Permission } from "@nexo/shared/browser";
import { delay, http, HttpResponse, type PathParams } from "msw";
import type {
  AnomalyRuleInput,
  ApiAssetPatch,
  DiscoveryScanRequest,
  ImpactRequest,
  RolloutInput,
} from "../api/types";
import { HttpError } from "./errors";
import { resolveActor, type Actor } from "./identity";
import type { MockStore } from "./store";

export interface HandlerOptions {
  /** Igual a `apiBaseUrl` de config.json (relativa, como /api/v1, o absoluta). */
  baseUrl: string;
  /** Latencia simulada en ms (número fijo o rango). 0 en pruebas. */
  latency?: number | readonly [number, number];
  /** Rutas adicionales del claim de roles (por ejemplo la de Keycloak configurada). */
  rolesClaimPaths?: readonly string[];
}

interface Context {
  request: Request;
  params: Record<string, string>;
  actor: Actor;
  search: URLSearchParams;
}

type Resolver = (info: { request: Request; params: PathParams }) => Promise<Response>;

async function readJson<T>(request: Request): Promise<Partial<T>> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}

function flatParams(params: PathParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") out[key] = value[0];
  }
  return out;
}

const json = (body: unknown, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status });

/**
 * Manejadores de MSW para TODAS las rutas de apps/console-api/openapi.yaml, sobre el almacén
 * simulado. Verifican el token, la matriz rol-permiso y la regla de cuatro ojos como la API real,
 * y auditan también las acciones rechazadas.
 */
export function createHandlers(store: MockStore, options: HandlerOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const basePath = (() => {
    try {
      return new URL(base, "http://localhost").pathname.replace(/\/+$/, "");
    } catch {
      return base;
    }
  })();
  const url = (path: string) => `${base}${path}`;

  const wait = async () => {
    const latency = options.latency ?? [120, 320];
    const ms = typeof latency === "number" ? latency : latency[0] + Math.random() * (latency[1] - latency[0]);
    if (ms > 0) await delay(ms);
  };

  const resourceOf = (request: Request) => {
    const path = new URL(request.url).pathname;
    const index = path.indexOf(basePath);
    return index >= 0 ? path.slice(index + basePath.length) : path;
  };

  /** Envuelve un manejador: latencia, token, avance del tiempo, permiso y errores del contrato. */
  const route =
    (
      anyOf: readonly Permission[],
      action: string,
      handler: (ctx: Context) => Response | Promise<Response>,
    ): Resolver =>
    async ({ request, params }) => {
      await wait();
      const actor = resolveActor(request, options.rolesClaimPaths ?? [], store.now());
      if (!actor) return json({ statusCode: 401, message: "Falta un token de acceso válido o expiró." }, 401);
      store.tick();
      try {
        if (anyOf.length > 0 && !anyOf.some((p) => actor.permissions.has(p))) {
          throw new HttpError(403, "Su rol no tiene permiso para realizar esta acción.", anyOf[0]);
        }
        return await handler({
          request,
          params: flatParams(params),
          actor,
          search: new URL(request.url).searchParams,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.status === 403) {
            store.audit(actor, action, resourceOf(request), "rechazado");
            store.persist();
          }
          return json(error.toBody(), error.status);
        }
        console.error("Error en el simulador de la API", error);
        return json({ statusCode: 500, message: "Error interno del simulador." }, 500);
      }
    };

  return [
    /* Sesión e inicio */
    http.get(
      url("/me"),
      route([], "me.read", ({ actor }) => json(store.me(actor))),
    ),
    http.get(
      url("/overview"),
      route([], "overview.read", () => json(store.overview())),
    ),

    /* Catálogo */
    http.get(
      url("/apis"),
      route(["catalog:read"], "catalog.read", ({ search }) =>
        json(
          store.listApis({
            q: search.get("q"),
            audience: search.get("audience"),
            state: search.get("state"),
          }),
        ),
      ),
    ),
    http.get(
      url("/apis/:id"),
      route(["catalog:read"], "catalog.read", ({ params }) => json(store.apiDetail(params.id ?? ""))),
    ),
    http.patch(
      url("/apis/:id"),
      route(["catalog:write"], "catalog.update", async ({ request, params, actor }) =>
        json(store.patchApi(params.id ?? "", await readJson<ApiAssetPatch>(request), actor)),
      ),
    ),
    http.post(
      url("/catalog/sync"),
      route(["catalog:write"], "catalog.sync", ({ actor }) => json(store.syncCatalog(actor))),
    ),

    /* Impacto */
    http.get(
      url("/graph"),
      route(["catalog:read"], "graph.read", () => json(store.graph())),
    ),
    http.post(
      url("/impact/simulate"),
      route(["impact:simulate"], "impact.simulate", async ({ request }) =>
        json(store.simulate((await readJson<ImpactRequest>(request)) as ImpactRequest)),
      ),
    ),

    /* Descubrimiento (D-01) */
    http.get(
      url("/discovery/scans"),
      route(["discovery:read"], "discovery.read", () => json(store.scans())),
    ),
    http.post(
      url("/discovery/scans"),
      route(["discovery:scan"], "discovery.scan", async ({ request, actor }) =>
        json(store.createScan(await readJson<DiscoveryScanRequest>(request), actor), 202),
      ),
    ),
    http.get(
      url("/discovery/findings"),
      route(["discovery:read"], "discovery.read", ({ search }) => json(store.findings(search.get("status")))),
    ),
    http.patch(
      url("/discovery/findings/:id"),
      route(["discovery:triage"], "discovery.triage", async ({ request, params, actor }) =>
        json(store.triage(params.id ?? "", await readJson<{ status: string; note: string }>(request), actor)),
      ),
    ),
    http.get(
      url("/discovery/report"),
      route(["discovery:read"], "discovery.report", ({ search }) => {
        const report = store.discoveryReport(search.get("format"));
        return new HttpResponse(report.body, {
          headers: {
            "Content-Type": report.type,
            "Content-Disposition": `attachment; filename="${report.filename}"`,
          },
        });
      }),
    ),

    /* Anomalías (D-02) */
    http.get(
      url("/anomaly-rules"),
      route(["anomaly:read"], "anomaly.read", () => json(store.rules())),
    ),
    http.post(
      url("/anomaly-rules"),
      route(["anomaly:rules:write"], "anomaly.rule.create", async ({ request, actor }) =>
        json(store.createRule(await readJson<AnomalyRuleInput>(request), actor), 201),
      ),
    ),
    http.patch(
      url("/anomaly-rules/:id"),
      route(["anomaly:rules:write"], "anomaly.rule.update", async ({ request, params, actor }) =>
        json(store.updateRule(params.id ?? "", await readJson<AnomalyRuleInput>(request), actor)),
      ),
    ),
    http.get(
      url("/anomalies"),
      route(["anomaly:read"], "anomaly.read", ({ search }) => json(store.anomalies(search.get("status")))),
    ),
    http.post(
      url("/anomalies/:id/approve-block"),
      route(["anomaly:block:approve"], "anomaly.block.approve", ({ params, actor }) =>
        json(store.approveBlock(params.id ?? "", actor)),
      ),
    ),
    http.post(
      url("/anomalies/:id/dismiss"),
      route(["anomaly:block:approve"], "anomaly.dismiss", async ({ request, params, actor }) =>
        json(
          store.dismissAnomaly(params.id ?? "", (await readJson<{ reason: string }>(request)).reason, actor),
        ),
      ),
    ),
    http.get(
      url("/blocks"),
      route(["anomaly:read"], "anomaly.read", () => json(store.blocks())),
    ),
    http.post(
      url("/blocks/:id/release"),
      route(["anomaly:block:release"], "block.release", async ({ request, params, actor }) =>
        json(
          store.releaseBlock(params.id ?? "", (await readJson<{ reason: string }>(request)).reason, actor),
        ),
      ),
    ),

    /* Despliegues (D-04) */
    http.get(
      url("/rollouts"),
      route(["rollout:read"], "rollout.read", () => json(store.rollouts())),
    ),
    http.post(
      url("/rollouts"),
      route(["rollout:create"], "rollout.create", async ({ request, actor }) =>
        json(store.createRollout(await readJson<RolloutInput>(request), actor), 201),
      ),
    ),
    http.get(
      url("/rollouts/:id"),
      route(["rollout:read"], "rollout.read", ({ params }) => json(store.rollout(params.id ?? ""))),
    ),
    http.post(
      url("/rollouts/:id/approve"),
      route(["rollout:approve"], "rollout.approve", ({ params, actor }) =>
        json(store.approveRollout(params.id ?? "", actor)),
      ),
    ),
    http.post(
      url("/rollouts/:id/abort"),
      route(["rollout:abort"], "rollout.abort", async ({ request, params, actor }) =>
        json(
          store.abortRollout(params.id ?? "", (await readJson<{ reason: string }>(request)).reason, actor),
        ),
      ),
    ),

    /* Continuidad (D-05) */
    http.get(
      url("/continuity"),
      route(["continuity:read"], "continuity.read", () => json(store.continuity())),
    ),
    http.put(
      url("/continuity/mode"),
      route(["admin:settings:write"], "continuity.mode.update", async ({ request, actor }) =>
        json(store.setMode((await readJson<{ mode: string }>(request)).mode, actor)),
      ),
    ),
    http.post(
      url("/continuity/drill"),
      route(["continuity:drill"], "continuity.drill", ({ actor }) => json(store.startDrill(actor), 202)),
    ),
    http.post(
      url("/continuity/failback"),
      route(["continuity:failback:approve"], "continuity.failback.approve", async ({ request, actor }) =>
        json(store.approveFailback((await readJson<{ reason: string }>(request)).reason, actor), 202),
      ),
    ),
    http.get(
      url("/continuity/events"),
      route(["continuity:read"], "continuity.read", () => json(store.failoverEvents())),
    ),

    /* Consumo (BT-021) */
    http.get(
      url("/usage"),
      route(["usage:read:all", "usage:read:own"], "usage.read", ({ search, actor }) =>
        json(
          store.usageRows(
            { from: search.get("from"), to: search.get("to"), groupBy: search.get("groupBy") },
            actor,
          ),
        ),
      ),
    ),
    http.get(
      url("/usage/export"),
      route(["usage:read:all", "usage:read:own"], "usage.export", ({ search, actor }) => {
        const csv = store.usageCsv({ from: search.get("from"), to: search.get("to") }, actor);
        return new HttpResponse(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="consumo.csv"',
          },
        });
      }),
    ),

    /* Mensajes fallidos (BT-051) */
    http.get(
      url("/dead-letters"),
      route(["dlq:read"], "dlq.read", () => json(store.deadLetters())),
    ),
    http.post(
      url("/dead-letters/:id/reprocess"),
      route(["dlq:reprocess:approve"], "dlq.reprocess", async ({ request, params, actor }) =>
        json(store.reprocess(params.id ?? "", (await readJson<{ reason: string }>(request)).reason, actor)),
      ),
    ),

    /* Auditoría (BT-031, BT-032) */
    http.get(
      url("/audit-events"),
      route(["audit:read"], "audit.read", ({ search }) =>
        json(
          store.auditEvents({
            from: search.get("from"),
            to: search.get("to"),
            actor: search.get("actor"),
            action: search.get("action"),
            limit: search.get("limit"),
          }),
        ),
      ),
    ),
    http.get(
      url("/audit-events/verify"),
      route(["audit:verify"], "audit.verify", ({ actor }) => json(store.verifyAudit(actor))),
    ),

    /* Cumplimiento */
    http.get(
      url("/compliance/role-matrix"),
      route(["compliance:read"], "compliance.read", () => json(store.roleMatrix())),
    ),
    http.get(
      url("/compliance/tls-channels"),
      route(["compliance:read"], "compliance.read", () => json(store.tls())),
    ),

    /* Exportación (BT-049, BT-060) */
    http.post(
      url("/exports"),
      route(["export:create"], "export.create", ({ actor }) => json(store.createExport(actor), 202)),
    ),
    http.get(
      url("/exports/:id"),
      route(["export:create"], "export.read", ({ params }) => json(store.exportJob(params.id ?? ""))),
    ),
    // Fuera del contrato: descarga del paquete simulado (la URL la entrega downloadUrl).
    http.get(
      url("/exports/:id/download"),
      route(["export:create"], "export.download", ({ params }) => {
        const bundle = store.exportBundle(params.id ?? "");
        return new HttpResponse(bundle.body, {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${bundle.filename}"`,
          },
        });
      }),
    ),

    /* Herramientas exclusivas del modo simulado (no existen en la API real) */
    http.post(url("/__mock/reset"), async () => {
      store.reset();
      return json({ ok: true });
    }),
    http.post(
      url("/__mock/audit/tamper"),
      route([], "mock.audit.tamper", () => json(store.tamper())),
    ),
    http.post(
      url("/__mock/audit/restore"),
      route([], "mock.audit.restore", () => json(store.restoreTamper())),
    ),
  ];
}
