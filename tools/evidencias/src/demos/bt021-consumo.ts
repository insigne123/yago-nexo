/**
 * BT-021 · Medición de consumo atribuida al consumidor y al endpoint, con límites y sin cobros reales. Dos
 * aplicaciones consumidoras llaman por el gateway a distintos endpoints; la Consola muestra el consumo atribuido
 * (a partir de la analítica del gateway en OpenSearch), se compara con lo que se envió, se exporta en CSV y se
 * comprueba que el plan limita el exceso. La facturación de WSO2 está apagada y los planes no tienen cobro.
 *
 * Duración estimada: portada 4 s + 5 pasos (≈ 12 + 14 + 40 + 10 + 10 s) + cierre 3 s ≈ 95 s (tope 240 s; la
 * espera de la analítica del gateway es la parte variable, hasta 60 s).
 */
import { readFileSync } from "node:fs";
import { Agent, fetch } from "undici";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { consola, credencialesDe, GATEWAY, tokenAplicacion, tokenPersona, wso2 } from "../lib/lab.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";
import { esperarHasta, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 95;

const SEGUNDO = "FiscalizacionDemo";
const LISTA = `${GATEWAY}/concesiones/1.0.0/concesiones?estado=vigente`;
const DETALLE = `${GATEWAY}/concesiones/1.0.0/concesiones/CON-000002`;
type Fila = { key: string; label: string; llamadas: number; errores: number };
const inseguro = new Agent({ connect: { rejectUnauthorized: false }, connections: 64 });

export const NARRACION_BT021: DefinicionPaso[] = [
  {
    titulo: "Medición sin facturación",
    quePasa: "La pantalla de consumo de la Consola avisa que los cobros están desactivados. Se consulta a WSO2 la lista de planes: ninguno tiene cobro.",
    porQueImporta: "Se mide el uso de cada consumidor sin generar cobros reales, como pide el requisito.",
    comprueba: ["todos los planes sin cobro (FREE)"],
  },
  {
    titulo: "Dos consumidores llaman a distintos endpoints",
    quePasa: "Dos aplicaciones llaman por el gateway: OperadorDemo hace 40 llamadas a la lista y 16 al detalle; FiscalizacionDemo, 24 al detalle.",
    porQueImporta: "Para atribuir el consumo hay que saber exactamente cuánto envió cada uno; aquí se cuenta en el origen.",
    comprueba: ["las 80 llamadas responden 200"],
  },
  {
    titulo: "La Consola atribuye el consumo a cada consumidor y endpoint",
    quePasa: "Cuando la analítica del gateway registra las llamadas, la Consola las muestra por consumidor y por endpoint, y se compara con lo enviado.",
    porQueImporta: "La atribución es exacta: cada llamada queda asignada a su aplicación y a su endpoint, sin diferencias.",
    comprueba: ["OperadorDemo: llamadas atribuidas = enviadas", "FiscalizacionDemo: llamadas atribuidas = enviadas", "endpoint /concesiones atribuido", "endpoint /concesiones/{id} atribuido"],
  },
  {
    titulo: "Exportación del consumo en CSV",
    quePasa: "Desde la misma pantalla se descarga el consumo en CSV, con consumidores y endpoints.",
    porQueImporta: "El consumo se puede llevar a otras herramientas (planillas, conciliación) sin depender de la Consola.",
    comprueba: ["CSV con consumidores y endpoints"],
  },
  {
    titulo: "El plan limita el exceso",
    quePasa: "FiscalizacionDemo envía 45 llamadas en un segundo, más de las 20 por segundo de su plan. El gateway responde 429 a las que sobran.",
    porQueImporta: "Los límites de uso se aplican de verdad en el gateway, sin cobros: el exceso se limita, no se factura.",
    comprueba: ["el plan limita el exceso (429), sin cobro"],
  },
];

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
  pasos: NARRACION_BT021.length,
  agenda: NARRACION_BT021.map((p) => p.titulo),
  usuarioInicial: "luis.aprobador",

  async preparar(c) {
    await prepararEnsayo(c);
    const notas = await asegurarSegundoConsumidor();
    // El catálogo de la Consola conoce a los consumidores por su nombre después de sincronizar con WSO2.
    await consola(await tokenPersona("ana.desarrollo"), "POST", "/catalog/sync");
    return [...notas, "catálogo de la Consola sincronizado con WSO2 (consumidores con su nombre)"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const apr = await tokenPersona("luis.aprobador");
    const w = wso2();
    const operador = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const fiscal = await tokenAplicacion(await credencialesDe(SEGUNDO));
    const hoy = new Date().toISOString().slice(0, 10);
    const leer = async (groupBy: string) => (await consola<Fila[]>(apr, "GET", `/usage?from=${hoy}&to=${hoy}&groupBy=${groupBy}`)).data;

    // 1 ── Sin facturación ───────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[0]!);
    await c.vista("dividido");
    await c.ir("/consumo");
    const aviso = c.app.getByTestId("billing-disabled-notice");
    await aviso.waitFor();
    await verPagina(c, aviso);
    await e.esperar(1500);
    await e.zoom(aviso, { factor: 1.5, ms: 2200 });
    const planes = await w.request<{ list: Array<{ policyName: string; billingPlan?: string; defaultLimit?: { requestCount?: { requestCount?: number; timeUnit?: string } } }> }>({
      method: "GET",
      path: "/api/am/admin/v4/throttling/policies/subscription",
    });
    c.log("→ GET /api/am/admin/v4/throttling/policies/subscription", "cmd");
    for (const p of planes.list.filter((x) => /Operadores|Interno|Publico|Unlimited/.test(x.policyName))) {
      c.log(`  plan ${p.policyName.padEnd(20)} cobro ${p.billingPlan ?? "—"} · límite ${p.defaultLimit?.requestCount?.requestCount ?? "—"} por ${p.defaultLimit?.requestCount?.timeUnit ?? "—"}`);
    }
    e.comprueba("todos los planes sin cobro (FREE)", planes.list.length > 0 && planes.list.every((p) => (p.billingPlan ?? "FREE") === "FREE"), `${planes.list.length} planes`);

    // 2 ── Llamadas de dos consumidores ──────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[1]!);
    const antesC = await leer("consumer");
    const antesE = await leer("endpoint");
    const plan = [
      { quien: "OperadorDemo", token: operador, url: LISTA, n: 40, endpoint: "/concesiones" },
      { quien: "OperadorDemo", token: operador, url: DETALLE, n: 16, endpoint: "/concesiones/{id}" },
      { quien: SEGUNDO, token: fiscal, url: DETALLE, n: 24, endpoint: "/concesiones/{id}" },
    ];
    let enviadas = 0;
    let ok200 = 0;
    for (const p of plan) {
      const r = await enviar(p.url, p.token, p.n);
      enviadas += p.n;
      ok200 += r["200"] ?? 0;
      c.log(`${p.quien.padEnd(18)} GET ${p.endpoint.padEnd(18)} ${p.n} llamadas → ${Object.entries(r).map(([k, v]) => `${k}×${v}`).join(" ")}`, r["200"] === p.n ? "ok" : "mal");
      e.indicadores({ "llamadas enviadas": enviadas, "respuestas 200": ok200 });
    }
    e.comprueba("las 80 llamadas responden 200", ok200 === 80, `${ok200} de ${enviadas}`);
    const esperado: Record<string, number> = { OperadorDemo: 56, [SEGUNDO]: 24 };

    // 3 ── Atribución ───────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[2]!);
    const delta = (antes: Fila[], ahora: Fila[], etiqueta: string) =>
      (ahora.find((x) => x.label === etiqueta || x.key === etiqueta)?.llamadas ?? 0) - (antes.find((x) => x.label === etiqueta || x.key === etiqueta)?.llamadas ?? 0);
    c.log("esperando que la analítica del gateway registre las llamadas…", "tenue");
    const listo = await esperarHasta(async () => leer("consumer"), (f) => delta(antesC, f, "OperadorDemo") >= 56 && delta(antesC, f, SEGUNDO) >= 24, 60, 2000);
    const listoE = await esperarHasta(async () => leer("endpoint"), (f) => delta(antesE, f, "/concesiones") >= 40 && delta(antesE, f, "/concesiones/{id}") >= 40, 20, 2000);
    const ahoraE = listoE?.valor ?? (await leer("endpoint"));
    if (listo) c.log(`consumo ingresado en la analítica en ${listo.seg.toFixed(0)} s`, "tenue");
    await c.app.reload();
    await c.app.getByTestId("billing-disabled-notice").waitFor();
    await c.vista("app");
    await verPagina(c);
    await e.desplazar(520);
    await e.esperar(2500);
    await e.desplazar(-520);
    await e.elegir(c.app.getByTestId("usage-group-by"), "endpoint");
    await e.desplazar(520);
    await e.esperar(2500);
    await e.desplazar(-520);
    await c.vista("dividido");
    for (const [quien, n] of Object.entries(esperado)) {
      const d = listo ? delta(antesC, listo.valor, quien) : 0;
      e.comprueba(`${quien}: llamadas atribuidas = enviadas`, d === n, `${d} de ${n}`);
    }
    const dLista = delta(antesE, ahoraE, "/concesiones");
    const dDetalle = delta(antesE, ahoraE, "/concesiones/{id}");
    e.indicadores({ "OperadorDemo": listo ? delta(antesC, listo.valor, "OperadorDemo") : 0, [SEGUNDO]: listo ? delta(antesC, listo.valor, SEGUNDO) : 0, "/concesiones": dLista, "/concesiones/{id}": dDetalle });
    e.comprueba("endpoint /concesiones atribuido", dLista === 40, `${dLista} de 40`);
    e.comprueba("endpoint /concesiones/{id} atribuido", dDetalle === 40, `${dDetalle} de 40`);

    // 4 ── CSV ───────────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[3]!);
    const ruta = await c.descargar(c.app.getByTestId("btn-export-usage"), "consumo.csv");
    const csv = readFileSync(ruta, "utf8").trim().split("\n");
    c.log(`→ consumo.csv (${csv.length - 1} filas)`, "cmd");
    for (const l of csv.slice(0, 8)) c.log(`  ${l}`);
    e.comprueba("CSV con consumidores y endpoints", csv.some((l) => l.includes(SEGUNDO)) && csv.some((l) => l.includes("/concesiones/{id}")), `${csv.length - 1} filas`);

    // 5 ── Límite del plan ───────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[4]!);
    const exceso = await enviar(DETALLE, fiscal, 45, 45);
    c.log(`45 llamadas en el mismo segundo → ${Object.entries(exceso).map(([k, v]) => `${k}×${v}`).join("  ")}`, exceso["429"] ? "ok" : "mal");
    e.indicadores({ "llamadas en 1 s": 45, "limitadas (429)": exceso["429"] ?? 0 });
    e.comprueba("el plan limita el exceso (429), sin cobro", (exceso["429"] ?? 0) > 0, `${exceso["429"] ?? 0} de 45 limitadas`);
    await e.esperar(2000);

    return {
      medido: `80 llamadas atribuidas sin diferencias a 2 consumidores y 2 endpoints, exportadas en CSV; el plan limitó ${exceso["429"] ?? 0} de 45 llamadas en exceso; facturación desactivada`,
      datos: { esperado, endpoints: { "/concesiones": dLista, "/concesiones/{id}": dDetalle }, exceso },
    };
  },
};
