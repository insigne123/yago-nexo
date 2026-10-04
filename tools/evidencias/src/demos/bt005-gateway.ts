/**
 * Publicar, proteger y enrutar una API a través del gateway. Se toma la API de tarifas que el descubrimiento
 * encontró expuesta en el NGINX heredado y se la gobierna: proyecto versionado (contrato + políticas), el
 * pipeline (nexo-ctl) la valida, la versiona, la despliega en el gateway y la publica; luego se comprueba que
 * el gateway la protege (OAuth con Keycloak, suscripción, límite del plan) y la enruta al sistema de destino.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, fetch } from "undici";
import type { Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { credencialesDe, gateway, tokenAplicacion, wso2 } from "../lib/lab.js";
import { nexoCtl } from "./comun.js";

const NOMBRE = "TarifasLegado";
const URL = "https://apim:8243/tarifas/1.0.0/tarifas";

const API_YAML = `# Proyecto de API versionado en Git: contrato + políticas. Lo despliega el pipeline (nexo-ctl).
name: ${NOMBRE}
version: 1.0.0
context: /tarifas
description: Tarifas vigentes de los planes de servicio, antes expuestas sin gobierno en el NGINX heredado.
type: HTTP
contract: openapi.yaml
owner:
  business: División de Tarifas (sintético)
  businessEmail: tarifas@ejemplo.invalid
  technical: Equipo DevOps (sintético)
  technicalEmail: devops@ejemplo.invalid
metadata:
  proposito: Consultar las tarifas vigentes por plan
  audiencia: operadores
  clasificacion: publica
security: [oauth2]
keyManagers: [Keycloak]
policies: [OperadoresEstandar]
resiliency: { timeoutMs: 5000, retries: 1, retryDelayMs: 300 }
endpoints:
  prod: http://ocultas:7001/legacy
environments:
  prod: [Default]
`;

const OPENAPI = `openapi: 3.0.3
info:
  title: Tarifas
  version: 1.0.0
  description: Tarifas vigentes de los planes de servicio de telecomunicaciones (datos sintéticos de laboratorio).
  contact:
    name: División de Tarifas (sintético)
    email: tarifas@ejemplo.invalid
servers:
  - url: https://apim:8243/tarifas/1.0.0
tags:
  - name: tarifas
paths:
  /tarifas:
    get:
      tags: [tarifas]
      operationId: listarTarifas
      summary: Lista las tarifas vigentes
      responses:
        "200": { description: Tarifas vigentes }
components:
  securitySchemes:
    oauth2:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: http://keycloak:8080/realms/nexo/protocol/openid-connect/token
          scopes: {}
security:
  - oauth2: []
`;

const inseguro = new Agent({ connect: { rejectUnauthorized: false }, connections: 64 });

async function borrarApi() {
  const w = wso2();
  for (const a of (await w.publisher.listApis(`name:"${NOMBRE}"`)).list.filter((x) => x.name === NOMBRE)) {
    const subs = await w.request<{ list: Array<{ subscriptionId: string }> }>({ method: "GET", path: `/api/am/publisher/v4/subscriptions?apiId=${a.id}&limit=100` }).catch(() => ({ list: [] }));
    for (const s of subs.list) await w.request({ method: "DELETE", path: `/api/am/devportal/v3/subscriptions/${s.subscriptionId}` }).catch(() => undefined);
    await w.request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${a.id}` });
  }
}

export const bt005: Demo = {
  id: "BT-005",
  archivo: "BT-005_publicar_proteger",
  nombre: "Publicar, proteger y enrutar una API en el gateway",
  afirmacion:
    "Una API definida por su contrato OpenAPI se publica en el gateway desde el pipeline, queda protegida con OAuth (Keycloak), suscripción y límite del plan, y enruta cada llamada al sistema de destino.",
  pasos: 5,

  async preparar(c) {
    await borrarApi();
    await c.ingresarWso2("publisher");
    return ["la API de tarifas aún no existe en WSO2 (solo la expone el NGINX heredado, como mostró el descubrimiento)"];
  },

  async ejecutar(c) {
    const w = wso2();
    const dir = join(c.archivos, "tarifas");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api.yaml"), API_YAML);
    writeFileSync(join(dir, "openapi.yaml"), OPENAPI);

    c.paso("Proyecto de API versionado: contrato OpenAPI y políticas (OAuth con Keycloak, plan, tiempos de espera)");
    c.panel(`<h3>wso2/apim/apis/tarifas/api.yaml</h3><pre style="font-size:11.5px;line-height:1.35;white-space:pre-wrap;color:#cfe3ff">${escaparHtml(API_YAML)}</pre>`);
    await c.vista("terminal-panel");
    for (const l of OPENAPI.split("\n").slice(0, 26)) c.log(l, "tenue", false);
    await c.esperar(6000);

    c.paso("El pipeline valida el contrato, crea la revisión, la despliega en el gateway y publica la API");
    const r = await nexoCtl(c, ["api", "deploy", dir, "-s", "prod", "-m", "Gobierno de la API de tarifas"], "nexo-ctl api deploy wso2/apim/apis/tarifas -s prod");
    c.exigir("pipeline terminó sin errores", r.codigo === 0, `código ${r.codigo}`);
    const api = (await w.publisher.listApis(`name:"${NOMBRE}"`)).list.find((a) => a.name === NOMBRE);
    c.exigir("API creada y publicada en WSO2", !!api && api.lifeCycleStatus === "PUBLISHED", api ? api.lifeCycleStatus ?? "" : "no existe");
    await c.vista("dividido");
    await c.ir(`https://apim:9443/publisher/apis/${api!.id}/overview`);
    await c.esperar(4500);
    await c.ir(`https://apim:9443/publisher/apis/${api!.id}/deployments`);
    await c.esperar(4000);

    c.paso("Protección: sin token 401; aplicación sin suscripción 403; suscrita y aprobada 200");
    let s0 = await gateway(URL);
    for (let i = 0; i < 10 && s0.status === 404; i++) {
      await c.esperar(1500);
      s0 = await gateway(URL);
    }
    c.log(`$ curl ${URL}   # sin token → ${s0.status}`, s0.status === 401 ? "ok" : "mal");
    c.verificar("sin token: el gateway rechaza (401)", s0.status === 401, `HTTP ${s0.status}`);
    const cred = await credencialesDe("OperadorDemo");
    const token = await tokenAplicacion(cred);
    const s1 = await gateway(URL, { token });
    c.log(`$ curl -H 'Authorization: Bearer …' ${URL}   # OperadorDemo sin suscripción → ${s1.status}`, s1.status === 403 ? "ok" : "mal");
    c.verificar("token válido pero sin suscripción: rechazo (403)", s1.status === 403, `HTTP ${s1.status}`);
    c.log("$ suscribir OperadorDemo a TarifasLegado con el plan OperadoresEstandar (Dev Portal)", "cmd");
    await w.devportal.subscribe(cred.applicationId, api!.id, "OperadoresEstandar");
    const pend = (await w.admin.listWorkflows("AM_SUBSCRIPTION_CREATION")).list;
    c.log(`flujo de aprobación: ${pend.length} suscripción(es) pendientes → aprobada por la institución (Admin API)`, "tenue");
    for (const p of pend) await w.admin.resolveWorkflow(p.referenceId, "APPROVED", "Aprobado: demostración de publicación");
    let s2 = await gateway(URL, { token });
    for (let i = 0; i < 15 && s2.status !== 200; i++) {
      await c.esperar(1000);
      s2 = await gateway(URL, { token });
    }
    c.log(`$ curl -H 'Authorization: Bearer …' ${URL}   # suscrita → ${s2.status}`, s2.status === 200 ? "ok" : "mal");
    c.log(`  ${s2.texto.slice(0, 160)}`);
    c.verificar("suscrita y con token: 200 con la respuesta del sistema de destino", s2.status === 200 && s2.texto.includes("tarifas"), `HTTP ${s2.status}`);

    c.paso("Límite del plan OperadoresEstandar (20 llamadas por segundo): el exceso recibe 429");
    const codigos: Record<string, number> = {};
    await Promise.all(
      Array.from({ length: 60 }, async () => {
        const res = await fetch(URL, { dispatcher: inseguro, headers: { authorization: `Bearer ${token}` } });
        await res.arrayBuffer();
        codigos[res.status] = (codigos[res.status] ?? 0) + 1;
      }),
    );
    c.log(`60 llamadas en el mismo segundo → ${Object.entries(codigos).map(([k, n]) => `${k}×${n}`).join("  ")}`, codigos["429"] ? "ok" : "mal");
    c.verificar("el gateway aplica el límite del plan (429)", (codigos["429"] ?? 0) > 0 && (codigos["200"] ?? 0) > 0, `${codigos["200"] ?? 0} atendidas · ${codigos["429"] ?? 0} limitadas`);

    c.paso("Enrutamiento: la analítica del gateway registra el destino de cada llamada");
    await c.esperar(6000);
    const q = {
      size: 0,
      query: { bool: { filter: [{ term: { "apiName.keyword": NOMBRE } }, { range: { "@timestamp": { gte: "now-5m" } } }] } },
      aggs: { destino: { terms: { field: "destination.keyword" }, aggs: { codigo: { terms: { field: "proxyResponseCode" } }, backend: { terms: { field: "targetResponseCode" } } } } },
    };
    c.log(`$ GET opensearch:9200/nexo-apim-metrics-*/_search  apiName=${NOMBRE}, últimos 5 min`, "cmd");
    const os = (await (await fetch("http://localhost:9200/nexo-apim-metrics-*/_search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) })).json()) as {
      aggregations?: { destino?: { buckets: Array<{ key: string; doc_count: number; codigo: { buckets: Array<{ key: number; doc_count: number }> }; backend: { buckets: Array<{ key: number; doc_count: number }> } }> } };
    };
    const destinos = os.aggregations?.destino?.buckets ?? [];
    for (const d of destinos) {
      c.log(`destino ${d.key} · ${d.doc_count} llamadas · respuesta al consumidor ${d.codigo.buckets.map((b) => `${b.key}×${b.doc_count}`).join(" ")} · respuesta del destino ${d.backend.buckets.map((b) => `${b.key}×${b.doc_count}`).join(" ")}`);
    }
    const alDestino = destinos.find((d) => d.key.startsWith("http://ocultas:7001/legacy"));
    c.verificar("las llamadas autorizadas llegaron al sistema de destino", !!alDestino && alDestino.backend.buckets.some((b) => b.key === 200), alDestino ? `${alDestino.key} · ${alDestino.doc_count} llamadas` : "sin registros");
    await c.esperar(2500);

    return {
      medido: `API publicada por el pipeline y protegida: 401 sin token, 403 sin suscripción, 200 suscrita y ${codigos["429"] ?? 0} de 60 llamadas limitadas (429) por el plan`,
      datos: { sinToken: s0.status, sinSuscripcion: s1.status, suscrita: s2.status, limite: codigos },
    };
  },

  async limpiar() {
    await borrarApi();
  },
};
