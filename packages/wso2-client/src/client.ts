import type { Agent } from "undici";
import { createAgent, FormData, httpRequest, type HttpRequest, type TlsOptions } from "./http.js";
import type {
  ApiList,
  ApiRevision,
  ApiSummary,
  Application,
  ApplicationKey,
  DenyPolicy,
  DenyPolicyType,
  KeyManager,
  Subscription,
  WorkflowList,
} from "./types.js";

export type Wso2Auth =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth"; username: string; password: string; scopes?: string[] };

export interface Wso2ClientOptions {
  /** URL de administración, por ejemplo https://apim:9443 */
  baseUrl: string;
  auth: Wso2Auth;
  tls?: TlsOptions;
}

/** Scopes de las REST API de WSO2 API Manager 4.x que usa Nexo. */
export const DEFAULT_SCOPES = [
  "apim:api_view",
  "apim:api_create",
  "apim:api_manage",
  "apim:api_publish",
  "apim:api_delete",
  "apim:api_import_export",
  "apim:subscribe",
  "apim:app_manage",
  "apim:sub_manage",
  "apim:subscription_view",
  "apim:subscription_manage",
  "apim:tier_view",
  "apim:tier_manage",
  "apim:bl_view",
  "apim:bl_manage",
  "apim:admin",
  "apim:admin_operations",
  "apim:admin_settings",
  "apim:keymanagers_manage",
  "apim:api_workflow_view",
  "apim:api_workflow_approve",
  "apim:policies_import_export",
  "apim:common_operation_policy_view",
  "apim:common_operation_policy_manage",
  "apim:mediation_policy_view",
  "apim:mediation_policy_manage",
  "apim:tenantInfo",
  "openid",
];

const PUBLISHER = "/api/am/publisher/v4";
const ADMIN = "/api/am/admin/v4";
const DEVPORTAL = "/api/am/devportal/v3";

export class Wso2Client {
  private readonly agent: Agent;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly opts: Wso2ClientOptions) {
    this.agent = createAgent(opts.tls);
  }

  private async authHeader(): Promise<string> {
    const auth = this.opts.auth;
    if (auth.type === "basic") {
      return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
    }
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return `Bearer ${this.token.value}`;
    // Registro dinámico de cliente (DCR) y luego password grant con los scopes de las REST API.
    const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    const dcr = await httpRequest<{ clientId: string; clientSecret: string }>(this.agent, {
      method: "POST",
      url: `${this.opts.baseUrl}/client-registration/v0.17/register`,
      headers: { authorization: `Basic ${basic}` },
      json: {
        callbackUrl: "https://localhost",
        clientName: "nexo_rest_api_client",
        owner: auth.username,
        grantType: "client_credentials password refresh_token",
        saasApp: true,
      },
    });
    const tok = await httpRequest<{ access_token: string; expires_in: number }>(this.agent, {
      method: "POST",
      url: `${this.opts.baseUrl}/oauth2/token`,
      headers: {
        authorization: `Basic ${Buffer.from(`${dcr.clientId}:${dcr.clientSecret}`).toString("base64")}`,
      },
      urlencoded: {
        grant_type: "password",
        username: auth.username,
        password: auth.password,
        scope: (auth.scopes ?? DEFAULT_SCOPES).join(" "),
      },
    });
    this.token = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    return `Bearer ${tok.access_token}`;
  }

  async request<T>(req: Omit<HttpRequest, "url"> & { path: string }): Promise<T> {
    const authorization = await this.authHeader();
    const { path, ...rest } = req;
    return httpRequest<T>(this.agent, {
      ...rest,
      url: `${this.opts.baseUrl}${path}`,
      headers: { authorization, ...(rest.headers ?? {}) },
    });
  }

  // ---------------------------------------------------------------- Publisher

  readonly publisher = {
    listApis: (query?: string, limit = 100, offset = 0): Promise<ApiList> =>
      this.request({
        method: "GET",
        path: `${PUBLISHER}/apis?limit=${limit}&offset=${offset}${query ? `&query=${encodeURIComponent(query)}` : ""}`,
      }),

    getApi: (apiId: string): Promise<ApiSummary & Record<string, unknown>> =>
      this.request({ method: "GET", path: `${PUBLISHER}/apis/${apiId}` }),

    createApi: (body: Record<string, unknown>): Promise<ApiSummary> =>
      this.request({ method: "POST", path: `${PUBLISHER}/apis`, json: body }),

    updateApi: (apiId: string, body: Record<string, unknown>): Promise<ApiSummary> =>
      this.request({ method: "PUT", path: `${PUBLISHER}/apis/${apiId}`, json: body }),

    deleteApi: (apiId: string): Promise<void> =>
      this.request({ method: "DELETE", path: `${PUBLISHER}/apis/${apiId}` }),

    /** Importa un contrato OpenAPI y crea la API con las propiedades indicadas. */
    importOpenApi: (definition: string, additionalProperties: Record<string, unknown>): Promise<ApiSummary> => {
      const form = new FormData();
      form.set("file", new Blob([definition], { type: "application/yaml" }), "openapi.yaml");
      form.set("additionalProperties", JSON.stringify(additionalProperties));
      return this.request({ method: "POST", path: `${PUBLISHER}/apis/import-openapi`, form });
    },

    importGraphQl: (schema: string, additionalProperties: Record<string, unknown>): Promise<ApiSummary> => {
      const form = new FormData();
      form.set("file", new Blob([schema], { type: "text/plain" }), "schema.graphql");
      form.set("type", "GraphQL");
      form.set("additionalProperties", JSON.stringify(additionalProperties));
      return this.request({ method: "POST", path: `${PUBLISHER}/apis/import-graphql-schema`, form });
    },

    importAsyncApi: (definition: string, additionalProperties: Record<string, unknown>): Promise<ApiSummary> => {
      const form = new FormData();
      form.set("file", new Blob([definition], { type: "application/yaml" }), "asyncapi.yaml");
      form.set("additionalProperties", JSON.stringify(additionalProperties));
      return this.request({ method: "POST", path: `${PUBLISHER}/apis/import-asyncapi`, form });
    },

    getDefinition: (apiId: string): Promise<string> =>
      this.request({ method: "GET", path: `${PUBLISHER}/apis/${apiId}/swagger` }).then((d) =>
        typeof d === "string" ? d : JSON.stringify(d),
      ),

    updateDefinition: (apiId: string, definition: string): Promise<unknown> => {
      const form = new FormData();
      form.set("apiDefinition", definition);
      return this.request({ method: "PUT", path: `${PUBLISHER}/apis/${apiId}/swagger`, form });
    },

    createRevision: (apiId: string, description: string): Promise<ApiRevision> =>
      this.request({ method: "POST", path: `${PUBLISHER}/apis/${apiId}/revisions`, json: { description } }),

    listRevisions: (apiId: string): Promise<{ count: number; list: ApiRevision[] }> =>
      this.request({ method: "GET", path: `${PUBLISHER}/apis/${apiId}/revisions` }),

    deployRevision: (apiId: string, revisionId: string, gateways: Array<{ name: string; vhost: string }>) =>
      this.request({
        method: "POST",
        path: `${PUBLISHER}/apis/${apiId}/deploy-revision?revisionId=${revisionId}`,
        json: gateways.map((g) => ({ name: g.name, vhost: g.vhost, displayOnDevportal: true })),
        accept: [201],
      }),

    undeployRevision: (apiId: string, revisionId: string, gateways: Array<{ name: string; vhost: string }>) =>
      this.request({
        method: "POST",
        path: `${PUBLISHER}/apis/${apiId}/undeploy-revision?revisionId=${revisionId}`,
        json: gateways.map((g) => ({ name: g.name, vhost: g.vhost, displayOnDevportal: true })),
        accept: [201],
      }),

    deleteRevision: (apiId: string, revisionId: string) =>
      this.request({ method: "DELETE", path: `${PUBLISHER}/apis/${apiId}/revisions/${revisionId}` }),

    restoreRevision: (apiId: string, revisionId: string) =>
      this.request({ method: "POST", path: `${PUBLISHER}/apis/${apiId}/restore-revision?revisionId=${revisionId}` }),

    changeLifecycle: (apiId: string, action: "Publish" | "Deploy as a Prototype" | "Demote to Created" | "Block" | "Deprecate" | "Re-Publish" | "Retire") =>
      this.request({
        method: "POST",
        path: `${PUBLISHER}/apis/change-lifecycle?apiId=${apiId}&action=${encodeURIComponent(action)}`,
      }),

    exportApi: (apiId: string): Promise<Buffer> =>
      this.request({ method: "GET", path: `${PUBLISHER}/apis/export?apiId=${apiId}&format=YAML`, binary: true }),

    importApi: (zip: Buffer, overwrite = true): Promise<unknown> => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "api.zip");
      return this.request({ method: "POST", path: `${PUBLISHER}/apis/import?overwrite=${overwrite}`, form });
    },

    listSubscriptions: (apiId: string): Promise<{ count: number; list: Subscription[] }> =>
      this.request({ method: "GET", path: `${PUBLISHER}/subscriptions?apiId=${apiId}&limit=500` }),

    settings: (): Promise<Record<string, unknown>> => this.request({ method: "GET", path: `${PUBLISHER}/settings` }),
  };

  // ---------------------------------------------------------------- Admin

  readonly admin = {
    listKeyManagers: (): Promise<{ count: number; list: KeyManager[] }> =>
      this.request({ method: "GET", path: `${ADMIN}/key-managers` }),

    createKeyManager: (body: Record<string, unknown>): Promise<KeyManager> =>
      this.request({ method: "POST", path: `${ADMIN}/key-managers`, json: body }),

    updateKeyManager: (id: string, body: Record<string, unknown>): Promise<KeyManager> =>
      this.request({ method: "PUT", path: `${ADMIN}/key-managers/${id}`, json: body }),

    listDenyPolicies: (): Promise<{ count: number; list: DenyPolicy[] }> =>
      this.request({ method: "GET", path: `${ADMIN}/throttling/deny-policies` }),

    /** Bloqueo (deny policy). Lo usa el Guardián de anomalías (D-02). */
    createDenyPolicy: (conditionType: DenyPolicyType, conditionValue: unknown): Promise<DenyPolicy> =>
      this.request({
        method: "POST",
        path: `${ADMIN}/throttling/deny-policies`,
        json: { conditionType, conditionValue, conditionStatus: true },
      }),

    deleteDenyPolicy: (conditionId: string): Promise<void> =>
      this.request({ method: "DELETE", path: `${ADMIN}/throttling/deny-policy/${conditionId}` }),

    listWorkflows: (workflowType?: string): Promise<WorkflowList> =>
      this.request({
        method: "GET",
        path: `${ADMIN}/workflows${workflowType ? `?workflowType=${encodeURIComponent(workflowType)}` : ""}`,
      }),

    resolveWorkflow: (referenceId: string, status: "APPROVED" | "REJECTED", description: string) =>
      this.request({
        method: "POST",
        path: `${ADMIN}/workflows/update-workflow-status?workflowReferenceId=${referenceId}`,
        json: { status, description, attributes: {} },
      }),

    getTenantConfig: (): Promise<Record<string, unknown>> =>
      this.request({ method: "GET", path: `${ADMIN}/tenant-config` }),

    putTenantConfig: (config: Record<string, unknown>): Promise<unknown> =>
      this.request({
        method: "PUT",
        path: `${ADMIN}/tenant-config`,
        headers: { "content-type": "application/json" },
        json: config,
      }),

    listEnvironments: (): Promise<{ count: number; list: Array<Record<string, unknown>> }> =>
      this.request({ method: "GET", path: `${ADMIN}/environments` }),

    createEnvironment: (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      this.request({ method: "POST", path: `${ADMIN}/environments`, json: body }),

    settings: (): Promise<Record<string, unknown>> => this.request({ method: "GET", path: `${ADMIN}/settings` }),
  };

  // ---------------------------------------------------------------- Dev Portal

  readonly devportal = {
    listApis: (limit = 100): Promise<ApiList> =>
      this.request({ method: "GET", path: `${DEVPORTAL}/apis?limit=${limit}` }),

    listApplications: (): Promise<{ count: number; list: Application[] }> =>
      this.request({ method: "GET", path: `${DEVPORTAL}/applications?limit=500` }),

    createApplication: (name: string, description: string, throttlingPolicy = "Unlimited"): Promise<Application> =>
      this.request({
        method: "POST",
        path: `${DEVPORTAL}/applications`,
        json: { name, description, throttlingPolicy, tokenType: "JWT", attributes: {} },
      }),

    deleteApplication: (applicationId: string): Promise<void> =>
      this.request({ method: "DELETE", path: `${DEVPORTAL}/applications/${applicationId}` }),

    generateKeys: (
      applicationId: string,
      keyManager: string,
      grantTypes: string[] = ["client_credentials"],
      keyType: "PRODUCTION" | "SANDBOX" = "PRODUCTION",
      /** Propiedades que exige el conector del Key Manager (por ejemplo, Keycloak pide subject_type). */
      additionalProperties: Record<string, unknown> = {},
    ): Promise<ApplicationKey> =>
      this.request({
        method: "POST",
        path: `${DEVPORTAL}/applications/${applicationId}/generate-keys`,
        json: {
          keyType,
          keyManager,
          grantTypesToBeSupported: grantTypes,
          callbackUrl: "",
          scopes: ["default"],
          validityTime: 3600,
          additionalProperties,
        },
      }),

    listKeys: (applicationId: string): Promise<{ count: number; list: ApplicationKey[] }> =>
      this.request({ method: "GET", path: `${DEVPORTAL}/applications/${applicationId}/oauth-keys` }),

    subscribe: (applicationId: string, apiId: string, throttlingPolicy = "Unlimited"): Promise<Subscription> =>
      this.request({
        method: "POST",
        path: `${DEVPORTAL}/subscriptions`,
        json: { applicationId, apiId, throttlingPolicy },
      }),

    listSubscriptions: (applicationId: string): Promise<{ count: number; list: Subscription[] }> =>
      this.request({ method: "GET", path: `${DEVPORTAL}/subscriptions?applicationId=${applicationId}&limit=500` }),

    sdkLanguages: (): Promise<string[]> => this.request({ method: "GET", path: `${DEVPORTAL}/sdk-gen/languages` }),

    generateSdk: (apiId: string, language: string): Promise<Buffer> =>
      this.request({ method: "GET", path: `${DEVPORTAL}/apis/${apiId}/sdks/${language}`, binary: true }),
  };
}
