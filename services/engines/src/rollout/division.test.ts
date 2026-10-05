import { describe, expect, it } from "vitest";
import { delta, mergeSnapshots, parseEnvoyStats, quantileMs, toVersionMetrics } from "./envoy-stats.js";
import { declaredRoute } from "./routes.js";
import { clusterName, discoveryResponse, referencedClusters, renderClusters, renderRouteConfig, type RouteState } from "./xds.js";

const base: RouteState = { apiName: "Concesiones 1.0.0", prefix: "/rutas/concesiones", stableUrl: "http://concesiones-v1:7001", weight: 0, mirrorPercent: 0 };
const V1 = clusterName("/rutas/concesiones", "http://concesiones-v1:7001");
const V2 = clusterName("/rutas/concesiones", "http://concesiones-v2:7001");
const clusters = (routes: RouteState[]) => renderClusters(referencedClusters(routes));

describe("configuración xDS de nexo-division", () => {
  it("sin candidato, todo va al estable con el Host del backend", () => {
    const rc = renderRouteConfig([base]);
    const routes = rc.virtual_hosts[0]!.routes;
    expect(routes.map((r) => r.name)).toEqual(["concesiones", "concesiones-raiz"]);
    expect(routes[0]!.route).toMatchObject({ cluster: V1, host_rewrite_literal: "concesiones-v1:7001", prefix_rewrite: "/" });
    expect(clusters([base]).map((c) => c.name)).toEqual([V1]);
  });

  it("en canary reparte por peso entre estable y candidato", () => {
    const rc = renderRouteConfig([{ ...base, candidateUrl: "http://concesiones-v2:7001", weight: 5 }]);
    const wc = (rc.virtual_hosts[0]!.routes[0]!.route as { weighted_clusters: { clusters: Array<{ name: string; weight: number }> } }).weighted_clusters;
    expect(wc.clusters.map((c) => [c.name, c.weight])).toEqual([
      [V1, 95],
      [V2, 5],
    ]);
  });

  it("en sombra copia solo las lecturas al candidato y los consumidores siguen en el estable", () => {
    const rc = renderRouteConfig([{ ...base, candidateUrl: "http://concesiones-v2:7001", mirrorPercent: 100 }]);
    const [lecturas, resto] = rc.virtual_hosts[0]!.routes;
    expect(lecturas!.match).toMatchObject({ headers: [{ name: ":method", string_match: { safe_regex: { regex: "GET|HEAD" } } }] });
    expect(lecturas!.route).toMatchObject({ cluster: V1, request_mirror_policies: [{ cluster: V2 }] });
    expect(resto!.route).not.toHaveProperty("request_mirror_policies");
  });

  it("al 100 % todo va al candidato", () => {
    const rc = renderRouteConfig([{ ...base, candidateUrl: "http://concesiones-v2:7001", weight: 100 }]);
    expect(rc.virtual_hosts[0]!.routes[0]!.route).toMatchObject({ cluster: V2, host_rewrite_literal: "concesiones-v2:7001" });
  });

  it("al promover, el candidato conserva su clúster: la ruta no apunta a un clúster nuevo", () => {
    const at100 = renderRouteConfig([{ ...base, candidateUrl: "http://concesiones-v2:7001", weight: 100 }]).virtual_hosts[0]!.routes[0]!.route;
    const promoted = renderRouteConfig([{ ...base, stableUrl: "http://concesiones-v2:7001" }]).virtual_hosts[0]!.routes[0]!.route;
    expect((at100 as { cluster: string }).cluster).toBe((promoted as { cluster: string }).cluster);
  });

  it("entrega también los clústeres en período de gracia, sin duplicados", () => {
    const refs = [...referencedClusters([base]), { prefix: base.prefix, url: "http://concesiones-v2:7001" }, { prefix: base.prefix, url: "http://concesiones-v1:7001/" }];
    expect(renderClusters(refs).map((c) => c.name).sort()).toEqual([V1, V2].sort());
  });

  it("conserva la ruta base del backend y valida TLS hacia backends HTTPS", () => {
    const r = { ...base, prefix: "/rutas/registro", stableUrl: "https://registro.cliente.invalid/api/v2" };
    expect(renderRouteConfig([r]).virtual_hosts[0]!.routes[0]!.route).toMatchObject({ prefix_rewrite: "/api/v2/" });
    const c = clusters([r])[0] as { transport_socket: { typed_config: { sni: string; common_tls_context: { validation_context: unknown } } } };
    expect(c.transport_socket.typed_config.sni).toBe("registro.cliente.invalid");
    expect(c.transport_socket.typed_config.common_tls_context.validation_context).toBeDefined();
  });

  it("la versión cambia solo si cambia el contenido", () => {
    const a = discoveryResponse("t", clusters([base]));
    expect(discoveryResponse("t", clusters([base])).version_info).toBe(a.version_info);
    expect(discoveryResponse("t", clusters([{ ...base, candidateUrl: "http://x:1" }])).version_info).not.toBe(a.version_info);
  });
});

describe("rutas declaradas por las APIs", () => {
  it("reconoce el endpoint de nexo-division y el backend estable declarado", () => {
    expect(
      declaredRoute(
        { endpointConfig: { production_endpoints: { url: "http://nexo-division:10000/rutas/concesiones" } }, additionalProperties: [{ name: "division_estable", value: "http://concesiones-v1:7001" }] },
        "http://nexo-division:10000",
      ),
    ).toEqual({ prefix: "/rutas/concesiones", seedUrl: "http://concesiones-v1:7001" });
    expect(declaredRoute({ endpointConfig: { production_endpoints: { url: "http://concesiones-v1:7001" } } }, "http://nexo-division:10000")).toBeUndefined();
  });
});

const STATS = `
# TYPE envoy_cluster_upstream_rq_completed counter
envoy_cluster_upstream_rq_completed{envoy_cluster_name="concesiones__candidato"} 40
envoy_cluster_upstream_rq_completed{envoy_cluster_name="concesiones__estable"} 900
envoy_cluster_upstream_rq_completed{envoy_cluster_name="otra__estable"} 7
envoy_cluster_upstream_rq_xx{envoy_response_code_class="5",envoy_cluster_name="concesiones__candidato"} 10
envoy_cluster_upstream_rq_xx{envoy_response_code_class="2",envoy_cluster_name="concesiones__candidato"} 30
envoy_cluster_upstream_cx_connect_fail{envoy_cluster_name="concesiones__candidato"} 2
envoy_cluster_upstream_rq_time_bucket{envoy_cluster_name="concesiones__candidato",le="10"} 20
envoy_cluster_upstream_rq_time_bucket{envoy_cluster_name="concesiones__candidato",le="100"} 38
envoy_cluster_upstream_rq_time_bucket{envoy_cluster_name="concesiones__candidato",le="1000"} 40
envoy_cluster_upstream_rq_time_bucket{envoy_cluster_name="concesiones__candidato",le="+Inf"} 40
`;

describe("métricas por versión desde Envoy", () => {
  const names = ["concesiones__estable", "concesiones__candidato"]; // nombres literales de la muestra de Prometheus

  it("lee completadas, 5xx, fallas de conexión e histograma", () => {
    const s = parseEnvoyStats(STATS, names);
    expect(s.concesiones__candidato).toMatchObject({ completed: 40, errors5xx: 10, connectFail: 2 });
    expect(s.concesiones__estable!.completed).toBe(900);
    expect(Object.keys(s)).toEqual(names);
  });

  it("calcula el p99 interpolando en el histograma", () => {
    expect(quantileMs({ "10": 20, "100": 38, "1000": 40, "+Inf": 40 }, 0.5)).toBe(10);
    const p99 = quantileMs({ "10": 20, "100": 38, "1000": 40, "+Inf": 40 }, 0.99)!;
    expect(p99).toBeGreaterThan(100);
    expect(p99).toBeLessThanOrEqual(1000);
  });

  it("descuenta la línea base del paso y suma réplicas", () => {
    const now = mergeSnapshots([parseEnvoyStats(STATS, names), parseEnvoyStats(STATS, names)]);
    const d = delta(now.concesiones__candidato, parseEnvoyStats(STATS, names).concesiones__candidato);
    expect(toVersionMetrics(d)).toMatchObject({ requests: 42, errors: 12 });
  });

  it("si Envoy se reinició, cuenta desde cero en vez de dar negativos", () => {
    const d = delta({ completed: 5, errors5xx: 1, connectFail: 0, timeouts: 0, buckets: {}, members: 1 }, { completed: 50, errors5xx: 9, connectFail: 0, timeouts: 0, buckets: {}, members: 1 });
    expect(d).toMatchObject({ completed: 5, errors5xx: 1 });
  });

  it("nombra cada clúster por la ruta y el backend", () => {
    expect(V1).toMatch(/^concesiones__[0-9a-f]{10}$/);
    expect(V1).not.toBe(V2);
    expect(clusterName("/rutas/concesiones", "http://concesiones-v1:7001/")).toBe(V1);
  });

  it("considera listo un clúster solo si todas las réplicas lo tienen", async () => {
    const { clusterReady } = await import("./envoy-stats.js");
    const ready = parseEnvoyStats('envoy_cluster_membership_total{envoy_cluster_name="a"} 1', ["a"]);
    const notYet = parseEnvoyStats("", ["a"]);
    expect(clusterReady([ready, ready], "a")).toBe(true);
    expect(clusterReady([ready, notYet], "a")).toBe(false);
  });
});
