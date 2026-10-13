/**
 * BT-005 · Publicar, proteger y enrutar una API a través del gateway. Se toma la API de tarifas que el
 * descubrimiento encontró expuesta en el NGINX heredado y se la gobierna: proyecto de API (contrato +
 * políticas), el pipeline (nexo-ctl) la valida, la versiona, la despliega en el gateway y la publica; luego se
 * comprueba que el gateway la protege (OAuth con Keycloak, suscripción, límite del plan) y la enruta al sistema
 * de destino.
 *
 * Veracidad (V12): cada línea «$ …» de la terminal es el comando que se ejecuta, tal cual (curl, nexo-ctl con
 * su configuración, la consulta a la analítica); los secretos van por variables de entorno ($TOKEN). Las
 * llamadas que el guion hace por API (suscripción y aprobación) se rotulan como llamadas REST, sin «$».
 * Duración estimada: ≈ 100 s (ver ayudas-d.test.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { credencialesDe, tokenAplicacion, wso2 } from "../lib/lab.js";
import { abrir, agendaDe, ampliar, aparece, comando, corto, curl, nexoCtl, type PasoGuion } from "./ayudas-d.js";
import { prepararEnsayoD } from "./d0x-ensayo.js";

const NOMBRE = "TarifasLegado";
const URL = "https://apim:8243/tarifas/1.0.0/tarifas";
const PLAN = "OperadoresEstandar";

const API_YAML = `# Proyecto de API: contrato + políticas. Lo despliega el pipeline (nexo-ctl).
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
policies: [${PLAN}]
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

export const PASOS_BT005: PasoGuion[] = [
  {
    titulo: "Proyecto de API: contrato y políticas en un solo lugar",
    quePasa: "La API de tarifas, hoy expuesta sin control en el NGINX heredado, se describe en un proyecto: contrato OpenAPI y políticas de acceso, plan y tiempos.",
    porQueImporta: "Lo que se publica queda definido por escrito y versionado, no configurado a mano en pantallas.",
    comprueba: ["el contrato cumple la guía de estilo"],
    estimadoS: 12,
  },
  {
    titulo: "El pipeline la valida, la despliega en el gateway y la publica",
    quePasa: "La CLI del pipeline valida el contrato, crea una revisión en WSO2, la despliega en el gateway y la publica en el portal de desarrolladores.",
    porQueImporta: "Publicar es un paso repetible y auditable, el mismo en cada ambiente.",
    comprueba: ["pipeline terminó sin errores", "API publicada en el gateway"],
    estimadoS: 25,
  },
  {
    titulo: "Protección: sin token 401, sin suscripción 403, suscrita 200",
    quePasa: "Con curl: sin token, el gateway rechaza; con token válido pero sin suscripción, también. Suscrita y aprobada la aplicación, responde el destino.",
    porQueImporta: "Solo quien tiene credenciales y autorización puede consumir la API.",
    comprueba: ["sin token: el gateway rechaza (401)", "token válido sin suscripción: rechazo (403)", "suscrita: 200 con la respuesta del destino"],
    estimadoS: 22,
  },
  {
    titulo: "Límite del plan: el exceso recibe 429",
    quePasa: "Se envían 60 llamadas a la vez con la misma aplicación. El plan permite 20 por segundo: el gateway atiende hasta el límite y rechaza el resto con 429.",
    porQueImporta: "Ningún consumidor puede saturar el servicio de los demás.",
    comprueba: ["el gateway aplica el límite del plan (429)"],
    estimadoS: 10,
  },
  {
    titulo: "Enrutamiento: la analítica registra el destino de cada llamada",
    quePasa: "La analítica del gateway registra cada llamada con su destino y su respuesta. Las autorizadas llegaron al servicio de tarifas; las rechazadas, no.",
    porQueImporta: "Se puede demostrar a dónde fue cada llamada y qué respondió el sistema de destino.",
    comprueba: ["las llamadas autorizadas llegaron al sistema de destino"],
    estimadoS: 14,
  },
];

async function borrarApi() {
  const w = wso2();
  for (const a of ((await w.publisher.listApis(`name:"${NOMBRE}"`)).list ?? []).filter((x) => x.name === NOMBRE)) {
    const subs = await w.request<{ list: Array<{ subscriptionId: string }> }>({ method: "GET", path: `/api/am/publisher/v4/subscriptions?apiId=${a.id}&limit=100` }).catch(() => ({ list: [] }));
    for (const s of subs.list ?? []) await w.request({ method: "DELETE", path: `/api/am/devportal/v3/subscriptions/${s.subscriptionId}` }).catch(() => undefined);
    await w.request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${a.id}` });
  }
}

const SIN_RUTA = (l: string) => l.replace(/\/(tmp|home)\/[^ ]*\/tarifas\//, "…/tarifas/");

export const bt005: Demo = {
  id: "BT-005",
  archivo: "BT-005_publicar_proteger",
  nombre: "Publicar, proteger y enrutar una API en el gateway",
  afirmacion:
    "Una API definida por su contrato OpenAPI se publica en el gateway desde el pipeline, queda protegida con OAuth (Keycloak), suscripción y límite del plan, y enruta cada llamada al sistema de destino.",
  pasos: PASOS_BT005.length,
  agenda: agendaDe(PASOS_BT005),

  async preparar(c) {
    await prepararEnsayoD(c);
    await borrarApi();
    // En ensayo los portales son simulados: si su inicio de sesión falla, el ensayo sigue (en el laboratorio, no).
    if (c.estudio.ensayo) await c.ingresarWso2("publisher").catch((err: unknown) => c.avisar(`(ensayo) Publisher: ${err instanceof Error ? err.message.split("\n")[0] : err}`));
    else await c.ingresarWso2("publisher");
    return ["la API de tarifas aún no existe en WSO2 (solo la expone el NGINX heredado, como mostró el descubrimiento)"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const w = wso2();
    const dir = join(c.archivos, "tarifas");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api.yaml"), API_YAML);
    writeFileSync(join(dir, "openapi.yaml"), OPENAPI);

    // ── 1. Proyecto de API ─────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_BT005[0]!);
    c.panel(`<h3>tarifas/api.yaml · proyecto de la API (carpeta de trabajo de esta demostración)</h3><pre style="font-size:11.5px;line-height:1.35;white-space:pre-wrap;color:#cfe3ff">${escaparHtml(API_YAML)}</pre>`);
    await c.vista("terminal-panel");
    // La guía se indica explícita: pnpm corre nexo-ctl desde tools/nexo-ctl (la ruta por omisión es relativa a la raíz).
    const lint = await nexoCtl(c, ["api", "lint", join(dir, "openapi.yaml"), "-r", "../../wso2/apim/governance/guia-estilo-institucional.yaml"], {
      local: true,
      filtro: (l) => (/Resultado|\[error\]|Validación|Sin observaciones|ERROR/.test(l) ? SIN_RUTA(l) : undefined),
    });
    e.comprueba("el contrato cumple la guía de estilo", lint.codigo === 0, `código ${lint.codigo} · ${lint.salida.find((l) => /Resultado/.test(l))?.trim() ?? ""}`);
    for (const l of OPENAPI.split("\n").slice(0, 14)) c.log(l, "tenue", false);
    await e.esperar(2500);

    // ── 2. Pipeline: validar, desplegar, publicar ──────────────────────────────────────────────────
    await abrir(c, PASOS_BT005[1]!);
    const r = await nexoCtl(c, ["api", "deploy", dir, "-s", "prod", "-m", "Gobierno de la API de tarifas"], { filtro: SIN_RUTA, simulado: { codigo: 0, salida: ["(ensayo) revisión creada, desplegada en Default y publicada"] }, ensayoPublica: NOMBRE });
    e.exige("pipeline terminó sin errores", r.codigo === 0, `código ${r.codigo}`);
    const api = ((await w.publisher.listApis(`name:"${NOMBRE}"`)).list ?? []).find((a) => a.name === NOMBRE);
    e.exige("API publicada en el gateway", !!api && api.lifeCycleStatus === "PUBLISHED", api ? `${api.lifeCycleStatus ?? ""} · revisión desplegada en Default` : "no existe");
    await c.vista("dividido");
    if (api) {
      await c.ir(`https://apim:9443/publisher/apis/${api.id}/overview`);
      await ampliar(c, c.app.getByText(/PUBLISHED|Published|Publicad/).first(), 2400);
      await c.ir(`https://apim:9443/publisher/apis/${api.id}/deployments`);
      await aparece(c.app.getByText(/Default/).first(), 8000);
      await e.esperar(2000);
    }

    // ── 3. Protección ──────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_BT005[2]!);
    let s0 = await curl(c, URL, { comentario: "sin token" });
    for (let i = 0; i < 8 && s0.status === 404; i++) {
      await c.esperar(1500); // el gateway tarda unos segundos en recibir la revisión
      s0 = await curl(c, URL, { comentario: "sin token (reintento: la revisión aún no llega al gateway)" });
    }
    e.comprueba("sin token: el gateway rechaza (401)", s0.status === 401, `HTTP ${s0.status ?? "?"}`);
    const cred = await credencialesDe("OperadorDemo");
    const token = await tokenAplicacion(cred);
    const s1 = await curl(c, URL, { token, comentario: "token de OperadorDemo, sin suscripción" });
    e.comprueba("token válido sin suscripción: rechazo (403)", s1.status === 403, `HTTP ${s1.status ?? "?"}`);
    c.log(`Dev Portal (API REST) → POST /api/am/devportal/v3/subscriptions  OperadorDemo → ${NOMBRE}, plan ${PLAN}`, "cmd");
    await w.devportal.subscribe(cred.applicationId, api?.id ?? "", PLAN);
    const pend = (await w.admin.listWorkflows("AM_SUBSCRIPTION_CREATION")).list ?? [];
    c.log(pend.length ? `Admin (API REST) → ${pend.length} suscripción(es) pendiente(s) de aprobación institucional → aprobada(s)` : "Admin (API REST) → sin suscripciones pendientes de aprobación", "cmd");
    for (const p of pend) await w.admin.resolveWorkflow(p.referenceId, "APPROVED", "Aprobado: demostración de publicación");
    let s2 = await curl(c, URL, { token, comentario: "suscrita y aprobada" });
    for (let i = 0; i < 10 && s2.status !== 200; i++) {
      await c.esperar(1200);
      s2 = await curl(c, URL, { token, comentario: "suscrita (reintento: la suscripción llega al gateway)" });
    }
    e.comprueba("suscrita: 200 con la respuesta del destino", s2.status === 200 && /tarifa/i.test(s2.cuerpo), `HTTP ${s2.status ?? "?"} · ${corto(s2.cuerpo, 60)}`);

    // ── 4. Límite del plan ─────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_BT005[3]!);
    await c.vista("terminal");
    const rafaga = await comando(c, `seq 60 | xargs -P 60 -I{} curl -sk -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $TOKEN" ${URL} | sort | uniq -c`, { env: { TOKEN: token } });
    const codigos: Record<string, number> = {};
    for (const l of rafaga.salida) {
      const m = /^\s*(\d+)\s+(\d{3})\s*$/.exec(l);
      if (m) codigos[m[2]!] = Number(m[1]);
    }
    c.log(`60 llamadas a la vez → ${Object.entries(codigos).map(([k, v]) => `${k}×${v}`).join("  ") || "sin respuesta"}`, codigos["429"] ? "ok" : "mal");
    e.comprueba("el gateway aplica el límite del plan (429)", (codigos["429"] ?? 0) > 0 && (codigos["200"] ?? 0) > 0, `${codigos["200"] ?? 0} atendidas · ${codigos["429"] ?? 0} limitadas`);

    // ── 5. Enrutamiento en la analítica ────────────────────────────────────────────────────────────
    await abrir(c, PASOS_BT005[4]!);
    await c.esperar(6000); // la analítica del gateway se indexa con unos segundos de retraso
    const q = {
      size: 0,
      query: { bool: { filter: [{ term: { "apiName.keyword": NOMBRE } }, { range: { "@timestamp": { gte: "now-5m" } } }] } },
      aggs: { destino: { terms: { field: "destination.keyword" }, aggs: { codigo: { terms: { field: "proxyResponseCode" } }, backend: { terms: { field: "targetResponseCode" } } } } },
    };
    const archivoQ = join(c.archivos, "consulta-destinos.json");
    writeFileSync(archivoQ, JSON.stringify(q));
    c.log(`consulta-destinos.json: llamadas de ${NOMBRE} de los últimos 5 min, agrupadas por destino, respuesta al consumidor y respuesta del destino`, "tenue");
    const os = await comando(c, `curl -s -H 'content-type: application/json' 'http://localhost:9200/nexo-apim-metrics-*/_search' -d @${archivoQ}`, { silencioso: true });
    type Cubeta = { key: string | number; doc_count: number };
    let destinos: Array<Cubeta & { codigo: { buckets: Cubeta[] }; backend: { buckets: Cubeta[] } }> = [];
    try {
      destinos = (JSON.parse(os.salida.join("\n")) as { aggregations?: { destino?: { buckets: typeof destinos } } }).aggregations?.destino?.buckets ?? [];
    } catch {
      c.log(`  respuesta no legible: ${corto(os.salida.join(" "), 120)}`, "mal");
    }
    for (const d of destinos)
      c.log(`  destino ${d.key} · ${d.doc_count} llamadas · al consumidor ${d.codigo.buckets.map((b) => `${b.key}×${b.doc_count}`).join(" ")} · del destino ${d.backend.buckets.map((b) => `${b.key}×${b.doc_count}`).join(" ")}`);
    const alDestino = destinos.find((d) => String(d.key).startsWith("http://ocultas:7001/legacy"));
    e.comprueba("las llamadas autorizadas llegaron al sistema de destino", !!alDestino && alDestino.backend.buckets.some((b) => b.key === 200), alDestino ? `${alDestino.key} · ${alDestino.doc_count} llamadas` : "sin registros");
    await e.esperar(1500);

    return {
      medido: `API publicada por el pipeline y protegida: 401 sin token, 403 sin suscripción, 200 suscrita y ${codigos["429"] ?? 0} de 60 llamadas limitadas (429) por el plan`,
      datos: { sinToken: s0.status, sinSuscripcion: s1.status, suscrita: s2.status, limite: codigos },
    };
  },

  async limpiar() {
    await borrarApi();
  },
};
