import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { FormData, Wso2HttpError, type Wso2Client } from "@nexo/wso2-client";
import { clientFor, type CtlConfig, type StageConfig } from "../config.js";
import { RegistryClient, WORKFLOW_EXTENSIONS_PATH } from "../registry.js";

interface PlatformSpec {
  gatewayEnvironments: Array<{ name: string; displayName: string; description: string; vhost: string }>;
  throttling: {
    subscription: Array<{ name: string; description: string; requestsPerMinute: number; burstPerSecond: number }>;
    application: Array<{ name: string; description: string; requestsPerMinute: number }>;
    advanced: Array<{ name: string; description: string; requestsPerMinute: number }>;
  };
  workflows: { file: string };
  governance: {
    rulesets: Array<{ name: string; file: string; ruleType: string; artifactType: string; description: string }>;
    policies: Array<{ name: string; description: string; rulesets: string[]; block: string[]; notify: string[] }>;
  };
}

const log = (msg: string) => console.log(`  ${msg}`);

async function ignoreConflict<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Wso2HttpError && (e.status === 409 || /already exist/i.test(e.body))) {
      log(`${what}: ya existe`);
      return undefined;
    }
    throw e;
  }
}

async function applyEnvironments(wso2: Wso2Client, spec: PlatformSpec): Promise<void> {
  const existing = await wso2.admin.listEnvironments();
  const names = new Set(existing.list.map((e) => String(e.name)));
  for (const env of spec.gatewayEnvironments) {
    if (names.has(env.name)) {
      log(`ambiente ${env.name}: ya existe`);
      continue;
    }
    await wso2.admin.createEnvironment({
      name: env.name,
      displayName: env.displayName,
      description: env.description,
      provider: "wso2",
      gatewayType: "Regular",
      type: "hybrid",
      vhosts: [
        {
          host: env.vhost,
          httpContext: "",
          httpPort: 8280,
          httpsPort: 8243,
          wsPort: 9099,
          wssPort: 8099,
        },
      ],
      additionalProperties: [],
      permissions: { permissionType: "PUBLIC", roles: [] },
    });
    log(`ambiente ${env.name} (${env.vhost}): creado`);
  }
}

const perMinute = (n: number) => ({
  type: "REQUESTCOUNTLIMIT",
  requestCount: { timeUnit: "min", unitTime: 1, requestCount: n },
});

async function applyThrottling(wso2: Wso2Client, spec: PlatformSpec): Promise<void> {
  for (const p of spec.throttling.subscription) {
    await ignoreConflict(
      () =>
        wso2.request({
          method: "POST",
          path: "/api/am/admin/v4/throttling/policies/subscription",
          json: {
            policyName: p.name,
            displayName: p.name,
            description: p.description,
            defaultLimit: perMinute(p.requestsPerMinute),
            rateLimitCount: p.burstPerSecond,
            rateLimitTimeUnit: "sec",
            billingPlan: "FREE",
            stopOnQuotaReach: true,
            customAttributes: [],
            graphQLMaxComplexity: 0,
            graphQLMaxDepth: 0,
          },
        }),
      `plan de suscripción ${p.name}`,
    ).then((r) => r && log(`plan de suscripción ${p.name}: creado`));
  }
  for (const p of spec.throttling.application) {
    await ignoreConflict(
      () =>
        wso2.request({
          method: "POST",
          path: "/api/am/admin/v4/throttling/policies/application",
          json: { policyName: p.name, displayName: p.name, description: p.description, defaultLimit: perMinute(p.requestsPerMinute) },
        }),
      `política de aplicación ${p.name}`,
    ).then((r) => r && log(`política de aplicación ${p.name}: creada`));
  }
  for (const p of spec.throttling.advanced) {
    await ignoreConflict(
      () =>
        wso2.request({
          method: "POST",
          path: "/api/am/admin/v4/throttling/policies/advanced",
          json: {
            policyName: p.name,
            displayName: p.name,
            description: p.description,
            defaultLimit: perMinute(p.requestsPerMinute),
            conditionalGroups: [],
          },
        }),
      `política de API ${p.name}`,
    ).then((r) => r && log(`política de API ${p.name}: creada`));
  }
}

async function applyWorkflows(s: StageConfig, baseDir: string, spec: PlatformSpec): Promise<void> {
  const password = process.env[s.passwordEnv] ?? "";
  const registry = new RegistryClient(s.apim, s.user, password, s.insecureTls);
  const desired = readFileSync(join(baseDir, spec.workflows.file), "utf8");
  const current = await registry.getText(WORKFLOW_EXTENSIONS_PATH);
  if (current.replace(/\s+/g, "") === desired.replace(/\s+/g, "")) {
    log("flujos de aprobación: sin cambios");
    return;
  }
  await registry.putText(WORKFLOW_EXTENSIONS_PATH, desired);
  log("flujos de aprobación: actualizados (registro, aplicación, credenciales y suscripción requieren aprobación)");
}

const GOV = "/api/am/governance/v1";

async function applyGovernance(wso2: Wso2Client, baseDir: string, spec: PlatformSpec): Promise<void> {
  const rulesets = await wso2.request<{ list: Array<{ id: string; name: string }> }>({ method: "GET", path: `${GOV}/rulesets?limit=100` });
  const byName = new Map(rulesets.list.map((r) => [r.name, r.id]));
  for (const r of spec.governance.rulesets) {
    const content = readFileSync(join(baseDir, r.file), "utf8");
    const existingId = byName.get(r.name);
    const form = new FormData();
    form.set("name", r.name);
    form.set("description", r.description);
    form.set("ruleCategory", "SPECTRAL");
    form.set("ruleType", r.ruleType);
    form.set("artifactType", r.artifactType);
    form.set("provider", "Yago Nexo");
    form.set("documentationLink", "https://yago-nexo.web.app/docs/seguridad");
    form.set("rulesetContent", new Blob([content], { type: "application/x-yaml" }), "ruleset.yaml");
    if (existingId) {
      await wso2.request({ method: "PUT", path: `${GOV}/rulesets/${existingId}`, form });
      log(`ruleset '${r.name}': actualizado`);
    } else {
      const created = await wso2.request<{ id: string }>({ method: "POST", path: `${GOV}/rulesets`, form });
      byName.set(r.name, created.id);
      log(`ruleset '${r.name}': creado`);
    }
  }
  const policies = await wso2.request<{ list: Array<{ id: string; name: string }> }>({ method: "GET", path: `${GOV}/policies?limit=100` });
  for (const p of spec.governance.policies) {
    const ids = p.rulesets.map((n) => {
      const id = byName.get(n);
      if (!id) throw new Error(`ruleset desconocido en la política '${p.name}': ${n}`);
      return id;
    });
    const states = [...new Set([...p.block, ...p.notify])];
    const actions = states.flatMap((state) =>
      (["ERROR", "WARN", "INFO"] as const).map((sev) => ({
        state,
        ruleSeverity: sev,
        type: p.block.includes(state) && sev === "ERROR" ? "BLOCK" : "NOTIFY",
      })),
    );
    const body = { name: p.name, description: p.description, governableStates: states, actions, rulesets: ids, labels: ["GLOBAL"] };
    const existing = policies.list.find((x) => x.name === p.name);
    if (existing) {
      await wso2.request({ method: "PUT", path: `${GOV}/policies/${existing.id}`, json: body });
      log(`política de gobierno '${p.name}': actualizada`);
    } else {
      await wso2.request({ method: "POST", path: `${GOV}/policies`, json: body });
      log(`política de gobierno '${p.name}': creada (bloquea ${p.block.join(", ")})`);
    }
  }
}

export async function platformApply(cfg: CtlConfig, s: StageConfig, specPath: string): Promise<void> {
  const spec = parse(readFileSync(specPath, "utf8")) as PlatformSpec;
  const baseDir = join(specPath, "..");
  const wso2 = clientFor(s);
  console.log("Ambientes de gateway (etapas y audiencias):");
  await applyEnvironments(wso2, spec);
  console.log("Políticas de tráfico:");
  await applyThrottling(wso2, spec);
  console.log("Flujos de aprobación:");
  await applyWorkflows(s, baseDir, spec);
  console.log("Gobierno de contratos:");
  await applyGovernance(wso2, baseDir, spec);
  void cfg;
}
