import { createHash } from "node:crypto";

/**
 * Plano de control de nexo-division (Envoy) por xDS REST: el motor de despliegues entrega clústeres y rutas
 * calculados desde nexo.traffic_route. Envoy consulta cada segundo y aplica los cambios en caliente, sin
 * cortar conexiones: así un paso de canary, el tráfico sombra o una reversa no redespliegan la API en WSO2.
 */
export interface RouteState {
  apiName: string;
  prefix: string;
  stableUrl: string;
  candidateUrl?: string | null;
  weight: number;
  mirrorPercent: number;
}

const CLUSTER = "type.googleapis.com/envoy.config.cluster.v3.Cluster";
const ROUTE_CONFIG = "type.googleapis.com/envoy.config.route.v3.RouteConfiguration";
export const TYPE_URLS = { clusters: CLUSTER, routes: ROUTE_CONFIG } as const;

export function slugOf(prefix: string): string {
  return prefix.replace(/^\/rutas\//, "").replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/**
 * Un clúster por backend (URL): al promover el candidato, la ruta sigue usando el mismo clúster, sin
 * reemplazarlo. El nombre lleva el prefijo de la ruta y un hash corto de la URL.
 */
export function clusterName(prefix: string, url: string): string {
  return `${slugOf(prefix)}__${createHash("sha256").update(url.replace(/\/+$/, "")).digest("hex").slice(0, 10)}`;
}

export interface ClusterRef {
  prefix: string;
  url: string;
}

function hostPort(u: URL): { host: string; port: number; authority: string } {
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return { host: u.hostname, port, authority: u.port ? `${u.hostname}:${u.port}` : u.hostname };
}

/** Ruta base del backend sin la barra final ("" si es la raíz). */
export function basePath(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "");
}

export interface UpstreamTlsOptions {
  /** Archivo con las CA de confianza para backends HTTPS; sin él se usa el almacén del sistema. */
  caFile?: string;
  /** Solo laboratorio: no verificar el certificado del backend. */
  insecure?: boolean;
}

export function renderCluster(name: string, url: string, tls: UpstreamTlsOptions = {}) {
  const u = new URL(url);
  const { host, port } = hostPort(u);
  return {
    "@type": CLUSTER,
    name,
    type: "STRICT_DNS",
    connect_timeout: "2s",
    dns_lookup_family: "V4_ONLY",
    load_assignment: {
      cluster_name: name,
      endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: host, port_value: port } }, hostname: host } }] }],
    },
    ...(u.protocol === "https:"
      ? {
          transport_socket: {
            name: "envoy.transport_sockets.tls",
            typed_config: {
              "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
              sni: host,
              common_tls_context: {
                tls_params: { tls_minimum_protocol_version: "TLSv1_2" },
                ...(tls.insecure
                  ? {}
                  : {
                      validation_context: {
                        trusted_ca: { filename: tls.caFile ?? "/etc/ssl/certs/ca-certificates.crt" },
                        match_typed_subject_alt_names: [{ san_type: "DNS", matcher: { exact: host } }],
                      },
                    }),
              },
            },
          },
        }
      : {}),
  };
}

/** Clústeres vigentes y en período de gracia (sin duplicados, en orden estable para el hash de versión). */
export function renderClusters(refs: readonly ClusterRef[], tls: UpstreamTlsOptions = {}) {
  const byName = new Map<string, ClusterRef>();
  for (const r of refs) byName.set(clusterName(r.prefix, r.url), r);
  return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, r]) => renderCluster(name, r.url, tls));
}

/** Clústeres que referencia el estado actual de las rutas. */
export function referencedClusters(routes: readonly RouteState[]): ClusterRef[] {
  return routes.flatMap((r) => [{ prefix: r.prefix, url: r.stableUrl }, ...(r.candidateUrl ? [{ prefix: r.prefix, url: r.candidateUrl }] : [])]);
}

/** Acción de ruta para el peso vigente: todo al estable, todo al candidato o un reparto ponderado. */
function routeAction(r: RouteState, withMirror: boolean, rewrite: string) {
  const stable = clusterName(r.prefix, r.stableUrl);
  const candidate = r.candidateUrl ? clusterName(r.prefix, r.candidateUrl) : stable;
  const stableHost = hostPort(new URL(r.stableUrl)).authority;
  const candidateHost = r.candidateUrl ? hostPort(new URL(r.candidateUrl)).authority : undefined;
  const w = r.candidateUrl ? Math.max(0, Math.min(100, Math.round(r.weight))) : 0;
  const target =
    w === 0
      ? { cluster: stable, host_rewrite_literal: stableHost }
      : w === 100
        ? { cluster: candidate, host_rewrite_literal: candidateHost }
        : {
            weighted_clusters: {
              clusters: [
                { name: stable, weight: 100 - w, host_rewrite_literal: stableHost },
                { name: candidate, weight: w, host_rewrite_literal: candidateHost },
              ],
            },
          };
  const mirror =
    withMirror && r.candidateUrl && r.mirrorPercent > 0 && w < 100
      ? {
          request_mirror_policies: [
            {
              cluster: candidate,
              runtime_fraction: { default_value: { numerator: Math.min(100, Math.round(r.mirrorPercent)), denominator: "HUNDRED" } },
              disable_shadow_host_suffix_append: true,
            },
          ],
        }
      : {};
  return { ...target, prefix_rewrite: rewrite, timeout: "30s", ...mirror };
}

export function renderRouteConfig(routes: readonly RouteState[]) {
  // Prefijos más largos primero: Envoy toma la primera ruta que coincide.
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  return {
    "@type": ROUTE_CONFIG,
    name: "nexo",
    virtual_hosts: [
      {
        name: "division",
        domains: ["*"],
        routes: sorted.flatMap((r) => {
          const base = basePath(r.stableUrl);
          const withSlash = `${r.prefix}/`;
          const mirrorOn = !!r.candidateUrl && r.mirrorPercent > 0 && r.weight < 100;
          return [
            // Solo las lecturas se copian al candidato: repetir escrituras tendría efectos en sus datos.
            ...(mirrorOn
              ? [
                  {
                    name: `${slugOf(r.prefix)}-lecturas-sombra`,
                    match: { prefix: withSlash, headers: [{ name: ":method", string_match: { safe_regex: { regex: "GET|HEAD" } } }] },
                    route: routeAction(r, true, `${base}/`),
                  },
                ]
              : []),
            { name: slugOf(r.prefix), match: { prefix: withSlash }, route: routeAction(r, false, `${base}/`) },
            { name: `${slugOf(r.prefix)}-raiz`, match: { path: r.prefix }, route: routeAction(r, mirrorOn, base || "/") },
          ];
        }),
      },
    ],
  };
}

/** DiscoveryResponse de xDS; la versión es el hash del contenido, así Envoy solo aplica cambios reales. */
export function discoveryResponse(typeUrl: string, resources: unknown[]) {
  const version = createHash("sha256").update(JSON.stringify(resources)).digest("hex").slice(0, 16);
  return { version_info: version, type_url: typeUrl, resources };
}
