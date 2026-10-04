/**
 * D-03 · Validación automática de contratos OpenAPI contra una guía de estilo institucional configurable,
 * ejecutada en el pipeline y bloqueante ante incumplimiento. El paso de CI valida los contratos versionados; un
 * contrato que no cumple no se promueve (nexo-ctl api deploy termina con error y nada llega a WSO2); si alguien
 * lo carga a mano, la política de gobierno de WSO2 bloquea su despliegue; corregido, el pipeline lo publica;
 * y la institución puede endurecer la guía y el pipeline vuelve a bloquear.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { desdeRaiz } from "../lib/entorno.js";
import { wso2 } from "../lib/lab.js";
import { esperarHasta, nexoCtl } from "./comun.js";

const NOMBRE = "ReportesInternos";
const GUIA = desdeRaiz("wso2/apim/governance/guia-estilo-institucional.yaml");

const API_YAML = `name: ${NOMBRE}
version: 1.0.0
context: /reportes-internos
description: Reportes internos de fiscalización (datos sintéticos de laboratorio).
type: HTTP
contract: openapi.yaml
owner:
  business: División de Fiscalización (sintético)
  businessEmail: fiscalizacion@ejemplo.invalid
  technical: Equipo DevOps (sintético)
  technicalEmail: devops@ejemplo.invalid
metadata:
  proposito: Consultar reportes internos de fiscalización
  audiencia: interna
  clasificacion: interna
security: [oauth2]
keyManagers: [Keycloak]
policies: [Interno]
endpoints:
  dev: http://ocultas:7001
environments:
  dev: [Desarrollo]
`;

/** El contrato corregido: cumple todas las reglas de error; las operaciones no llevan tags (solo advertencia). */
const CORREGIDO = `openapi: 3.0.3
info:
  title: Reportes Internos
  version: 1.0.0
  description: Reportes internos de fiscalización de servicios de telecomunicaciones.
  contact:
    name: División de Fiscalización (sintético)
    email: fiscalizacion@ejemplo.invalid
servers:
  - url: https://dev.nexo.lab:8243/reportes-internos/1.0.0
paths:
  /reportes:
    get:
      operationId: listarReportes
      summary: Lista los reportes internos
      responses:
        "200": { description: Reportes }
  /reportes/{id}:
    get:
      operationId: obtenerReporte
      summary: Obtiene un reporte
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: Reporte }
        "404": { description: No existe }
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

async function borrarApi() {
  const w = wso2();
  for (const a of (await w.publisher.listApis(`name:"${NOMBRE}"`)).list.filter((x) => x.name === NOMBRE)) {
    await w.request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${a.id}` });
  }
}

export const d03: Demo = {
  id: "D-03",
  archivo: "D-03_contratos_pipeline",
  nombre: "Validación de contratos OpenAPI contra la guía de estilo, bloqueante en el pipeline",
  afirmacion:
    "Cada contrato OpenAPI se valida automáticamente contra la guía de estilo institucional, configurable por la institución: el pipeline bloquea la promoción si no cumple y la política de gobierno de WSO2 bloquea su despliegue aunque se cargue a mano.",
  pasos: 5,

  async preparar(c) {
    await borrarApi();
    await c.ingresarWso2("publisher");
    return ["la API de ejemplo ReportesInternos no existe en WSO2"];
  },

  async ejecutar(c) {
    const w = wso2();
    const dir = join(c.archivos, "reportes-internos");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api.yaml"), API_YAML);
    const malo = readFileSync(desdeRaiz("wso2/apim/apis/_ejemplos/contrato-incumple.yaml"), "utf8");

    c.paso("Guía de estilo institucional configurable y paso del pipeline de CI que valida todos los contratos");
    const guia = parse(readFileSync(GUIA, "utf8")) as { rules: Record<string, { description: string; severity: string }> };
    const filas = Object.entries(guia.rules)
      .filter(([id]) => !/-(put|post|delete|patch)$/.test(id))
      .map(([id, r]) => `<tr><td><code>${escaparHtml(id.replace(/-get$/, ""))}</code></td><td class="${r.severity === "error" ? "mal" : ""}">${r.severity}</td><td>${escaparHtml(r.description)}</td></tr>`)
      .join("");
    c.panel(`<h3>wso2/apim/governance/guia-estilo-institucional.yaml (${Object.keys(guia.rules).length} reglas)</h3><table><tr><th>Regla</th><th>Severidad</th><th>Qué exige</th></tr>${filas}</table>`);
    await c.vista("terminal-panel");
    c.log(".github/workflows/ci.yml · trabajo «contratos» (bloqueante):", "tenue");
    c.log("  - run: pnpm --filter @nexo/nexo-ctl contratos", "tenue");
    const ci = await c.ejecutarComando("pnpm", ["--silent", "--filter", "@nexo/nexo-ctl", "contratos"], { mostrar: "pnpm --filter @nexo/nexo-ctl contratos", tablas: false, filtro: (l) => (/Resultado|Contratos:|Esquema|Validación del contrato/.test(l) ? l.replace(/\/home\/[^ ]*wso2\/apim\/apis\//, "wso2/apim/apis/") : undefined) });
    c.verificar("el paso de CI valida los contratos versionados", ci.codigo === 0, "5 contratos cumplen");
    await c.esperar(4000);

    c.paso("Un contrato que no cumple intenta pasar por el pipeline: la promoción se bloquea");
    writeFileSync(join(dir, "openapi.yaml"), malo);
    await c.vista("dividido");
    await c.ir(`https://apim:9443/publisher/apis`);
    const r1 = await nexoCtl(c, ["api", "deploy", dir, "-s", "dev", "-m", "Primera versión"], "nexo-ctl api deploy reportes-internos -s dev");
    const enWso2 = (await w.publisher.listApis(`name:"${NOMBRE}"`)).list.filter((a) => a.name === NOMBRE);
    c.verificar("pipeline bloqueado (código de salida 2)", r1.codigo === 2 && r1.salida.some((l) => l.includes("PROMOCIÓN BLOQUEADA")), `código ${r1.codigo}`);
    c.verificar("nada llegó a WSO2", enWso2.length === 0, `${enWso2.length} APIs ${NOMBRE}`);
    await c.esperar(3000);
    await c.app.reload();
    await c.esperar(3000);

    c.paso("Si alguien lo carga a mano en WSO2, la política de gobierno bloquea su despliegue");
    c.log("$ POST /api/am/publisher/v4/apis/import-openapi   # carga manual, sin pasar por el pipeline", "cmd");
    const manual = await w.publisher.importOpenApi(malo, { name: NOMBRE, version: "1.0.0", context: "/reportes-internos", policies: ["Interno"], endpointConfig: { endpoint_type: "http", production_endpoints: { url: "http://ocultas:7001" }, sandbox_endpoints: { url: "http://ocultas:7001" } } } as never);
    c.log(`  API creada en el Publisher (${manual.id.slice(0, 8)}…), sin desplegar`, "tenue");
    c.log("$ POST /api/am/publisher/v4/apis/{id}/revisions   # intento de revisión para desplegar", "cmd");
    let bloqueo = "";
    try {
      await w.publisher.createRevision(manual.id, "carga manual");
    } catch (e) {
      bloqueo = (e as { body?: string }).body ?? String(e);
    }
    const detalle = (() => {
      try {
        const b = JSON.parse(bloqueo) as { message?: string; description?: string };
        const v = JSON.parse(b.description ?? "{}") as { blockingViolations?: Array<{ ruleName: string; message: string }> };
        return { mensaje: b.message ?? "", violaciones: v.blockingViolations ?? [] };
      } catch {
        return { mensaje: bloqueo.slice(0, 120), violaciones: [] as Array<{ ruleName: string; message: string }> };
      }
    })();
    c.log(`  HTTP 400 · ${detalle.mensaje}`, "mal");
    for (const v of detalle.violaciones.slice(0, 8)) c.log(`  [bloqueante] ${v.ruleName}: ${v.message}`, "aviso");
    c.verificar("WSO2 API Governance bloquea el despliegue del contrato no conforme", /governance/i.test(detalle.mensaje) && detalle.violaciones.length > 0, `${detalle.violaciones.length} violaciones bloqueantes`);
    await c.app.goto(`https://apim:9443/publisher/apis/${manual.id}/overview`);
    await c.esperar(2500);
    const cumplimiento = c.app.getByText("Compliance", { exact: true }).first();
    if (await cumplimiento.isVisible().catch(() => false)) {
      await c.clic(cumplimiento);
      await c.esperar(5500);
    }
    await w.request({ method: "DELETE", path: `/api/am/publisher/v4/apis/${manual.id}` });
    c.log("  (se elimina la API cargada a mano)", "tenue");

    c.paso("El equipo corrige el contrato: el pipeline lo valida, lo versiona y lo publica en Desarrollo");
    writeFileSync(join(dir, "openapi.yaml"), CORREGIDO);
    c.log("cambios: kebab-case en las rutas, contacto, descripción, versión semántica, summary, HTTPS y OAuth en vez de HTTP basic", "tenue");
    const r2 = await nexoCtl(c, ["api", "deploy", dir, "-s", "dev", "-m", "Contrato corregido"], "nexo-ctl api deploy reportes-internos -s dev");
    // La búsqueda del Publisher indexa con unos segundos de retraso.
    const encontrada = await esperarHasta(async () => (await w.publisher.listApis(`name:"${NOMBRE}"`)).list.find((a) => a.name === NOMBRE), (a) => !!a, 30, 1500);
    const creada = encontrada?.valor;
    c.verificar("contrato corregido: promovido y publicado", r2.codigo === 0 && !!creada, creada ? `${creada.lifeCycleStatus} en Desarrollo` : `código ${r2.codigo}`);
    if (creada) await c.app.goto(`https://apim:9443/publisher/apis/${creada.id}/overview`);
    await c.esperar(5000);

    c.paso("La guía es configurable: la institución exige etiquetas (tags) y el pipeline vuelve a bloquear");
    const guia2 = parse(readFileSync(GUIA, "utf8")) as { rules: Record<string, { severity: string }> };
    for (const id of Object.keys(guia2.rules)) if (id.startsWith("nexo-etiquetas-")) guia2.rules[id]!.severity = "error";
    const guiaPropia = join(c.archivos, "guia-institucion.yaml");
    writeFileSync(guiaPropia, stringify(guia2));
    c.log("guia-institucion.yaml: nexo-etiquetas-* pasa de «warn» a «error»", "tenue");
    const r3 = await nexoCtl(c, ["api", "lint", join(dir, "openapi.yaml"), "-r", guiaPropia], "nexo-ctl api lint reportes-internos/openapi.yaml -r guia-institucion.yaml");
    c.verificar("con la regla endurecida el mismo contrato se rechaza", r3.codigo === 2, `código ${r3.codigo}`);
    await c.esperar(4500);

    return {
      medido: `contrato no conforme bloqueado por el pipeline (código 2, nada llegó a WSO2) y por la política de gobierno de WSO2 (${detalle.violaciones.length} violaciones); corregido, se publicó; con la guía endurecida, se rechazó`,
      datos: { violacionesWso2: detalle.violaciones.length },
    };
  },

  async limpiar() {
    await borrarApi();
  },
};
