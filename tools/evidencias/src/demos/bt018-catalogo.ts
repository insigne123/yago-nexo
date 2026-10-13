/**
 * BT-018 · Catálogo de APIs con propósito, propietario, contrato, versión, autenticación, consumidores,
 * dependencias y estado, consistente con el entorno de ejecución. La Consola sincroniza el catálogo con WSO2,
 * muestra la ficha de la API Concesiones y su grafo de dependencias, y cada campo comprometido se compara con
 * lo que informa WSO2 (Publisher y suscripciones).
 *
 * Pantalla: al volver de la vista «app» a la dividida se fuerza un cuadro nuevo (cambiarVista), así la ficha no
 * queda a 2/3 del ancho con una franja vacía; el Publisher se carga fuera de pantalla y se muestra ya cargado.
 *
 * Duración estimada: portada 4 s + 4 pasos (≈ 16 + 24 + 14 + 22 s) + cierre 3 s ≈ 85 s (tope 240 s).
 */
import type { Page } from "playwright-core";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { consola, tokenPersona, wso2 } from "../lib/lab.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";
import { cambiarVista, esperarCarga, mostrarLista, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 85;

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

export const NARRACION_BT018: DefinicionPaso[] = [
  {
    titulo: "El catálogo se sincroniza con WSO2",
    quePasa:
      "Se sincroniza el catálogo: la Consola lee de WSO2, donde corren las APIs, cada API con sus consumidores y suscripciones.",
    porQueImporta:
      "El catálogo no es una planilla aparte: se alimenta del entorno de ejecución, así que refleja lo que de verdad está publicado.",
    comprueba: ["catálogo sincronizado con WSO2"],
  },
  {
    titulo: "La ficha de una API: dueño, contrato, versión y estado",
    quePasa:
      "Se abre la ficha de Concesiones: propósito, equipo dueño y contacto, contrato, versión, autenticación, consumidores, dependencias y estado.",
    porQueImporta:
      "Cada API tiene un responsable y un contrato conocidos: quien la usa o la cambia sabe a quién acudir y qué se comprometió.",
    comprueba: ["ficha completa: los campos comprometidos tienen valor"],
  },
  {
    titulo: "Grafo de dependencias de la API",
    quePasa: "El grafo muestra quién consume la API y de qué flujos y sistemas de destino depende.",
    porQueImporta: "Antes de cambiar o retirar una API se ve a quién afecta.",
    comprueba: ["la API aparece en el grafo de dependencias"],
  },
  {
    titulo: "Consistencia con el entorno de ejecución",
    quePasa:
      "Se abre la API en el Publisher de WSO2 y cada campo de la ficha se compara con lo que informa WSO2, incluidas las suscripciones.",
    porQueImporta:
      "Lo que dice el catálogo coincide con lo que corre en el gateway: no hay fichas desactualizadas.",
    comprueba: [
      "nombre, versión, contexto y estado coinciden con WSO2",
      "propietario, contacto, contrato y propósito coinciden con WSO2",
      "la autenticación de la ficha figura en WSO2",
      "consumidores coinciden con las suscripciones activas",
    ],
  },
];

let publisher: Page | undefined;

export const bt018: Demo = {
  id: "BT-018",
  archivo: "BT-018_catalogo",
  nombre: "Catálogo de APIs con dueño, contrato, versión y dependencias",
  afirmacion:
    "El catálogo de la Consola reúne, para cada API, su propósito, propietario, contrato, versión, autenticación, consumidores, dependencias y estado, sincronizado con WSO2 y consistente con lo que corre en el gateway.",
  pasos: NARRACION_BT018.length,
  agenda: NARRACION_BT018.map((p) => p.titulo),
  usuarioInicial: "ana.desarrollo",

  async preparar(c) {
    await prepararEnsayo(c);
    publisher = await c.nuevaSesion();
    await c.ingresarWso2("publisher", "admin", undefined, publisher);
    return ["sesión abierta en el Publisher de WSO2 para comparar con el entorno de ejecución"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const dev = await tokenPersona("ana.desarrollo");
    const w = wso2();

    // 1 ── Sincronización ────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT018[0]!);
    await c.vista("dividido");
    await c.ir("/catalogo");
    await c.app.getByTestId("table-apis").waitFor();
    const respuestaSync = c.app
      .waitForResponse((r) => r.url().includes("/catalog/sync") && r.request().method() === "POST", {
        timeout: 60_000,
      })
      .catch(() => undefined);
    await e.clic(c.app.getByTestId("btn-sync-wso2"));
    const rs = await respuestaSync;
    type Sync = { apis: number; consumers: number; subscriptions: number; durationMs: number };
    let sync = (rs?.status() === 200 ? await rs.json().catch(() => undefined) : undefined) as
      Sync | undefined;
    let estadoSync = rs?.status();
    if (!sync) {
      // Si no se alcanzó a leer la respuesta del botón, la misma sincronización por la API de la Consola.
      const r = await consola<Sync>(dev, "POST", "/catalog/sync");
      sync = r.status === 200 ? r.data : undefined;
      estadoSync = r.status;
    }
    if (sync)
      c.log(
        `→ POST /api/v1/catalog/sync → ${estadoSync}: ${sync.apis} APIs · ${sync.consumers} consumidores · ${sync.subscriptions} suscripciones en ${sync.durationMs} ms`,
        "cmd",
      );
    const lista = (await consola<Ficha[]>(dev, "GET", "/apis")).data;
    for (const a of lista)
      c.log(
        `${a.name.padEnd(22)} ${a.version}  ${a.type.padEnd(8)} ${a.state.padEnd(10)} completitud ${a.completeness} %`,
      );
    e.indicadores({
      "APIs en el catálogo": lista.length,
      ...(sync ? { suscripciones: sync.subscriptions } : {}),
    });
    e.exige(
      "catálogo sincronizado con WSO2",
      estadoSync === 200 && !!sync && lista.length >= 5,
      `${lista.length} APIs · ${sync?.durationMs ?? "?"} ms`,
    );

    // 2 ── Ficha ─────────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT018[1]!);
    const ficha0 = lista.find((a) => a.name === "Concesiones")!;
    await e.clic(c.app.getByRole("link", { name: "Concesiones", exact: true }).first());
    await c.app.getByTestId("api-summary").waitFor();
    await cambiarVista(c, "app");
    await e.zoom(c.app.getByTestId("api-summary"), { factor: 1.4, ms: 2500 });
    await e.desplazar(380);
    await e.clic(c.app.getByTestId("tab-consumidores"));
    await e.esperar(1500);
    await e.clic(c.app.getByTestId("tab-dependencias"));
    await e.esperar(1500);
    await cambiarVista(c, "dividido");
    const ficha = (await consola<Ficha>(dev, "GET", `/apis/${encodeURIComponent(ficha0.id)}`)).data;
    const campos: Array<[string, unknown]> = [
      ["propósito", ficha.purpose],
      [
        "propietario",
        ficha.ownerTeam && ficha.ownerContact ? `${ficha.ownerTeam} <${ficha.ownerContact}>` : undefined,
      ],
      ["contrato", ficha.contractRef],
      ["versión", ficha.version],
      ["autenticación", ficha.authType],
      ["consumidores", (ficha.consumers ?? []).map((x) => `${x.name} (${x.plan ?? "—"})`).join(", ")],
      ["dependencias", (ficha.dependencies ?? []).map((d) => `${d.relation} ${d.to}`).join(", ")],
      ["estado", ficha.state],
    ];
    for (const [k, v] of campos) c.log(`${k.padEnd(14)} ${String(v ?? "—").slice(0, 120)}`);
    e.comprueba(
      "ficha completa: los campos comprometidos tienen valor",
      campos.every(([, v]) => v !== undefined && v !== "") && ficha.completeness === 100,
      `completitud ${ficha.completeness} %`,
    );

    // 3 ── Grafo ─────────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT018[2]!);
    await cambiarVista(c, "app");
    await c.ir("/dependencias");
    await c.app.getByTestId("graph-canvas").waitFor();
    const nodo = c.app.getByTestId(`graph-node-${ficha.id}`);
    await nodo.waitFor({ timeout: 20_000 }).catch(() => undefined);
    const hayNodo = await nodo.isVisible().catch(() => false);
    if (hayNodo) {
      await e.clic(nodo);
      await e.zoom(nodo, { factor: 1.6, ms: 2500 });
    }
    e.comprueba(
      "la API aparece en el grafo de dependencias",
      hayNodo,
      `${(ficha.dependencies ?? []).length} dependencias · ${(ficha.consumers ?? []).length} consumidores`,
    );
    await e.esperar(1500);

    // 4 ── Consistencia con WSO2 ─────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT018[3]!);
    if (publisher) {
      // El Publisher se carga fuera de pantalla (sin «Loading API data…» en el video) y se muestra ya listo.
      await publisher.goto(`https://apim:9443/publisher/apis/${ficha.wso2ApiId}/overview`);
      const cargado = await esperarCarga(publisher, publisher.getByText(/PUBLISHED|Published|Publicad/), {
        ms: e.ensayo ? 3000 : 30_000,
      });
      if (!cargado) c.avisar("el Publisher no mostró el estado de la API a tiempo");
      await cambiarVista(c, "dividido");
      await mostrarLista(c, publisher);
      await verPagina(c);
    }
    const enWso2 = (await w.publisher.getApi(ficha.wso2ApiId)) as unknown as ApiWso2;
    const prop = (n: string) => enWso2.additionalProperties?.find((p) => p.name === n)?.value;
    const subs = await w.request<{
      list: Array<{ applicationInfo?: { name?: string }; subscriptionStatus?: string }>;
    }>({
      method: "GET",
      path: `/api/am/publisher/v4/subscriptions?apiId=${ficha.wso2ApiId}&limit=100`,
    });
    const activas = subs.list.filter((s) => (s.subscriptionStatus ?? "UNBLOCKED") === "UNBLOCKED");
    c.log(
      `→ GET /api/am/publisher/v4/apis/${ficha.wso2ApiId.slice(0, 8)}… y /subscriptions   # lo que informa WSO2`,
      "cmd",
    );
    const pares: Array<[string, unknown, unknown]> = [
      ["nombre y versión", `${ficha.name} ${ficha.version}`, `${enWso2.name} ${enWso2.version}`],
      ["contexto", ficha.context, enWso2.context],
      ["estado", ficha.state, enWso2.lifeCycleStatus],
      ["propietario", ficha.ownerTeam, enWso2.businessInformation?.businessOwner],
      ["contacto", ficha.ownerContact, enWso2.businessInformation?.businessOwnerEmail],
      ["contrato", ficha.contractRef, prop("contrato")],
      ["propósito", ficha.purpose, prop("proposito")],
    ];
    for (const [k, a, b] of pares)
      c.log(
        `  ${String(a) === String(b) ? "=" : "≠"} ${k.padEnd(16)} catálogo «${String(a).slice(0, 44)}» · WSO2 «${String(b).slice(0, 44)}»`,
        String(a) === String(b) ? "ok" : "mal",
      );
    const iguales = (desde: number, hasta: number) =>
      pares.slice(desde, hasta).every(([, a, b]) => String(a) === String(b));
    e.comprueba(
      "nombre, versión, contexto y estado coinciden con WSO2",
      iguales(0, 3),
      `${enWso2.name} ${enWso2.version} · ${enWso2.context} · ${enWso2.lifeCycleStatus}`,
    );
    e.comprueba(
      "propietario, contacto, contrato y propósito coinciden con WSO2",
      iguales(3, 7),
      `${String(enWso2.businessInformation?.businessOwner ?? "—").slice(0, 40)}`,
    );
    const esquemas = enWso2.securityScheme ?? [];
    const autenticacion = esquemas.includes(String(ficha.authType));
    c.log(
      `  ${autenticacion ? "∈" : "∉"} autenticación     catálogo «${String(ficha.authType)}» · WSO2 securityScheme «${esquemas.join(", ")}»`,
      autenticacion ? "ok" : "mal",
    );
    if (esquemas.includes("oauth_basic_auth_api_key_mandatory"))
      c.log(
        "    oauth_basic_auth_api_key_mandatory no es otro método: es la marca de WSO2 que hace obligatoria la seguridad de aplicación (OAuth, básica o clave de API)",
        "tenue",
      );
    // Mismas aplicaciones (por nombre) en la ficha y en las suscripciones activas de WSO2, no solo la misma cantidad.
    const nombresFicha = (ficha.consumers ?? []).map((x) => x.name).sort();
    const nombresWso2 = activas.map((s) => s.applicationInfo?.name ?? "").sort();
    const consumidores = nombresFicha.join("\n") === nombresWso2.join("\n");
    c.log(
      `  ${consumidores ? "=" : "≠"} consumidores     catálogo «${nombresFicha.join(", ")}» · WSO2 «${nombresWso2.join(", ")}»`,
      consumidores ? "ok" : "mal",
    );
    e.comprueba(
      "la autenticación de la ficha figura en WSO2",
      autenticacion,
      `«${String(ficha.authType)}» en WSO2`,
    );
    e.comprueba(
      "consumidores coinciden con las suscripciones activas",
      consumidores,
      consumidores
        ? `${activas.length} aplicaciones, mismos nombres`
        : `ficha ${nombresFicha.length} · WSO2 ${nombresWso2.length}`,
    );
    const igualesTotal =
      pares.filter(([, a, b]) => String(a) === String(b)).length +
      (autenticacion ? 1 : 0) +
      (consumidores ? 1 : 0);
    e.indicadores({ "campos comparados": pares.length + 2, "iguales a WSO2": igualesTotal });
    await e.esperar(2000);

    return {
      medido: `ficha de Concesiones completa al ${ficha.completeness} %; ${igualesTotal} de ${pares.length + 2} campos de la ficha coinciden con lo que informa WSO2 (nombre y versión, contexto, estado, propietario, contacto, contrato, propósito, autenticación y consumidores)`,
      datos: { apis: lista.length, completitud: ficha.completeness, campos: pares.length + 2 },
    };
  },

  async limpiar() {
    publisher = undefined;
  },
};
