import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { buildSchema, isObjectType } from "graphql";
import { DEFAULT_MAX_REVISIONS, pruneRevisions, Wso2HttpError, type ApiSummary, type Wso2Client } from "@nexo/wso2-client";
import { clientFor, type CtlConfig, type StageConfig } from "../config.js";
import { formatIssues, lintContract } from "../lint.js";

/** Proyecto de API versionado en Git (wso2/apim/apis/<nombre>/api.yaml + contrato). */
export interface ApiProject {
  name: string;
  version: string;
  context: string;
  description: string;
  type?: "HTTP" | "SOAP" | "GRAPHQL" | "WS" | "WEBSUB" | "SSE" | "ASYNC";
  contract: string;
  owner: { business: string; businessEmail: string; technical: string; technicalEmail: string };
  metadata: Record<string, string>;
  security?: string[];
  keyManagers?: string[];
  policies: string[];
  apiThrottlingPolicy?: string;
  endpoints: Record<string, string>;
  resiliency?: {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    suspendInitialMs?: number;
    suspendMaxMs?: number;
    suspendFactor?: number;
  };
  environments: Record<string, string[]>;
  /**
   * Etapas donde el tráfico pasa por nexo-division para despliegues progresivos sin corte (D-04).
   * El gateway llama a <division>/rutas/<nombre> y el backend de "endpoints" queda como estable de la ruta.
   */
  division?: Record<string, boolean>;
}

export function loadProject(dir: string): ApiProject & { dir: string } {
  const file = join(dir, "api.yaml");
  if (!existsSync(file)) throw new Error(`No existe ${file}`);
  return { ...(parse(readFileSync(file, "utf8")) as ApiProject), dir: resolve(dir) };
}

/** Configuración de endpoint con tiempos de espera, reintentos acotados y suspensión progresiva (BT-007). */
function endpointConfig(url: string, r: ApiProject["resiliency"] = {}) {
  const config = {
    actionSelect: "fault",
    actionDuration: String(r.timeoutMs ?? 10_000),
    retryTimeOut: String(r.retries ?? 2),
    retryDelay: String(r.retryDelayMs ?? 500),
    suspendDuration: String(r.suspendInitialMs ?? 30_000),
    suspendMaxDuration: String(r.suspendMaxMs ?? 300_000),
    factor: String(r.suspendFactor ?? 2),
    suspendErrorCode: ["101504", "101505", "101500"],
    retryErroCode: ["101503", "101504"],
  };
  return {
    endpoint_type: "http",
    production_endpoints: { url, config },
    sandbox_endpoints: { url, config },
  };
}

/** Nombre de la ruta en nexo-division: el directorio del proyecto (p. ej. "concesiones"). */
export function divisionRoute(p: { dir: string }): string {
  return basename(p.dir).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function apiBody(p: ApiProject & { dir: string }, stageName: string, baseDir: string, s: StageConfig) {
  const backend = p.endpoints[stageName];
  if (!backend) throw new Error(`El proyecto ${p.name} no define endpoint para la etapa ${stageName}`);
  const viaDivision = p.division?.[stageName] === true;
  if (viaDivision && !s.division) throw new Error(`La etapa ${stageName} no define la URL de nexo-division ("division") en nexo-ctl.config.yaml`);
  const url = viaDivision ? `${s.division!.replace(/\/+$/, "")}/rutas/${divisionRoute(p)}` : backend;
  const type = p.type ?? "HTTP";
  const isWs = type === "WS";
  return {
    name: p.name,
    type,
    version: p.version,
    context: p.context,
    description: p.description,
    policies: p.policies,
    apiThrottlingPolicy: p.apiThrottlingPolicy,
    securityScheme: p.security ?? ["oauth2", "oauth_basic_auth_api_key_mandatory"],
    keyManagers: p.keyManagers ?? ["Keycloak"],
    visibility: "PUBLIC",
    endpointConfig: isWs
      ? { endpoint_type: "ws", production_endpoints: { url }, sandbox_endpoints: { url } }
      : endpointConfig(url, p.resiliency),
    businessInformation: {
      businessOwner: p.owner.business,
      businessOwnerEmail: p.owner.businessEmail,
      technicalOwner: p.owner.technical,
      technicalOwnerEmail: p.owner.technicalEmail,
    },
    // El contrato versionado en el repositorio queda referenciado en la ficha del catálogo (BT-018).
    additionalProperties: Object.entries({
      contrato: relative(baseDir, join(p.dir, p.contract)).split(sep).join("/"),
      ...(viaDivision ? { division_estable: backend } : {}),
      ...p.metadata,
    }).map(
      ([name, value]) => ({ name, value, display: true }),
    ),
  };
}

async function findApi(wso2: Wso2Client, name: string, version: string): Promise<ApiSummary | undefined> {
  const res = await wso2.publisher.listApis(`name:"${name}" version:"${version}"`);
  return res.list.find((a) => a.name === name && a.version === version);
}

export interface LintOptions {
  ruleset: string;
}

/** Operaciones GraphQL (consultas y mutaciones) derivadas del esquema, como las espera WSO2. */
function graphqlOperations(sdl: string) {
  const schema = buildSchema(sdl);
  const ops: Array<{ target: string; verb: string; authType: string; throttlingPolicy: string }> = [];
  for (const [root, verb] of [
    [schema.getQueryType(), "QUERY"],
    [schema.getMutationType(), "MUTATION"],
    [schema.getSubscriptionType(), "SUBSCRIPTION"],
  ] as const) {
    if (root && isObjectType(root)) {
      for (const field of Object.keys(root.getFields())) {
        ops.push({ target: field, verb, authType: "Application & Application User", throttlingPolicy: "Unlimited" });
      }
    }
  }
  return ops;
}

export function runLint(contract: string, opts: LintOptions): boolean {
  const res = lintContract(contract, opts.ruleset);
  console.log(`Validación del contrato ${contract} contra la guía de estilo:`);
  console.log(formatIssues(res));
  console.log(`  Resultado: ${res.errors.length} errores, ${res.warnings.length} advertencias, ${res.infos.length} info.`);
  return res.errors.length === 0;
}

/**
 * Valida todos los contratos versionados (OpenAPI y AsyncAPI) de una carpeta de proyectos de API contra su
 * guía de estilo. Es el paso del pipeline de integración continua: si un contrato tiene errores, falla (D-03).
 * Se omiten las carpetas que empiezan con «_» (ejemplos que no cumplen a propósito).
 */
export function lintAll(apisDir: string, governanceDir: string): boolean {
  let ok = true;
  let n = 0;
  for (const name of readdirSync(apisDir).sort()) {
    const dir = join(apisDir, name);
    if (name.startsWith("_") || !statSync(dir).isDirectory() || !existsSync(join(dir, "api.yaml"))) continue;
    const p = loadProject(dir);
    if (p.type === "GRAPHQL") {
      graphqlOperations(readFileSync(join(dir, p.contract), "utf8"));
      console.log(`Esquema GraphQL ${name}/${p.contract} válido.`);
      n++;
      continue;
    }
    const isAsync = p.type === "WS" || p.type === "WEBSUB" || p.type === "SSE";
    const ruleset = join(governanceDir, isAsync ? "guia-asyncapi.yaml" : "guia-estilo-institucional.yaml");
    if (!runLint(join(dir, p.contract), { ruleset })) ok = false;
    n++;
  }
  console.log(ok ? `Contratos: ${n} validados, todos cumplen la guía de estilo.` : "CONTRATOS RECHAZADOS: hay errores de la guía de estilo (D-03).");
  return ok;
}

/**
 * Despliega un proyecto de API en una etapa: valida el contrato (bloqueante), crea o actualiza la
 * API, crea una revisión versionada, la despliega en los gateways de la etapa y la publica.
 * Nunca edita producción a mano: todo sale del proyecto versionado (BT-017, BT-044, BT-057).
 */
export async function deployApi(cfg: CtlConfig, stageName: string, s: StageConfig, dir: string, opts: LintOptions & { message: string }) {
  const p = loadProject(dir);
  const contractPath = join(p.dir, p.contract);
  const type = p.type ?? "HTTP";
  const contract = readFileSync(contractPath, "utf8");
  if (type === "GRAPHQL") {
    graphqlOperations(contract); // falla si el esquema no es válido
    console.log(`Esquema GraphQL ${p.contract} válido.`);
  } else {
    const ruleset = type === "WS" || type === "WEBSUB" || type === "SSE" ? join(opts.ruleset, "..", "guia-asyncapi.yaml") : opts.ruleset;
    if (!runLint(contractPath, { ruleset })) {
      console.error("PROMOCIÓN BLOQUEADA: el contrato tiene errores de la guía de estilo (D-03).");
      process.exitCode = 2;
      return;
    }
  }
  const wso2 = clientFor(s);
  const body = apiBody(p, stageName, cfg.baseDir, s);
  let api = await findApi(wso2, p.name, p.version);
  if (!api) {
    if (type === "GRAPHQL") api = await wso2.publisher.importGraphQl(contract, { ...body, operations: graphqlOperations(contract) });
    else if (type === "WS" || type === "WEBSUB" || type === "SSE") api = await wso2.publisher.importAsyncApi(contract, body);
    else api = await wso2.publisher.importOpenApi(contract, body);
    console.log(`API ${p.name} ${p.version} (${type}) creada (${api.id}).`);
  } else {
    const current = await wso2.publisher.getApi(api.id);
    await wso2.publisher.updateApi(api.id, { ...current, ...body });
    if (type === "HTTP") await wso2.publisher.updateDefinition(api.id, contract);
    console.log(`API ${p.name} ${p.version} actualizada (${api.id}).`);
  }
  const gateways = (p.environments[stageName] ?? []).map((name) => {
    const gw = s.gateways.find((g) => g.name === name);
    if (!gw) throw new Error(`La etapa ${stageName} no tiene el gateway ${name} en nexo-ctl.config.yaml`);
    return gw;
  });
  const pruned = await pruneRevisions(wso2, api.id, Number(process.env.NEXO_MAX_REVISIONS ?? DEFAULT_MAX_REVISIONS));
  if (pruned.length) console.log(`Revisiones antiguas sin desplegar eliminadas: ${pruned.join(", ")}`);
  const revision = await wso2.publisher.createRevision(api.id, `${opts.message} · etapa ${stageName}`);
  try {
    await wso2.publisher.deployRevision(api.id, revision.id, gateways);
  } catch (e) {
    if (e instanceof Wso2HttpError && /governance|complian/i.test(e.body)) {
      console.error("DESPLIEGUE BLOQUEADO por la política de gobierno de WSO2 (D-03):");
      console.error(`  ${e.body.slice(0, 800)}`);
      process.exitCode = 3;
      return;
    }
    throw e;
  }
  console.log(`Revisión ${revision.id} desplegada en: ${gateways.map((g) => `${g.name} (${g.vhost})`).join(", ")}`);
  if (s.publish !== false) {
    const fresh = await wso2.publisher.getApi(api.id);
    if (fresh.lifeCycleStatus !== "PUBLISHED") {
      await wso2.publisher.changeLifecycle(api.id, "Publish");
      console.log("API publicada en el portal de desarrolladores.");
    }
  }
  void cfg;
}

/** Vuelve a la revisión anterior en los gateways de la etapa (reversa sin edición manual). */
export async function rollbackApi(s: StageConfig, name: string, version: string) {
  const wso2 = clientFor(s);
  const api = await findApi(wso2, name, version);
  if (!api) throw new Error(`No existe la API ${name} ${version}`);
  const revs = (await wso2.publisher.listRevisions(api.id)).list;
  const deployed = revs.filter((r) => (r.deploymentInfo ?? []).length > 0);
  const current = deployed.sort((a, b) => (b.createdTime ?? 0) - (a.createdTime ?? 0))[0];
  if (!current) throw new Error("No hay revisiones desplegadas");
  const older = revs.filter((r) => (r.createdTime ?? 0) < (current.createdTime ?? 0)).sort((a, b) => (b.createdTime ?? 0) - (a.createdTime ?? 0));
  const previous = older[0];
  if (!previous) throw new Error("No hay una revisión anterior a la que volver");
  const gateways = (current.deploymentInfo ?? []).map((d) => ({ name: d.name, vhost: d.vhost ?? "" }));
  await wso2.publisher.deployRevision(api.id, previous.id, gateways);
  console.log(`Reversa: ${name} ${version} vuelve de la revisión ${current.displayName ?? current.id} a ${previous.displayName ?? previous.id} en ${gateways.map((g) => g.name).join(", ")}.`);
}

/** Exporta APIs en el formato de proyecto de WSO2 (compatible con apictl) más un manifiesto con hashes (BT-049, BT-060). */
export async function exportApis(s: StageConfig, outDir: string) {
  const wso2 = clientFor(s);
  mkdirSync(outDir, { recursive: true });
  const apis = (await wso2.publisher.listApis(undefined, 500)).list;
  const items: Array<{ tipo: string; nombre: string; archivo: string; sha256: string }> = [];
  for (const a of apis) {
    const zip = await wso2.publisher.exportApi(a.id);
    const file = `${a.name}-${a.version}.zip`.replace(/[^\w.-]+/g, "_");
    writeFileSync(join(outDir, file), zip);
    items.push({ tipo: "api", nombre: `${a.name} ${a.version}`, archivo: file, sha256: createHash("sha256").update(zip).digest("hex") });
    console.log(`  exportada ${a.name} ${a.version} → ${file}`);
  }
  const manifest = { generadoEn: new Date().toISOString(), origen: s.apim, version: "1", items };
  writeFileSync(join(outDir, "manifiesto.json"), JSON.stringify(manifest, null, 2));
  console.log(`Manifiesto: ${join(outDir, "manifiesto.json")} (${items.length} APIs)`);
}

export async function listApis(s: StageConfig) {
  const wso2 = clientFor(s);
  const apis = (await wso2.publisher.listApis(undefined, 500)).list;
  for (const a of apis) console.log(`${a.id}  ${a.name} ${a.version}  ${a.context}  ${a.lifeCycleStatus ?? ""}`);
}
