/**
 * D-06 · Soporte nativo de GraphQL y de arquitectura dirigida por eventos con contratos AsyncAPI, además de
 * REST y SOAP. En el Dev Portal de WSO2 conviven las APIs REST, GraphQL y de eventos; la API GraphQL responde
 * a través del gateway y la API de eventos (contrato AsyncAPI) entrega eventos por WebSocket, ambas con token
 * OAuth de Keycloak. Cierra con la verificación check-d06.
 */
import WebSocket from "ws";
import type { Demo } from "../lib/grabador.js";
import { credencialesDe, GATEWAY, gateway, tokenAplicacion, wso2 } from "../lib/lab.js";
import { nexoCtl, verificacionLab } from "./comun.js";

export const d06: Demo = {
  id: "D-06",
  archivo: "D-06_graphql_asyncapi",
  nombre: "GraphQL y APIs de eventos con contratos AsyncAPI",
  afirmacion:
    "La plataforma publica y protege APIs GraphQL y APIs dirigidas por eventos descritas con AsyncAPI (WebSocket), en el mismo gateway, portal y control de acceso que las APIs REST y SOAP.",
  pasos: 4,

  async preparar(c) {
    await c.ingresarWso2("devportal");
    return ["sesión abierta en el Dev Portal de WSO2 (usuario admin del laboratorio)"];
  },

  async ejecutar(c) {
    const w = wso2();
    const apis = (await w.devportal.listApis()).list;
    const gql = apis.find((a) => a.name === "ConcesionesGraphQL");
    const ev = apis.find((a) => a.name === "EventosRed");
    if (!gql || !ev) throw new Error("faltan las APIs ConcesionesGraphQL o EventosRed");
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));

    c.paso("En el Dev Portal conviven APIs REST, GraphQL y de eventos (WebSocket)");
    await c.vista("app");
    await c.ir("https://apim:9443/devportal/apis");
    await c.app.getByText("ConcesionesGraphQL").first().waitFor();
    await c.esperar(4500);
    await c.vista("dividido");
    for (const a of apis) c.log(`${a.name.padEnd(22)} ${String((a as { type?: string }).type ?? "").padEnd(8)} ${(a as { context?: string }).context ?? ""}`);

    c.paso("API GraphQL: esquema publicado y consulta a través del gateway con token OAuth");
    await c.ir(`https://apim:9443/devportal/apis/${gql.id}/overview`);
    await c.esperar(2500);
    const consulta = "{ totalPorEstado { estado total } concesiones(region: \"Los Lagos\", limite: 2) { id empresa servicio estado } }";
    c.log(`$ POST ${GATEWAY}/graphql/concesiones/1.0.0`, "cmd");
    c.log(`  ${consulta}`, "tenue");
    const t0 = Date.now();
    let r = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", token, cuerpo: { query: consulta } });
    for (let i = 0; i < 5 && r.status !== 200; i++) {
      await c.esperar(2000);
      r = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", token, cuerpo: { query: consulta } });
    }
    const ms = Date.now() - t0;
    c.log(`HTTP ${r.status} en ${ms} ms`, r.status === 200 ? "ok" : "mal");
    for (const l of JSON.stringify(r.data, null, 1).split("\n").slice(0, 18)) c.log(l);
    const datos = (r.data as { data?: { totalPorEstado?: unknown[]; concesiones?: unknown[] } }).data;
    c.verificar("consulta GraphQL respondida por el gateway", r.status === 200 && !!datos?.totalPorEstado?.length, `${datos?.totalPorEstado?.length ?? 0} estados · ${datos?.concesiones?.length ?? 0} concesiones`);
    const sinToken = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", cuerpo: { query: consulta } });
    c.verificar("sin token el gateway la rechaza", sinToken.status === 401, `HTTP ${sinToken.status}`);

    c.paso("API de eventos con contrato AsyncAPI: el consumidor recibe eventos por WebSocket");
    await c.vista("app");
    await c.ir(`https://apim:9443/devportal/apis/${ev.id}/definition`);
    await c.app.getByText("Operations").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    await c.esperar(3000);
    await c.app.mouse.move(700, 400);
    await c.app.mouse.wheel(0, 380);
    await c.esperar(3000);
    await c.vista("dividido");
    await nexoCtl(c, ["api", "lint", "../../wso2/apim/apis/eventos-red/asyncapi.yaml", "-r", "../../wso2/apim/governance/guia-asyncapi.yaml"], "nexo-ctl api lint wso2/apim/apis/eventos-red/asyncapi.yaml -r guia-asyncapi.yaml");
    c.log("$ wscat -c wss://apim:8099/eventos/red/1.0.0/ws -H 'Authorization: Bearer …'", "cmd");
    const eventos: unknown[] = [];
    await new Promise<void>((ok, mal) => {
      const sock = new WebSocket("wss://apim:8099/eventos/red/1.0.0/ws", { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false });
      const limite = setTimeout(() => {
        sock.close();
        ok();
      }, 20_000);
      sock.on("open", () => c.log("conectado: suscripción abierta a través del gateway", "ok"));
      sock.on("message", (d) => {
        const e = JSON.parse(String(d)) as Record<string, unknown>;
        eventos.push(e);
        c.log(`evento ${eventos.length}: ${JSON.stringify(e).slice(0, 170)}`);
        if (eventos.length >= 3) {
          clearTimeout(limite);
          sock.close();
          ok();
        }
      });
      sock.on("unexpected-response", (_q, res) => mal(new Error(`WebSocket rechazado: ${res.statusCode}`)));
      sock.on("error", mal);
    });
    c.verificar("eventos recibidos por WebSocket con token OAuth", eventos.length >= 2, `${eventos.length} eventos`);

    c.paso("Verificación automática (check-d06)");
    const v = await verificacionLab(c, "check-d06", "check:d06");
    c.verificar("check-d06: GraphQL y eventos AsyncAPI a través del gateway", v.ok);
    await c.esperar(2500);

    return {
      medido: `consulta GraphQL respondida por el gateway en ${ms} ms y ${eventos.length} eventos AsyncAPI recibidos por WebSocket, ambos con token OAuth`,
      datos: { msGraphQL: ms, eventos: eventos.length },
    };
  },
};
