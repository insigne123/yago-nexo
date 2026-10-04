import type { Wso2Client } from "@nexo/wso2-client";
import type { Db } from "@nexo/console-db";

/**
 * Rutas de nexo-division declaradas por las APIs: una API pasa por la división de tráfico cuando la revisión
 * desplegada en el ambiente tiene como endpoint `<NEXO_DIVISION_URL>/rutas/<nombre>` y la propiedad
 * `division_estable` con el backend estable (la escribe nexo-ctl desde el proyecto versionado).
 */
export interface DeclaredRoute {
  apiId: string;
  apiName: string;
  prefix: string;
  seedUrl: string;
  revisionId: string;
}

type ApiDef = {
  name?: string;
  version?: string;
  endpointConfig?: { production_endpoints?: { url?: string } | Array<{ url?: string }> };
  additionalProperties?: Array<{ name: string; value: string }>;
};

export function declaredRoute(api: ApiDef, divisionUrl: string): { prefix: string; seedUrl: string } | undefined {
  const p = api.endpointConfig?.production_endpoints;
  const url = Array.isArray(p) ? p[0]?.url : p?.url;
  const base = divisionUrl.replace(/\/+$/, "");
  if (!url || !url.startsWith(`${base}/rutas/`)) return undefined;
  const rest = url.slice(base.length).replace(/\/+$/, "");
  const prefix = rest.split("/").slice(0, 3).join("/"); // /rutas/<nombre>
  const seedUrl = api.additionalProperties?.find((x) => x.name === "division_estable")?.value;
  if (!seedUrl || !/^https?:\/\//.test(seedUrl)) return undefined;
  return { prefix, seedUrl };
}

/** Lee las revisiones desplegadas en el primer gateway del ambiente y devuelve las rutas declaradas. */
export async function discoverRoutes(
  wso2: Wso2Client,
  gatewayName: string,
  divisionUrl: string,
  cache: Map<string, { prefix: string; seedUrl: string } | null>,
): Promise<DeclaredRoute[]> {
  const out: DeclaredRoute[] = [];
  for (const a of (await wso2.publisher.listApis(undefined, 500)).list) {
    if ((a.type ?? "HTTP") !== "HTTP") continue;
    const revs = (await wso2.publisher.listRevisions(a.id)).list;
    const deployed = revs.find((r) => (r.deploymentInfo ?? []).some((d) => d.name === gatewayName));
    if (!deployed) continue;
    if (!cache.has(deployed.id)) cache.set(deployed.id, declaredRoute((await wso2.publisher.getApi(deployed.id)) as ApiDef, divisionUrl) ?? null);
    const decl = cache.get(deployed.id);
    if (decl) out.push({ apiId: a.id, apiName: `${a.name} ${a.version}`, prefix: decl.prefix, seedUrl: decl.seedUrl, revisionId: deployed.id });
  }
  return out;
}

/**
 * Registra o actualiza las rutas. Si el proyecto versionado cambió el backend estable (seed distinto) y no hay
 * un despliegue en curso, la ruta adopta el nuevo estable; durante un despliegue no se toca.
 */
export async function upsertRoutes(db: Db, environment: string, routes: readonly DeclaredRoute[]): Promise<number> {
  let changed = 0;
  for (const r of routes) {
    const res = await db.query(
      `INSERT INTO nexo.traffic_route (api_id, api_name, environment, route_prefix, seed_url, stable_url, revision_id)
       VALUES ($1,$2,$3,$4,$5,$5,$6)
       ON CONFLICT (api_id) DO UPDATE SET
         api_name = EXCLUDED.api_name,
         route_prefix = EXCLUDED.route_prefix,
         revision_id = EXCLUDED.revision_id,
         stable_url = CASE WHEN nexo.traffic_route.rollout_id IS NULL AND nexo.traffic_route.seed_url <> EXCLUDED.seed_url
                           THEN EXCLUDED.seed_url ELSE nexo.traffic_route.stable_url END,
         seed_url = CASE WHEN nexo.traffic_route.rollout_id IS NULL THEN EXCLUDED.seed_url ELSE nexo.traffic_route.seed_url END,
         version = nexo.traffic_route.version + 1,
         updated_at = now()
       WHERE nexo.traffic_route.revision_id IS DISTINCT FROM EXCLUDED.revision_id
          OR nexo.traffic_route.route_prefix <> EXCLUDED.route_prefix
          OR (nexo.traffic_route.rollout_id IS NULL AND nexo.traffic_route.seed_url <> EXCLUDED.seed_url)
       RETURNING api_id`,
      [r.apiId, r.apiName, environment, r.prefix, r.seedUrl, r.revisionId],
    );
    changed += res.rowCount ?? 0;
  }
  return changed;
}
