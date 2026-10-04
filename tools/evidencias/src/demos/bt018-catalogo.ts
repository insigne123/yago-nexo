/**
 * Catálogo de APIs con propósito, propietario, contrato, versión, autenticación, consumidores, dependencias y
 * estado, consistente con el entorno de ejecución. La Consola sincroniza el catálogo con WSO2, muestra la
 * ficha de la API Concesiones y su grafo de dependencias, y cada campo comprometido se compara con lo que
 * informa WSO2 (Publisher y suscripciones).
 */
import type { Page } from "playwright-core";
import type { Demo } from "../lib/grabador.js";
import { consola, tokenPersona, wso2 } from "../lib/lab.js";

type Ficha = {
  id: string;
  wso2ApiId: string;
  name: string;
  version: string;
  context: string;
  type: string;
  purpose?: string;
  ownerTeam?: string;
  ownerContact?: string;
  audience: string;
  state: string;
  authType?: string;
  contractRef?: string;
  classification?: string;
  consumersCount?: number;
  dependenciesCount?: number;
  completeness: number;
  consumers?: Array<{ name: string; plan?: string }>;
  dependencies?: Array<{ from: string; to: string; relation: string }>;
  missingFields?: string[];
};
type ApiWso2 = {
  name: string;
  version: string;
  context: string;
  lifeCycleStatus: string;
  securityScheme?: string[];
  businessInformation?: { businessOwner?: string; businessOwnerEmail?: string };
  additionalProperties?: Array<{ name: string; value: string }>;
};

let publisher: Page | undefined;

export const bt018: Demo = {
  id: "BT-018",
  archivo: "BT-018_catalogo",
  nombre: "Catálogo de APIs con dueño, contrato, versión y dependencias",
  afirmacion:
    "El catálogo de la Consola reúne, para cada API, su propósito, propietario, contrato, versión, autenticación, consumidores, dependencias y estado, sincronizado con WSO2 y consistente con lo que corre en el gateway.",
  pasos: 4,
  usuarioInicial: "ana.desarrollo",

  async preparar(c) {
    publisher = await c.nuevaSesion();
    await c.ingresarWso2("publisher", "admin", undefined, publisher);
    return ["sesión abierta en el Publisher de WSO2 para comparar con el entorno de ejecución"];
  },

  async ejecutar(c) {
    const dev = await tokenPersona("ana.desarrollo");
    const w = wso2();

    c.paso("El catálogo se sincroniza con WSO2, el entorno de ejecución");
    await c.vista("app");
    await c.ir("/catalogo");
    await c.app.getByTestId("table-apis").waitFor();
    await c.esperar(1500);
    await c.clic(c.app.getByTestId("btn-sync-wso2"));
    await c.esperar(3500);
    await c.vista("dividido");
    const sync = await consola<{ apis: number; consumers: number; subscriptions: number; durationMs: number }>(dev, "POST", "/catalog/sync");
    c.log(`$ POST /api/v1/catalog/sync → ${sync.status}: ${sync.data.apis} APIs · ${sync.data.consumers} consumidores · ${sync.data.subscriptions} suscripciones en ${sync.data.durationMs} ms`, "cmd");
    const lista = (await consola<Ficha[]>(dev, "GET", "/apis")).data;
    for (const a of lista) c.log(`${a.name.padEnd(22)} ${a.version}  ${a.type.padEnd(8)} ${a.state.padEnd(10)} completitud ${a.completeness} %`);
    c.exigir("catálogo sincronizado", sync.status === 200 && lista.length >= 5, `${lista.length} APIs`);

    c.paso("Ficha de Concesiones: propósito, dueño, contrato, versión, autenticación, consumidores y estado");
    const ficha0 = lista.find((a) => a.name === "Concesiones")!;
    await c.clic(c.app.getByRole("link", { name: "Concesiones", exact: true }).first());
    await c.app.getByTestId("api-summary").waitFor();
    await c.vista("app");
    await c.esperar(3500);
    await c.app.mouse.move(700, 420);
    await c.app.mouse.wheel(0, 380);
    await c.esperar(3000);
    await c.clic(c.app.getByTestId("tab-consumidores"));
    await c.esperar(2500);
    await c.clic(c.app.getByTestId("tab-dependencias"));
    await c.esperar(2500);
    await c.vista("dividido");
    const ficha = (await consola<Ficha>(dev, "GET", `/apis/${encodeURIComponent(ficha0.id)}`)).data;
    const campos: Array<[string, unknown]> = [
      ["propósito", ficha.purpose],
      ["propietario", `${ficha.ownerTeam} <${ficha.ownerContact}>`],
      ["contrato", ficha.contractRef],
      ["versión", ficha.version],
      ["autenticación", ficha.authType],
      ["consumidores", (ficha.consumers ?? []).map((x) => `${x.name} (${x.plan ?? "—"})`).join(", ")],
      ["dependencias", (ficha.dependencies ?? []).map((d) => `${d.relation} ${d.to}`).join(", ")],
      ["estado", ficha.state],
    ];
    for (const [k, v] of campos) c.log(`${k.padEnd(14)} ${String(v ?? "—").slice(0, 120)}`);
    c.verificar("ficha completa: los campos comprometidos tienen valor", campos.every(([, v]) => v !== undefined && v !== "" && v !== "undefined <undefined>") && ficha.completeness === 100, `completitud ${ficha.completeness} %`);

    c.paso("Grafo de dependencias: consumidores, flujos y sistemas de destino");
    await c.vista("app");
    await c.ir("/dependencias");
    await c.app.getByTestId("graph-canvas").waitFor();
    await c.esperar(1500);
    const nodo = c.app.getByTestId(`graph-node-${ficha.id}`);
    if (await nodo.isVisible().catch(() => false)) await c.clic(nodo);
    await c.esperar(4500);
    await c.vista("dividido");

    c.paso("Consistencia con el entorno de ejecución: cada campo se compara con WSO2");
    if (publisher) {
      await c.mostrar(publisher);
      await publisher.goto(`https://apim:9443/publisher/apis/${ficha.wso2ApiId}/overview`);
      await c.esperar(4000);
    }
    const enWso2 = await w.publisher.getApi(ficha.wso2ApiId) as unknown as ApiWso2;
    const prop = (n: string) => enWso2.additionalProperties?.find((p) => p.name === n)?.value;
    const subs = await w.request<{ list: Array<{ applicationInfo?: { name?: string }; subscriptionStatus?: string }> }>({ method: "GET", path: `/api/am/publisher/v4/subscriptions?apiId=${ficha.wso2ApiId}&limit=100` });
    const activas = subs.list.filter((s) => (s.subscriptionStatus ?? "UNBLOCKED") === "UNBLOCKED");
    const comparar = (campo: string, catalogo: unknown, wso: unknown) => c.verificar(`${campo} coincide con WSO2`, String(catalogo) === String(wso), `${String(catalogo).slice(0, 50)}`);
    comparar("nombre y versión", `${ficha.name} ${ficha.version}`, `${enWso2.name} ${enWso2.version}`);
    comparar("contexto", ficha.context, enWso2.context);
    comparar("estado", ficha.state, enWso2.lifeCycleStatus);
    comparar("propietario", ficha.ownerTeam, enWso2.businessInformation?.businessOwner);
    comparar("contacto", ficha.ownerContact, enWso2.businessInformation?.businessOwnerEmail);
    comparar("contrato", ficha.contractRef, prop("contrato"));
    comparar("propósito", ficha.purpose, prop("proposito"));
    c.verificar("autenticación coincide con WSO2", (enWso2.securityScheme ?? []).includes(String(ficha.authType)), (enWso2.securityScheme ?? []).join(", "));
    c.verificar("consumidores coinciden con las suscripciones activas", (ficha.consumers ?? []).length === activas.length, `${activas.length} suscripción(es): ${activas.map((s) => s.applicationInfo?.name).join(", ")}`);
    await c.esperar(2000);

    return {
      medido: `ficha de Concesiones completa al ${ficha.completeness} % y ${c.verificaciones.filter((v) => v.texto.includes("WSO2") || v.texto.includes("suscripciones")).length} campos idénticos a lo que informa WSO2`,
      datos: { apis: lista.length, completitud: ficha.completeness },
    };
  },

  async limpiar() {
    publisher = undefined;
  },
};
