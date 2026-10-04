/**
 * Verificación del flujo de integración a través del gateway (BT-008/009/010/033/051):
 * consumidor → gateway (OAuth Keycloak) → Micro Integrator (validación, SOAP, transformación, cola) → destino,
 * con idempotencia y traza de extremo a extremo en Jaeger.
 */
import { randomUUID } from "node:crypto";
import { Agent, fetch } from "undici";
import { Wso2Client } from "@nexo/wso2-client";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const wso2 = new Wso2Client({
  baseUrl: "https://apim:9443",
  auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
  tls: { rejectUnauthorized: false },
});
const log = (m: string, x?: unknown) => console.log(`[integración] ${m}${x !== undefined ? ` ${JSON.stringify(x)}` : ""}`);

async function main() {
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo");
  const api = (await wso2.devportal.listApis()).list.find((a) => a.name === "SolicitudesConcesion");
  if (!app || !api) throw new Error("falta OperadorDemo o la API SolicitudesConcesion");
  const subs = (await wso2.devportal.listSubscriptions(app.applicationId)).list;
  if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
    await wso2.devportal.subscribe(app.applicationId, api.id, "Unlimited");
    for (const w of (await wso2.admin.listWorkflows("AM_SUBSCRIPTION_CREATION")).list)
      await wso2.admin.resolveWorkflow(w.referenceId, "APPROVED", "Aprobado (verificación de integración)");
    log("suscripción creada y aprobada");
  }
  const key = (await wso2.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak");
  const tok = await fetch("http://keycloak:8080/realms/nexo/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${key?.consumerKey}:${key?.consumerSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  const { access_token } = (await tok.json()) as { access_token: string };
  const idem = `verif-${randomUUID()}`;
  const traceId = randomUUID().replace(/-/g, "");
  const call = () =>
    fetch("https://apim:8243/solicitudes/1.0.0/", {
      method: "POST",
      dispatcher: insecure,
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        "idempotency-key": idem,
        traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01`,
      },
      body: JSON.stringify({ rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" }),
    });
  let first = await call();
  for (let i = 0; i < 8 && first.status === 404; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    first = await call();
  }
  log(`primera llamada: ${first.status}`, await first.json());
  const second = await call();
  log(`repetición con la misma Idempotency-Key: ${second.status}`, await second.json());
  const invalid = await fetch("https://apim:8243/solicitudes/1.0.0/", {
    method: "POST",
    dispatcher: insecure,
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", "idempotency-key": `${idem}-x` },
    body: JSON.stringify({ rutEmpresa: "1", servicio: "X" }),
  });
  log(`solicitud inválida: ${invalid.status}`, await invalid.json());

  await new Promise((r) => setTimeout(r, 8000));
  const services = (await (await fetch("http://localhost:16686/api/v3/services")).json()) as { services: string[] };
  log("servicios con trazas en Jaeger", services.services);
  const traceRes = await fetch(`http://localhost:16686/api/v3/traces/${traceId}`);
  if (traceRes.ok) {
    const t = (await traceRes.json()) as { result?: { resourceSpans?: Array<{ resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans?: Array<{ spans?: unknown[] }> }> } };
    const rs = t.result?.resourceSpans ?? [];
    const byService = rs.map((r) => ({
      servicio: r.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue,
      spans: (r.scopeSpans ?? []).reduce((n, s) => n + (s.spans?.length ?? 0), 0),
    }));
    log(`traza ${traceId}`, byService);
  } else {
    log(`traza ${traceId} no encontrada (${traceRes.status})`);
  }
}

main().catch((e) => {
  console.error("[integración] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
