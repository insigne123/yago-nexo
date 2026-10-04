/** Verificación de BT-020: cada audiencia recibe solo las APIs aprobadas para ella (gateways separados). */
import { Agent, fetch } from "undici";
import { Wso2Client } from "@nexo/wso2-client";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const wso2 = new Wso2Client({
  baseUrl: "https://apim:9443",
  auth: { type: "basic", username: "admin", password: process.env.APIM_ADMIN_PASSWORD ?? "admin" },
  tls: { rejectUnauthorized: false },
});

async function main() {
  const app = (await wso2.devportal.listApplications()).list.find((a) => a.name === "OperadorDemo")!;
  const api = (await wso2.publisher.listApis(`name:"ConsultaPublica"`)).list.find((a) => a.name === "ConsultaPublica");
  if (!api) throw new Error("falta ConsultaPublica");
  const subs = (await wso2.devportal.listSubscriptions(app.applicationId)).list;
  if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
    await wso2.devportal.subscribe(app.applicationId, api.id, "Unlimited");
    for (const w of (await wso2.admin.listWorkflows("AM_SUBSCRIPTION_CREATION")).list)
      await wso2.admin.resolveWorkflow(w.referenceId, "APPROVED", "Aprobado (verificación de audiencias)");
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
  const cases = [
    { gateway: "público (gw-publico)", url: "https://publico.nexo.lab:18243/publico/concesiones/1.0.0/concesiones/CON-000001", esperado: 200 },
    { gateway: "público (gw-publico)", url: "https://publico.nexo.lab:18243/concesiones/1.0.0/concesiones", esperado: 404 },
    { gateway: "interno/operadores", url: "https://apim:8243/concesiones/1.0.0/concesiones", esperado: 200 },
    { gateway: "interno/operadores", url: "https://apim:8243/publico/concesiones/1.0.0/concesiones/CON-000001", esperado: 404 },
  ];
  let ok = true;
  for (let attempt = 0; attempt < 6; attempt++) {
    ok = true;
    const rows = [];
    for (const c of cases) {
      const res = await fetch(c.url, { dispatcher: insecure, headers: { authorization: `Bearer ${access_token}` } });
      await res.text();
      rows.push({ ...c, obtenido: res.status, cumple: res.status === c.esperado });
      if (res.status !== c.esperado) ok = false;
    }
    if (ok || attempt === 5) {
      console.table(rows.map((r) => ({ gateway: r.gateway, url: r.url.replace(/^https:\/\//, ""), esperado: r.esperado, obtenido: r.obtenido, cumple: r.cumple })));
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(ok ? "[BT-020] verificado: cada audiencia recibe solo sus APIs" : "[BT-020] NO cumple");
  if (!ok) process.exit(1);
}
main().catch((e) => {
  console.error("[BT-020] ERROR", e instanceof Error ? e.message : e);
  process.exit(1);
});
