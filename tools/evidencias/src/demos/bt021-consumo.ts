/**
 * Medición de consumo atribuida al consumidor y al endpoint, con límites y sin cobros reales. Dos aplicaciones
 * consumidoras llaman por el gateway a distintos endpoints; la Consola muestra el consumo atribuido (a partir de
 * la analítica del gateway en OpenSearch), se compara con lo que se envió, se exporta en CSV y se comprueba que
 * el plan limita el exceso. La facturación de WSO2 está apagada y los planes no tienen cobro.
 */
import { readFileSync } from "node:fs";
import { Agent, fetch } from "undici";
import type { Demo } from "../lib/grabador.js";
import { consola, credencialesDe, GATEWAY, tokenAplicacion, tokenPersona, wso2 } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";

const SEGUNDO = "FiscalizacionDemo";
const LISTA = `${GATEWAY}/concesiones/1.0.0/concesiones?estado=vigente`;
const DETALLE = `${GATEWAY}/concesiones/1.0.0/concesiones/CON-000002`;
type Fila = { key: string; label: string; llamadas: number; errores: number };
const inseguro = new Agent({ connect: { rejectUnauthorized: false }, connections: 64 });

/** Segunda aplicación consumidora, aprovisionada por el Dev Portal con sus aprobaciones (idempotente). */
async function asegurarSegundoConsumidor(): Promise<string[]> {
  const w = wso2();
  const notas: string[] = [];
  let app = (await w.devportal.listApplications()).list.find((a) => a.name === SEGUNDO);
  const aprobar = async (tipo: string) => {
    for (const p of (await w.admin.listWorkflows(tipo)).list) await w.admin.resolveWorkflow(p.referenceId, "APPROVED", "Aprobado para la demostración de consumo");
  };
  if (!app) {
    app = await w.devportal.createApplication(SEGUNDO, "Sistema de fiscalización de un organismo externo (sintético)");
    await aprobar("AM_APPLICATION_CREATION");
    notas.push(`aplicación ${SEGUNDO} creada y aprobada`);
  }
  const llave = (await w.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION");
  if (!llave?.consumerKey) {
    await w.devportal.generateKeys(app.applicationId, "Keycloak", ["client_credentials"], "PRODUCTION", { subject_type: "public", token_endpoint_auth_method: "client_secret_basic", tls_client_certificate_bound_access_tokens: "false" });
    await aprobar("AM_APPLICATION_REGISTRATION_PRODUCTION");
    notas.push(`credenciales de ${SEGUNDO} emitidas en Keycloak`);
  }
  const api = (await w.devportal.listApis()).list.find((a) => a.name === "Concesiones")!;
  const subs = (await w.devportal.listSubscriptions(app.applicationId)).list;
  if (!subs.some((s) => s.apiId === api.id || s.apiInfo?.id === api.id)) {
    await w.devportal.subscribe(app.applicationId, api.id, "OperadoresEstandar");
    await aprobar("AM_SUBSCRIPTION_CREATION");
    notas.push(`${SEGUNDO} suscrita a Concesiones con el plan OperadoresEstandar`);
  }
  if (!notas.length) notas.push(`segunda aplicación consumidora ${SEGUNDO} ya aprovisionada (plan OperadoresEstandar)`);
  return notas;
}

async function enviar(url: string, token: string, n: number, porSegundo = 8): Promise<Record<string, number>> {
  const codigos: Record<string, number> = {};
  for (let i = 0; i < n; i += porSegundo) {
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: Math.min(porSegundo, n - i) }, async () => {
        const r = await fetch(url, { dispatcher: inseguro, headers: { authorization: `Bearer ${token}` } });
        await r.arrayBuffer();
        codigos[r.status] = (codigos[r.status] ?? 0) + 1;
      }),
    );
    const resto = 1000 - (Date.now() - t0);
    if (resto > 0) await new Promise((r) => setTimeout(r, resto));
  }
  return codigos;
}

export const bt021: Demo = {
  id: "BT-021",
  archivo: "BT-021_consumo",
  nombre: "Medición de consumo por consumidor y endpoint, sin cobro",
  afirmacion:
    "Cada llamada que pasa por el gateway se atribuye a su aplicación consumidora, a la API y al endpoint; la Consola lo muestra y exporta, los planes limitan el exceso y la facturación permanece desactivada.",
  pasos: 5,
  usuarioInicial: "luis.aprobador",

  async preparar() {
    const notas = await asegurarSegundoConsumidor();
    // El catálogo de la Consola conoce a los consumidores por su nombre después de sincronizar con WSO2.
    await consola(await tokenPersona("ana.desarrollo"), "POST", "/catalog/sync");
    return [...notas, "catálogo de la Consola sincronizado con WSO2 (consumidores con su nombre)"];
  },

  async ejecutar(c) {
    const apr = await tokenPersona("luis.aprobador");
    const w = wso2();
    const operador = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const fiscal = await tokenAplicacion(await credencialesDe(SEGUNDO));
    const hoy = new Date().toISOString().slice(0, 10);
    const leer = async (groupBy: string) => (await consola<Fila[]>(apr, "GET", `/usage?from=${hoy}&to=${hoy}&groupBy=${groupBy}`)).data;

    c.paso("Medición sin facturación: la monetización está apagada y los planes no tienen cobro");
    await c.ir("/consumo");
    await c.app.getByTestId("billing-disabled-notice").waitFor();
    const planes = await w.request<{ list: Array<{ policyName: string; billingPlan?: string; defaultLimit?: { requestCount?: { requestCount?: number; timeUnit?: string } } }> }>({ method: "GET", path: "/api/am/admin/v4/throttling/policies/subscription" });
    c.log("$ GET /api/am/admin/v4/throttling/policies/subscription", "cmd");
    for (const p of planes.list.filter((x) => /Operadores|Interno|Publico|Unlimited/.test(x.policyName))) {
      c.log(`  plan ${p.policyName.padEnd(20)} cobro ${p.billingPlan ?? "—"} · límite ${p.defaultLimit?.requestCount?.requestCount ?? "—"} por ${p.defaultLimit?.requestCount?.timeUnit ?? "—"}`);
    }
    c.verificar("todos los planes sin cobro (FREE)", planes.list.every((p) => (p.billingPlan ?? "FREE") === "FREE"), `${planes.list.length} planes`);
    await c.esperar(2500);

    c.paso("Dos aplicaciones consumidoras llaman a distintos endpoints por el gateway");
    const antesC = await leer("consumer");
    const antesE = await leer("endpoint");
    const plan = [
      { quien: "OperadorDemo", token: operador, url: LISTA, n: 40, endpoint: "/concesiones" },
      { quien: "OperadorDemo", token: operador, url: DETALLE, n: 16, endpoint: "/concesiones/{id}" },
      { quien: SEGUNDO, token: fiscal, url: DETALLE, n: 24, endpoint: "/concesiones/{id}" },
    ];
    for (const p of plan) {
      const r = await enviar(p.url, p.token, p.n);
      c.log(`${p.quien.padEnd(18)} GET ${p.endpoint.padEnd(18)} ${p.n} llamadas → ${Object.entries(r).map(([k, v]) => `${k}×${v}`).join(" ")}`, r["200"] === p.n ? "ok" : "mal");
    }
    const esperado: Record<string, number> = { OperadorDemo: 56, [SEGUNDO]: 24 };

    c.paso("La Consola atribuye el consumo a cada consumidor, API y endpoint");
    const delta = (antes: Fila[], ahora: Fila[], etiqueta: string) => (ahora.find((x) => x.label === etiqueta || x.key === etiqueta)?.llamadas ?? 0) - (antes.find((x) => x.label === etiqueta || x.key === etiqueta)?.llamadas ?? 0);
    const listo = await esperarHasta(async () => leer("consumer"), (f) => delta(antesC, f, "OperadorDemo") >= 56 && delta(antesC, f, SEGUNDO) >= 24, 60, 2000);
    const ahoraE = await leer("endpoint");
    await c.app.reload();
    await c.app.getByTestId("billing-disabled-notice").waitFor();
    await c.vista("app");
    await c.esperar(2500);
    await c.app.mouse.move(700, 400);
    await c.app.mouse.wheel(0, 520);
    await c.esperar(3500);
    await c.app.mouse.wheel(0, -520);
    await c.app.getByTestId("usage-group-by").selectOption("endpoint");
    await c.esperar(1500);
    await c.app.mouse.wheel(0, 520);
    await c.esperar(3500);
    await c.app.mouse.wheel(0, -520);
    await c.vista("dividido");
    for (const [quien, n] of Object.entries(esperado)) {
      const d = listo ? delta(antesC, listo.valor, quien) : 0;
      c.verificar(`${quien}: llamadas atribuidas = enviadas`, d === n, `${d} de ${n}`);
    }
    const dLista = delta(antesE, ahoraE, "/concesiones");
    const dDetalle = delta(antesE, ahoraE, "/concesiones/{id}");
    c.verificar("endpoint /concesiones atribuido", dLista === 40, `${dLista} de 40`);
    c.verificar("endpoint /concesiones/{id} atribuido", dDetalle === 40, `${dDetalle} de 40`);
    if (listo) c.log(`consumo ingresado en la analítica en ${listo.seg.toFixed(0)} s`, "tenue");
    c.log("Nota: en modo passthrough WSO2 informa tamaño 0 para casi todas las respuestas; el indicador «Datos transferidos» no es representativo en el laboratorio.", "tenue");

    c.paso("Exportación del consumo en CSV");
    const ruta = await c.descargar(c.app.getByTestId("btn-export-usage"), "consumo.csv");
    const csv = readFileSync(ruta, "utf8").trim().split("\n");
    for (const l of csv.slice(0, 8)) c.log(`  ${l}`);
    c.verificar("CSV con consumidores y endpoints", csv.some((l) => l.includes(SEGUNDO)) && csv.some((l) => l.includes("/concesiones/{id}")), `${csv.length - 1} filas`);

    c.paso("Límite del plan: FiscalizacionDemo supera las 20 llamadas por segundo de su plan y recibe 429");
    const exceso = await enviar(DETALLE, fiscal, 45, 45);
    c.log(`45 llamadas en el mismo segundo → ${Object.entries(exceso).map(([k, v]) => `${k}×${v}`).join("  ")}`, exceso["429"] ? "ok" : "mal");
    c.verificar("el plan limita el exceso (429), sin cobro", (exceso["429"] ?? 0) > 0, `${exceso["429"] ?? 0} limitadas`);
    await c.esperar(2500);

    return {
      medido: `80 llamadas atribuidas sin diferencias a 2 consumidores y 2 endpoints, exportadas en CSV; el plan limitó ${exceso["429"] ?? 0} de 45 llamadas en exceso; facturación desactivada`,
      datos: { esperado, endpoints: { "/concesiones": dLista, "/concesiones/{id}": dDetalle }, exceso },
    };
  },
};
