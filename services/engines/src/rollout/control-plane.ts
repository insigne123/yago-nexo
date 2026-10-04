import { createServer, type Server } from "node:http";
import type { Db } from "@nexo/console-db";
import type { Logger } from "../kit/runtime.js";
import { discoveryResponse, referencedClusters, renderClusters, renderRouteConfig, TYPE_URLS, type ClusterRef, type RouteState, type UpstreamTlsOptions } from "./xds.js";

/** Estado de rutas del ambiente, tal como lo ve Envoy. */
export async function loadRouteStates(db: Db, environment: string): Promise<RouteState[]> {
  const res = await db.query("SELECT * FROM nexo.traffic_route WHERE environment = $1 ORDER BY route_prefix", [environment]);
  return res.rows.map((r) => ({
    apiName: String(r.api_name),
    prefix: String(r.route_prefix),
    stableUrl: String(r.stable_url),
    candidateUrl: r.candidate_url ? String(r.candidate_url) : null,
    weight: Number(r.weight),
    mirrorPercent: Number(r.mirror_percent),
  }));
}

/**
 * Clústeres a entregar: los que usan las rutas ahora más los que dejaron de usarse hace menos de `graceSec`
 * ("crear antes de quitar"). Registrar el uso es de mejor esfuerzo: en una base de solo lectura (sitio de
 * respaldo antes de promover) se entregan igual los clústeres vigentes.
 */
export async function loadClusterRefs(db: Db, environment: string, routes: readonly RouteState[], graceSec: number): Promise<ClusterRef[]> {
  await db
    .query(
      `INSERT INTO nexo.traffic_cluster (api_id, url)
       SELECT api_id, u FROM nexo.traffic_route, LATERAL (VALUES (stable_url), (candidate_url)) v(u)
       WHERE environment = $1 AND u IS NOT NULL
       ON CONFLICT (api_id, url) DO UPDATE SET last_referenced = now()
       WHERE nexo.traffic_cluster.last_referenced < now() - interval '10 seconds'`,
      [environment],
    )
    .catch(() => undefined);
  const recent = await db
    .query(
      `SELECT r.route_prefix, c.url FROM nexo.traffic_cluster c JOIN nexo.traffic_route r USING (api_id)
       WHERE r.environment = $1 AND c.last_referenced > now() - make_interval(secs => $2)`,
      [environment, graceSec],
    )
    .then((res) => res.rows.map((x) => ({ prefix: String(x.route_prefix), url: String(x.url) })))
    .catch(() => [] as ClusterRef[]);
  return [...referencedClusters(routes), ...recent];
}

/**
 * Servidor xDS REST (v3) para nexo-division. Cualquier réplica de los motores puede atenderlo: lee el estado
 * desde PostgreSQL. Si la base no responde, devuelve 503 y Envoy conserva la última configuración válida.
 */
export function startControlPlane(opts: { db: Db; environment: string; port: number; tls: UpstreamTlsOptions; log: Logger; graceSec?: number }): Server {
  const server = createServer((req, res) => {
    const kind = req.url?.startsWith("/v3/discovery:clusters") ? "clusters" : req.url?.startsWith("/v3/discovery:routes") ? "routes" : undefined;
    if (req.method !== "POST" || !kind) {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume();
    req.on("end", () => {
      loadRouteStates(opts.db, opts.environment)
        .then(async (routes) => {
          const body =
            kind === "clusters"
              ? discoveryResponse(TYPE_URLS.clusters, renderClusters(await loadClusterRefs(opts.db, opts.environment, routes, opts.graceSec ?? 120), opts.tls))
              : discoveryResponse(TYPE_URLS.routes, [renderRouteConfig(routes)]);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        })
        .catch((e: unknown) => {
          opts.log("warn", "xDS sin estado de rutas (Envoy conserva la última configuración)", { error: e instanceof Error ? e.message : String(e) });
          res.writeHead(503);
          res.end();
        });
    });
  });
  server.listen(opts.port, "0.0.0.0");
  opts.log("info", `plano de control de nexo-division escuchando en :${opts.port} (ambiente ${opts.environment})`);
  return server;
}
