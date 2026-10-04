/**
 * Arranque del laboratorio Nexo.
 *
 * 1. Keycloak: scope "default" para las aplicaciones que registra WSO2.
 * 2. WSO2: Keycloak como Key Manager (BT-025).
 * 3. API de ejemplo "Concesiones" publicada desde su contrato OpenAPI (BT-005, BT-016).
 * 4. Aplicación de consumidor con llaves en Keycloak y suscripción.
 * 5. Prueba de punta a punta: token de Keycloak → gateway → backend.
 *
 * Es idempotente: se puede ejecutar varias veces.
 */
import { Agent, fetch } from "undici";
import { Wso2Client, Wso2HttpError, type ApiSummary } from "@nexo/wso2-client";

const env = (k: string, d: string) => process.env[k] ?? d;
const CFG = {
  apim: env("NEXO_APIM_URL", "https://apim:9443"),
  gateway: env("NEXO_GATEWAY_URL", "https://apim:8243"),
  keycloak: env("NEXO_KEYCLOAK_URL", "http://keycloak:8080"),
  realm: env("NEXO_KEYCLOAK_REALM", "nexo"),
  kcAdminPassword: env("KEYCLOAK_ADMIN_PASSWORD", "nexo-lab-kc-admin"),
  kmClientSecret: env("KEYCLOAK_KM_CLIENT_SECRET", "nexo-lab-km-secret"),
  apimUser: env("APIM_ADMIN_USER", "admin"),
  apimPassword: env("APIM_ADMIN_PASSWORD", "admin"),
  backendPublicUrl: env("NEXO_BACKEND_PUBLIC_URL", "http://localhost:7001"),
};

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const log = (msg: string, extra?: unknown) =>
  console.log(`[bootstrap] ${msg}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ""}`);

const wso2 = new Wso2Client({
  baseUrl: CFG.apim,
  auth: { type: "basic", username: CFG.apimUser, password: CFG.apimPassword },
  tls: { rejectUnauthorized: false },
});

async function waitFor(name: string, url: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { dispatcher: insecure });
      if (res.status < 500) return;
    } catch {
      /* todavía no responde */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`${name} no respondió en ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ------------------------------------------------------------------ Keycloak

async function keycloakAdminToken(): Promise<string> {
  const res = await fetch(`${CFG.keycloak}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: CFG.kcAdminPassword,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Keycloak admin token: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function kc<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CFG.keycloak}/admin/realms/${CFG.realm}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 409) throw new Error(`Keycloak ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function ensureDefaultScope(): Promise<void> {
  const token = await keycloakAdminToken();
  let scopes = await kc<Array<{ id: string; name: string }>>(token, "GET", "/client-scopes");
  let scope = scopes.find((s) => s.name === "default");
  if (!scope) {
    await kc(token, "POST", "/client-scopes", {
      name: "default",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
    });
    scopes = await kc<Array<{ id: string; name: string }>>(token, "GET", "/client-scopes");
    scope = scopes.find((s) => s.name === "default");
  }
  if (!scope) throw new Error("no se pudo crear el client scope default");
  await kc(token, "PUT", `/default-default-client-scopes/${scope.id}`);
  const clients = await kc<Array<{ id: string; clientId: string }>>(token, "GET", "/clients?clientId=wso2-km");
  if (clients[0]) await kc(token, "PUT", `/clients/${clients[0].id}/default-client-scopes/${scope.id}`);
  log("Keycloak: scope 'default' disponible para las aplicaciones");
}

// ------------------------------------------------------------------ WSO2

async function ensureKeyManager(): Promise<void> {
  const existing = await wso2.admin.listKeyManagers();
  if (existing.list.some((k) => k.name === "Keycloak")) {
    log("WSO2: Key Manager Keycloak ya existe");
    return;
  }
  const base = `${CFG.keycloak}/realms/${CFG.realm}`;
  const endpoints = {
    client_registration_endpoint: `${base}/clients-registrations/openid-connect`,
    introspection_endpoint: `${base}/protocol/openid-connect/token/introspect`,
    token_endpoint: `${base}/protocol/openid-connect/token`,
    revoke_endpoint: `${base}/protocol/openid-connect/revoke`,
    userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
    authorize_endpoint: `${base}/protocol/openid-connect/auth`,
    scope_management_endpoint: `${CFG.keycloak}/admin/realms/${CFG.realm}/client-scopes`,
  };
  await wso2.admin.createKeyManager({
    name: "Keycloak",
    displayName: "Keycloak institucional",
    type: "KeyCloak",
    description: "Keycloak como Key Manager de Nexo (BT-025). En SUBTEL apunta al Keycloak institucional.",
    enabled: true,
    wellKnownEndpoint: `${base}/.well-known/openid-configuration`,
    issuer: base,
    clientRegistrationEndpoint: endpoints.client_registration_endpoint,
    introspectionEndpoint: endpoints.introspection_endpoint,
    tokenEndpoint: endpoints.token_endpoint,
    revokeEndpoint: endpoints.revoke_endpoint,
    userInfoEndpoint: endpoints.userinfo_endpoint,
    authorizeEndpoint: endpoints.authorize_endpoint,
    scopeManagementEndpoint: endpoints.scope_management_endpoint,
    endpoints: Object.entries(endpoints).map(([name, value]) => ({ name, value })),
    certificates: { type: "JWKS", value: `${base}/protocol/openid-connect/certs` },
    availableGrantTypes: ["client_credentials", "password", "authorization_code", "refresh_token"],
    consumerKeyClaim: "azp",
    scopesClaim: "scope",
    enableTokenGeneration: true,
    enableTokenEncryption: false,
    enableTokenHashing: false,
    enableMapOAuthConsumerApps: true,
    enableOAuthAppCreation: true,
    enableSelfValidationJWT: true,
    tokenValidation: [],
    additionalProperties: {
      ...endpoints,
      client_id: "wso2-km",
      client_secret: CFG.kmClientSecret,
      self_validate_jwt: true,
    },
  });
  log("WSO2: Key Manager Keycloak creado");
}

async function findApi(name: string): Promise<ApiSummary | undefined> {
  const res = await wso2.publisher.listApis(`name:"${name}"`);
  return res.list.find((a) => a.name === name);
}

async function gatewayVhost(): Promise<{ name: string; vhost: string }> {
  const settings = (await wso2.publisher.settings()) as {
    environment?: Array<{ name: string; vhosts?: Array<{ host: string }> }>;
  };
  const envDefault = settings.environment?.find((e) => e.name === "Default") ?? settings.environment?.[0];
  return { name: envDefault?.name ?? "Default", vhost: envDefault?.vhosts?.[0]?.host ?? "localhost" };
}

async function ensureConcesionesApi(): Promise<ApiSummary> {
  const found = await findApi("Concesiones");
  if (found) {
    log("WSO2: API Concesiones ya existe", { id: found.id, estado: found.lifeCycleStatus });
    return found;
  }
  const spec = await (await fetch(`${CFG.backendPublicUrl}/openapi.json`)).text();
  const api = await wso2.publisher.importOpenApi(spec, {
    name: "Concesiones",
    version: "1.0.0",
    context: "/concesiones",
    description: "Consulta y solicitud de concesiones de telecomunicaciones (datos sintéticos de laboratorio)",
    policies: ["Unlimited", "Gold", "Silver"],
    securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
    keyManagers: ["Keycloak"],
    visibility: "PUBLIC",
    endpointConfig: {
      endpoint_type: "http",
      production_endpoints: { url: "http://concesiones-v1:7001" },
      sandbox_endpoints: { url: "http://concesiones-v1:7001" },
    },
    businessInformation: {
      businessOwner: "División de Concesiones (sintético)",
      businessOwnerEmail: "concesiones@ejemplo.invalid",
      technicalOwner: "Equipo DevOps (sintético)",
      technicalOwnerEmail: "devops@ejemplo.invalid",
    },
    additionalProperties: [
      { name: "proposito", value: "Consultar y registrar concesiones de servicios de telecomunicaciones", display: true },
      { name: "audiencia", value: "operadores", display: true },
      { name: "clasificacion", value: "publica", display: true },
    ],
  });
  log("WSO2: API Concesiones creada", { id: api.id });
  const gw = await gatewayVhost();
  const rev = await wso2.publisher.createRevision(api.id, "Revisión inicial (bootstrap)");
  await wso2.publisher.deployRevision(api.id, rev.id, [gw]);
  await wso2.publisher.changeLifecycle(api.id, "Publish");
  log("WSO2: API desplegada y publicada", { gateway: gw, revision: rev.id });
  return { ...api, lifeCycleStatus: "PUBLISHED" };
}

async function ensureConsumerApp(apiId: string): Promise<{ consumerKey: string; consumerSecret: string }> {
  const apps = await wso2.devportal.listApplications();
  let app = apps.list.find((a) => a.name === "OperadorDemo");
  if (!app) {
    app = await wso2.devportal.createApplication("OperadorDemo", "Aplicación de un operador de telecomunicaciones (sintético)");
    log("Dev Portal: aplicación creada", { id: app.applicationId });
  }
  const keys = await wso2.devportal.listKeys(app.applicationId);
  let key = keys.list.find((k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION");
  if (!key) {
    key = await wso2.devportal.generateKeys(app.applicationId, "Keycloak", ["client_credentials"], "PRODUCTION", {
      subject_type: "public",
      token_endpoint_auth_method: "client_secret_basic",
      tls_client_certificate_bound_access_tokens: "false",
    });
    log("Dev Portal: llaves generadas en Keycloak", { consumerKey: key.consumerKey });
  }
  const subs = await wso2.devportal.listSubscriptions(app.applicationId);
  if (!subs.list.some((s) => s.apiId === apiId || s.apiInfo?.id === apiId)) {
    try {
      await wso2.devportal.subscribe(app.applicationId, apiId, "Unlimited");
      log("Dev Portal: suscripción creada");
    } catch (e) {
      if (!(e instanceof Wso2HttpError && e.status === 409)) throw e;
    }
  }
  if (!key.consumerKey || !key.consumerSecret) throw new Error("las llaves no traen consumerKey/consumerSecret");
  return { consumerKey: key.consumerKey, consumerSecret: key.consumerSecret };
}

async function endToEnd(creds: { consumerKey: string; consumerSecret: string }): Promise<void> {
  const tokenRes = await fetch(`${CFG.keycloak}/realms/${CFG.realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token Keycloak: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  log("Keycloak: token emitido para la aplicación");

  const url = `${CFG.gateway}/concesiones/1.0.0/concesiones?estado=vigente`;
  for (let i = 1; i <= 20; i++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${access_token}` }, dispatcher: insecure });
    const body = await res.text();
    if (res.status === 200) {
      const parsed = JSON.parse(body) as { total: number; version: string };
      log("PRUEBA DE PUNTA A PUNTA OK: gateway → backend", { status: 200, total: parsed.total, version: parsed.version });
      const denied = await fetch(url, { dispatcher: insecure });
      log("Sin token el gateway rechaza la llamada", { status: denied.status });
      return;
    }
    log(`intento ${i}: gateway respondió ${res.status}`, body.slice(0, 200));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("el gateway no respondió 200 a tiempo");
}

async function main(): Promise<void> {
  await waitFor("Keycloak", `${CFG.keycloak}/realms/${CFG.realm}/.well-known/openid-configuration`);
  await waitFor("API Manager", `${CFG.apim}/services/Version`);
  await ensureDefaultScope();
  await ensureKeyManager();
  const api = await ensureConcesionesApi();
  const creds = await ensureConsumerApp(api.id);
  await endToEnd(creds);
}

main().catch((err) => {
  console.error("[bootstrap] ERROR", err instanceof Error ? err.message : err);
  process.exit(1);
});
