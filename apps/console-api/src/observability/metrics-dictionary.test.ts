import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDictionary,
  metricsInExpr,
  OUTPUT_JSON,
  OUTPUT_MD,
  renderJson,
  renderMarkdown,
  repoRoot,
  ruleWarnings,
} from "./metrics-dictionary.js";

const REGENERAR = "pnpm --filter @nexo/console-api metricas:diccionario";

describe("métricas de una expresión PromQL", () => {
  it("separa métricas de funciones, etiquetas, rangos y palabras clave", () => {
    expect(
      metricsInExpr(
        '100 * sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total{proxyResponseCode=~"5.."}[5m])) / clamp_min(sum by (apiName) (rate(nexo_gateway_counter_solicitudes_total[5m])), 1e-9) > 5',
      ),
    ).toEqual(["nexo_gateway_counter_solicitudes_total"]);
    expect(
      metricsInExpr(
        "histogram_quantile(0.99, sum by (le, apiName) (rate(nexo_gateway_histogram_latencia_ms_bucket[5m]))) > 2000",
      ),
    ).toEqual(["nexo_gateway_histogram_latencia_ms_bucket"]);
    expect(metricsInExpr("up == 0")).toEqual(["up"]);
    expect(metricsInExpr("a_total / on (job) group_left b_info offset 5m")).toEqual(["a_total", "b_info"]);
  });
});

describe("reglas con errores conocidos", () => {
  it("detecta el filtro por cola en la métrica agregada de RabbitMQ (la expresión anterior de ColaConMensajesFallidos)", () => {
    expect(
      ruleWarnings(
        "ColaConMensajesFallidos",
        'sum by (queue) (rabbitmq_queue_messages_ready{queue=~".*\\\\.dlq"}) > 0',
      ),
    ).toHaveLength(1);
    expect(
      ruleWarnings(
        "ColaConMensajesFallidos",
        'sum by (vhost, queue) (rabbitmq_detailed_queue_messages_ready{queue=~".+[.]dlq"}) > 0',
      ),
    ).toEqual([]);
    expect(ruleWarnings("Otra", "sum(rabbitmq_queue_messages_ready) > 1000")).toEqual([]);
  });
});

describe("diccionario de métricas y alertas", () => {
  const root = repoRoot();
  const d = buildDictionary(root);

  it("está al día con la configuración y el código", () => {
    const md = readFileSync(join(root, OUTPUT_MD), "utf8");
    const json = readFileSync(join(root, OUTPUT_JSON), "utf8");
    expect(md, `${OUTPUT_MD} desactualizado: ejecute ${REGENERAR}`).toBe(renderMarkdown(d));
    expect(json, `${OUTPUT_JSON} desactualizado: ejecute ${REGENERAR}`).toBe(renderJson(d));
  });

  it("toda métrica de las reglas y del tablero tiene una fuente, y Alertmanager envía el token desde un archivo", () => {
    expect(d.warnings).toEqual([]);
    expect(d.routing.tokenFile).toBeTruthy();
    expect(d.routing.webhookUrl).toMatch(/\/api\/v1\/alerts\/alertmanager$/);
  });

  it("la alerta de la cola de fallidos usa la métrica por cola que publica el trabajo rabbitmq-colas", () => {
    const rule = d.rules.find((r) => r.alert === "ColaConMensajesFallidos");
    expect(rule?.metrics).toEqual(["rabbitmq_detailed_queue_messages_ready"]);
    expect(d.thirdParty.find((t) => t.name === "rabbitmq_detailed_queue_messages_ready")?.job).toMatch(
      /^rabbitmq-colas \(\/metrics\/detailed, familia queue_coarse_metrics\)$/,
    );
  });

  it("incluye las métricas del gateway que usan las reglas, con sus etiquetas", () => {
    expect(d.metrics.find((m) => m.name === "nexo_gateway_counter_solicitudes_total")).toMatchObject({
      type: "counter",
      job: "gateway",
      labels: ["apiName", "applicationName", "proxyResponseCode", "keyType"],
    });
    expect(d.metrics.find((m) => m.name === "nexo_gateway_histogram_latencia_ms")).toMatchObject({
      type: "histogram",
      labels: ["apiName"],
    });
    expect(d.metrics.find((m) => m.name === "nexo_siem_rezago_eventos")).toMatchObject({
      job: "nexo-motores",
    });
  });

  it("lista las alertas que emiten los motores", () => {
    expect(d.engineAlerts.map((a) => a.alert)).toEqual(
      expect.arrayContaining([
        "SiemSinEntrega",
        "ConmutacionEjecutada",
        "BloqueoPorAprobar",
        "AnomaliaDetectada",
      ]),
    );
    expect(d.engineAlerts.every((a) => /^S[1-4]( o S[1-4])*$/.test(a.severidad))).toBe(true);
  });
});
