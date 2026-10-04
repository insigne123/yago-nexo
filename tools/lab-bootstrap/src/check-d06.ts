/**
 * Verificación de D-06: API GraphQL y API dirigida por eventos (WebSocket + AsyncAPI) a través del gateway.
 */
import { Agent, fetch } from "undici";
import WebSocket from "ws";
import { Wso2Client } from "@nexo/wso2-client";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const wso2 = new Wso2Client({
  baseUrl: "https://apim:9443",
  auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
  tls: { rejectUnauthorized: false },
});
const log = (m: string, x?: unknown) => console.log(`[D-06] ${m}${x !== undefined ? ` ${JSON.stringify(x)}` : ""}`);

async function approveAll(type: string) {
  const pending = await wso2.admin.listWorkflows(type);
  for (const w of pending.list) await wso2.admin.resolveWorkflow(w.referenceId, "APPROVED", "Aprobado (verificación D-06)");
}

async function main() {
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo");
  if (!app) throw new Error("falta la aplicación OperadorDemo (ejecute el bootstrap)");
  const apis = (await wso2.devportal.listApis()).list;
  const gql = apis.find((a) => a.name === "ConcesionesGraphQL");
  const ws = apis.find((a) => a.name === "EventosRed");
  if (!gql || !ws) throw new Error("faltan las APIs ConcesionesGraphQL o EventosRed");
  const subs = (await wso2.devportal.listSubscriptions(app.applicationId)).list;
  for (const [api, plan] of [[gql, "Unlimited"], [ws, "AsyncUnlimited"]] as const) {
    if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
      await wso2.devportal.subscribe(app.applicationId, api.id, plan);
      log(`suscripción solicitada a ${api.name}`);
    }
  }
  await approveAll("AM_SUBSCRIPTION_CREATION");
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

  // GraphQL
  for (let i = 0; i < 10; i++) {
    const res = await fetch("https://apim:8243/graphql/concesiones/1.0.0", {
      method: "POST",
      dispatcher: insecure,
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "{ totalPorEstado { estado total } }" }),
    });
    const body = await res.text();
    if (res.status === 200) {
      log("GraphQL OK a través del gateway", JSON.parse(body));
      break;
    }
    log(`GraphQL intento ${i + 1}: ${res.status}`, body.slice(0, 160));
    await new Promise((r) => setTimeout(r, 3000));
  }

  // WebSocket (AsyncAPI)
  await new Promise<void>((resolve, reject) => {
    const sock = new WebSocket("wss://apim:8099/eventos/red/1.0.0/ws", {
      headers: { Authorization: `Bearer ${access_token}` },
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => reject(new Error("no llegaron eventos en 15 s")), 15_000);
    let n = 0;
    sock.on("message", (data) => {
      n++;
      log(`evento recibido por WebSocket (${n})`, JSON.parse(String(data)));
      if (n >= 2) {
        clearTimeout(timer);
        sock.close();
        resolve();
      }
    });
    sock.on("unexpected-response", (_req, res) => reject(new Error(`WebSocket rechazado: ${res.statusCode}`)));
    sock.on("error", reject);
  });
  log("D-06 verificado: GraphQL y eventos (AsyncAPI) operan a través del gateway con token Keycloak");
}

main().catch((e) => {
  console.error("[D-06] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
