/**
 * D-06 · GraphQL nativo y APIs dirigidas por eventos con contratos AsyncAPI (respuesta N°90 del foro).
 *
 * Lo que se ve, todo contra el laboratorio:
 *   1. el portal de desarrolladores publica, junto a las REST, una API GraphQL y una API de eventos;
 *   2. GraphQL nativo: la API es de tipo GRAPHQL, está publicada y su esquema (SDL) es el que guarda WSO2;
 *   3. políticas sobre GraphQL en el gateway: planes y OAuth2 de la API, consulta con token (200), sin token
 *      (401) y una consulta fuera del esquema, rechazada;
 *   4. AsyncAPI: el contrato publicado de la API de eventos con sus canales, validado con la guía de estilo;
 *   5. eventos en vivo por WebSocket con token OAuth (sin token no se abre la suscripción) y la verificación
 *      automática check-d06.
 *
 * Duración estimada: portada 4 s + 5 pasos (≈ 14 + 16 + 18 + 18 + 32 s) + cierre 3 s ≈ 105 s (tope 240 s).
 */
import { strFromU8, unzipSync } from "fflate";
import WebSocket from "ws";
import { parse as leerYaml } from "yaml";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { escaparHtml } from "../lib/grabador.js";
import { credencialesDe, GATEWAY, gateway, tokenAplicacion, wso2 } from "../lib/lab.js";
import { prepararEnsayo, urlEventos } from "./bt0x-ensayo.js";
import { nexoCtl, verificacionLab, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 105;

export const NARRACION_D06: DefinicionPaso[] = [
  {
    titulo: "Un mismo portal para APIs REST, GraphQL y de eventos",
    quePasa: "El portal de desarrolladores lista las APIs publicadas: junto a las REST están ConcesionesGraphQL y EventosRed (eventos por WebSocket).",
    porQueImporta: "Quien integra un sistema encuentra en un solo lugar los distintos estilos de API, con el mismo registro y las mismas credenciales.",
    comprueba: ["el portal publica una API GraphQL", "el portal publica una API de eventos (WebSocket)"],
  },
  {
    titulo: "GraphQL nativo: tipo, publicación y esquema",
    quePasa: "Se consulta a WSO2 la ficha de la API GraphQL: tipo, estado de publicación y consultas. Abajo, el esquema GraphQL que WSO2 tiene publicado.",
    porQueImporta: "La API no es un REST disfrazado: WSO2 la gestiona como GraphQL, con su propio esquema, y lo usa para validar cada consulta.",
    comprueba: ["la API es de tipo GRAPHQL y está publicada", "el esquema publicado define las consultas"],
  },
  {
    titulo: "Políticas sobre GraphQL en el gateway",
    quePasa: "Una consulta GraphQL va al gateway con un token de Keycloak; luego la misma sin token y otra que pide un campo que no existe en el esquema.",
    porQueImporta: "Las políticas de la plataforma (planes de uso, OAuth2 y validación contra el esquema) protegen GraphQL igual que a las demás APIs.",
    comprueba: ["planes de uso y OAuth2 aplicados a la API", "consulta con token: respondida por el gateway", "sin token: rechazada", "campo fuera del esquema: rechazado"],
  },
  {
    titulo: "AsyncAPI: el contrato de la API de eventos",
    quePasa: "El portal muestra el contrato AsyncAPI de EventosRed y sus canales. La herramienta del producto lo valida contra la guía de estilo AsyncAPI.",
    porQueImporta: "Los eventos también tienen contrato: quien se suscribe sabe qué canales y mensajes recibirá, según las reglas de la institución.",
    comprueba: ["el contrato AsyncAPI publicado describe sus canales", "el contrato cumple la guía de estilo AsyncAPI"],
  },
  {
    titulo: "Eventos en vivo por WebSocket con token OAuth",
    quePasa: "Un consumidor se suscribe por WebSocket con su token y recibe eventos a través del gateway; sin token no se abre.",
    porQueImporta: "La arquitectura dirigida por eventos pasa por el mismo gateway y el mismo control de acceso que las APIs REST y GraphQL.",
    comprueba: ["con token: llegan eventos por WebSocket", "sin token: no se abre la suscripción", "verificación automática check-d06"],
  },
];

const CONSULTA = '{ totalPorEstado { estado total } concesiones(region: "Los Lagos", limite: 2) { id empresa servicio estado } }';
const FUERA_DE_ESQUEMA = "{ concesiones(limite: 1) { id campoInexistente } }";

type ApiPublisher = {
  type?: string;
  lifeCycleStatus?: string;
  policies?: string[];
  securityScheme?: string[];
  operations?: Array<{ target?: string; verb?: string; throttlingPolicy?: string }>;
};

/** Esquema GraphQL publicado: Publisher (graphql-schema) y, si no responde, el Dev Portal. */
async function esquemaPublicado(apiId: string): Promise<{ sdl: string; origen: string } | undefined> {
  const w = wso2();
  for (const [origen, ruta] of [
    ["Publisher", `/api/am/publisher/v4/apis/${apiId}/graphql-schema`],
    ["Dev Portal", `/api/am/devportal/v3/apis/${apiId}/graphql-schema`],
  ] as const) {
    try {
      const r = await w.request<unknown>({ method: "GET", path: ruta });
      const sdl = typeof r === "string" ? r : String((r as { schemaDefinition?: string })?.schemaDefinition ?? "");
      if (/type\s+Query/.test(sdl)) return { sdl, origen: `${origen} · GET …/graphql-schema` };
    } catch {
      /* se prueba el siguiente */
    }
  }
  // Último recurso: el proyecto de la API que exporta el Publisher (el mismo que usa la exportación de la Consola).
  const archivo = await definicionExportada(apiId, /\.(graphql|gql)$/);
  return archivo && /type\s+Query/.test(archivo.texto) ? { sdl: archivo.texto, origen: `Publisher · exportación de la API (${archivo.nombre})` } : undefined;
}

/** Busca un archivo de definición dentro del proyecto de la API que exporta el Publisher. */
async function definicionExportada(apiId: string, patron: RegExp): Promise<{ nombre: string; texto: string } | undefined> {
  try {
    const zip = unzipSync(new Uint8Array(await wso2().publisher.exportApi(apiId)));
    const nombre = Object.keys(zip).find((n) => patron.test(n));
    return nombre ? { nombre: nombre.split("/").slice(-2).join("/"), texto: strFromU8(zip[nombre]!) } : undefined;
  } catch {
    return undefined;
  }
}

/** Contrato AsyncAPI publicado (Publisher; si no, el Dev Portal) con sus canales. */
async function asyncApiPublicado(apiId: string): Promise<{ version: string; canales: string[]; origen: string } | undefined> {
  const w = wso2();
  for (const [origen, ruta] of [
    ["Publisher", `/api/am/publisher/v4/apis/${apiId}/asyncapi`],
    ["Dev Portal", `/api/am/devportal/v3/apis/${apiId}/swagger`],
  ] as const) {
    try {
      const r = await w.request<unknown>({ method: "GET", path: ruta });
      let d: unknown = r;
      if (typeof d === "object" && d && typeof (d as { apiDefinition?: unknown }).apiDefinition === "string") d = (d as { apiDefinition: string }).apiDefinition;
      if (typeof d === "string") d = leerYaml(d);
      const doc = d as { asyncapi?: string; channels?: Record<string, unknown> };
      if (doc?.asyncapi) return { version: String(doc.asyncapi), canales: Object.keys(doc.channels ?? {}), origen: `${origen} · GET …/${ruta.split("/").pop()}` };
    } catch {
      /* se prueba el siguiente */
    }
  }
  const archivo = await definicionExportada(apiId, /asyncapi\.(ya?ml|json)$/);
  if (!archivo) return undefined;
  try {
    const doc = leerYaml(archivo.texto) as { asyncapi?: string; channels?: Record<string, unknown> };
    return doc?.asyncapi ? { version: String(doc.asyncapi), canales: Object.keys(doc.channels ?? {}), origen: `Publisher · exportación de la API (${archivo.nombre})` } : undefined;
  } catch {
    return undefined;
  }
}

/** Abre una suscripción WebSocket y junta eventos hasta `n` o hasta `ms`. */
function suscribir(url: string, token: string | undefined, n: number, ms: number, alEvento?: (e: Record<string, unknown>, i: number) => void) {
  return new Promise<{ abierta: boolean; eventos: Array<Record<string, unknown>>; rechazo?: string }>((ok) => {
    const eventos: Array<Record<string, unknown>> = [];
    let abierta = false;
    let rechazo: string | undefined;
    const sock = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, rejectUnauthorized: false });
    const fin = () => {
      clearTimeout(limite);
      sock.removeAllListeners();
      sock.on("error", () => undefined);
      sock.terminate();
      ok({ abierta, eventos, ...(rechazo ? { rechazo } : {}) });
    };
    const limite = setTimeout(fin, ms);
    sock.on("open", () => (abierta = true));
    sock.on("message", (d) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(String(d)) as Record<string, unknown>;
      } catch {
        e = { texto: String(d).slice(0, 120) };
      }
      eventos.push(e);
      alEvento?.(e, eventos.length);
      if (eventos.length >= n) fin();
    });
    sock.on("unexpected-response", (_q, res) => {
      rechazo = `HTTP ${res.statusCode}`;
      fin();
    });
    sock.on("error", (e) => {
      rechazo ??= e.message.slice(0, 80);
      fin();
    });
    sock.on("close", (codigo) => {
      if (!abierta) rechazo ??= `cerrada (${codigo})`;
      fin();
    });
  });
}

export const d06: Demo = {
  id: "D-06",
  archivo: "D-06_graphql_asyncapi",
  nombre: "GraphQL nativo y APIs de eventos con contratos AsyncAPI",
  afirmacion:
    "La plataforma publica y protege APIs GraphQL nativas (con su esquema, su publicación y sus políticas) y APIs dirigidas por eventos descritas con AsyncAPI y entregadas por WebSocket, en el mismo gateway, portal y control de acceso que las APIs REST.",
  pasos: NARRACION_D06.length,
  agenda: NARRACION_D06.map((p) => p.titulo),

  async preparar(c) {
    await prepararEnsayo(c);
    await c.ingresarWso2("devportal");
    return ["sesión abierta en el Dev Portal de WSO2 (usuario admin del laboratorio)"];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const w = wso2();
    const apis = (await w.devportal.listApis()).list as Array<{ id: string; name: string; type?: string; context?: string; version?: string }>;
    const gql = apis.find((a) => a.name === "ConcesionesGraphQL");
    const ev = apis.find((a) => a.name === "EventosRed");
    if (!gql || !ev) throw new Error("faltan las APIs ConcesionesGraphQL o EventosRed en el Dev Portal");
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));

    // 1 ── Portal con los tres estilos ───────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D06[0]!);
    await c.vista("dividido");
    await c.ir("https://apim:9443/devportal/apis");
    const tarjetaGql = c.app.getByText("ConcesionesGraphQL").first();
    await tarjetaGql.waitFor();
    await verPagina(c, tarjetaGql);
    c.log("→ GET /api/am/devportal/v3/apis   # APIs publicadas en el portal", "cmd");
    for (const a of apis) c.log(`  ${a.name.padEnd(22)} ${String(a.type ?? "").padEnd(8)} ${a.context ?? ""}`);
    await e.esperar(1200);
    await e.zoom(tarjetaGql, { factor: 1.6, ms: 2200 });
    e.comprueba("el portal publica una API GraphQL", gql.type === "GRAPHQL", `${gql.name} · tipo ${gql.type ?? "?"}`);
    await e.mover(c.app.getByText("EventosRed").first());
    e.comprueba("el portal publica una API de eventos (WebSocket)", ev.type === "WS", `${ev.name} · tipo ${ev.type ?? "?"}`);
    await e.esperar(1500);

    // 2 ── GraphQL nativo: tipo, publicación y esquema ───────────────────────────────────────────────
    await e.paso(NARRACION_D06[1]!);
    await e.clic(c.app.getByText("ConcesionesGraphQL").first());
    await c.app.waitForURL(/\/devportal\/apis\/[^/?]+/, { timeout: 15_000 }).catch(() => undefined);
    if (!c.app.url().includes(gql.id)) await c.ir(`https://apim:9443/devportal/apis/${gql.id}/overview`);
    await c.app.getByText(gql.name).first().waitFor({ timeout: 30_000 });
    await e.mover(c.app.getByText(gql.name).first());
    const enPublisher = (await w.publisher.getApi(gql.id)) as unknown as ApiPublisher;
    c.log(`→ GET /api/am/publisher/v4/apis/${gql.id.slice(0, 8)}…   # ficha de la API en WSO2`, "cmd");
    c.log(`  tipo ${enPublisher.type} · estado ${enPublisher.lifeCycleStatus} · planes ${(enPublisher.policies ?? []).join(", ")}`);
    const operaciones = (enPublisher.operations ?? []).filter((o) => o.target);
    for (const o of operaciones.slice(0, 6)) c.log(`  operación ${String(o.verb ?? "").padEnd(6)} ${o.target}`);
    e.comprueba(
      "la API es de tipo GRAPHQL y está publicada",
      enPublisher.type === "GRAPHQL" && enPublisher.lifeCycleStatus === "PUBLISHED",
      `${enPublisher.type} · ${enPublisher.lifeCycleStatus}`,
    );
    const esquema = await esquemaPublicado(gql.id);
    const consultas = esquema ? [...(/type\s+Query\s*\{([^}]*)\}/.exec(esquema.sdl)?.[1] ?? "").matchAll(/^\s*(\w+)\s*[(:]/gm)].map((m) => m[1]!) : [];
    if (esquema) {
      c.log(`→ ${esquema.origen}   # esquema GraphQL publicado`, "cmd");
      c.panel(
        `<h3>Esquema GraphQL publicado en WSO2 (${escaparHtml(gql.name)})</h3><pre style="font-size:12px;line-height:1.35;white-space:pre-wrap;color:#cfe3ff">${escaparHtml(
          esquema.sdl.split("\n").slice(0, 30).join("\n"),
        )}</pre>`,
      );
      await c.vista("panel");
      await e.zoom(c.app.getByText(gql.name).first(), { factor: 1.5, ms: 2200 });
    }
    e.comprueba("el esquema publicado define las consultas", consultas.length >= 1, consultas.length ? `Query: ${consultas.join(", ")}` : "sin esquema");
    await e.esperar(2500);

    // 3 ── Políticas sobre GraphQL ───────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D06[2]!);
    await c.vista("dividido");
    const planes = enPublisher.policies ?? [];
    const seguridad = enPublisher.securityScheme ?? [];
    c.log(`planes de uso: ${planes.join(", ") || "—"} · seguridad: ${seguridad.join(", ") || "—"}`);
    e.comprueba("planes de uso y OAuth2 aplicados a la API", planes.length > 0 && seguridad.includes("oauth2"), `${planes.join(", ")} · ${seguridad.filter((s) => s === "oauth2").join("")}`);
    c.log(`→ POST ${GATEWAY.replace(/^https?:\/\//, "")}/graphql/concesiones/1.0.0   Authorization: Bearer …`, "cmd");
    c.log(`  ${CONSULTA}`, "tenue");
    const t0 = Date.now();
    let r = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", token, cuerpo: { query: CONSULTA } });
    for (let i = 0; i < 5 && r.status !== 200; i++) {
      await c.esperar(2000);
      r = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", token, cuerpo: { query: CONSULTA } });
    }
    const ms = Date.now() - t0;
    c.log(`HTTP ${r.status} en ${ms} ms`, r.status === 200 ? "ok" : "mal");
    for (const l of JSON.stringify(r.data, null, 1).split("\n").slice(0, 12)) c.log(`  ${l}`, "tenue", false);
    const datos = (r.data as { data?: { totalPorEstado?: unknown[]; concesiones?: unknown[] } }).data;
    e.indicadores({ "GraphQL con token": `HTTP ${r.status}`, "tiempo de respuesta": `${ms} ms` });
    e.comprueba(
      "consulta con token: respondida por el gateway",
      r.status === 200 && !!datos?.totalPorEstado?.length,
      `HTTP ${r.status} · ${datos?.totalPorEstado?.length ?? 0} estados · ${datos?.concesiones?.length ?? 0} concesiones`,
    );
    const sinToken = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", cuerpo: { query: CONSULTA } });
    c.log(`→ la misma consulta sin token → HTTP ${sinToken.status}`, sinToken.status === 401 ? "ok" : "mal");
    e.comprueba("sin token: rechazada", sinToken.status === 401, `HTTP ${sinToken.status}`);
    const fuera = await gateway("/graphql/concesiones/1.0.0", { metodo: "POST", token, cuerpo: { query: FUERA_DE_ESQUEMA } });
    const cuerpoFuera = fuera.data as { data?: unknown; errors?: Array<{ message?: string }>; fault?: { message?: string; description?: string } };
    const motivo = cuerpoFuera?.fault ? `${cuerpoFuera.fault.message ?? ""} ${cuerpoFuera.fault.description ?? ""}`.trim() : (cuerpoFuera?.errors?.[0]?.message ?? fuera.texto.slice(0, 120));
    const rechazada = fuera.status >= 400 || (!!cuerpoFuera?.errors?.length && !cuerpoFuera.data);
    c.log(`→ ${FUERA_DE_ESQUEMA}`, "cmd");
    c.log(`  HTTP ${fuera.status} · ${motivo.slice(0, 150)}`, rechazada ? "ok" : "mal");
    e.indicadores({ "GraphQL con token": `HTTP ${r.status}`, "sin token": `HTTP ${sinToken.status}`, "fuera del esquema": `HTTP ${fuera.status}` });
    e.comprueba("campo fuera del esquema: rechazado", rechazada, `HTTP ${fuera.status} · ${motivo.slice(0, 60)}`);
    await e.esperar(2000);

    // 4 ── AsyncAPI ──────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D06[3]!);
    await c.vista("dividido");
    await c.ir(`https://apim:9443/devportal/apis/${ev.id}/definition`);
    await c.app.getByText(/Operations|Channels|Canales|asyncapi/i).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    await verPagina(c);
    await e.desplazar(320);
    const contrato = await asyncApiPublicado(ev.id);
    if (contrato) {
      c.log(`→ ${contrato.origen}   # contrato AsyncAPI publicado`, "cmd");
      c.log(`  asyncapi ${contrato.version} · canales: ${contrato.canales.join(", ")}`);
    }
    e.comprueba("el contrato AsyncAPI publicado describe sus canales", !!contrato && contrato.canales.length > 0, contrato ? `AsyncAPI ${contrato.version} · ${contrato.canales.length} canal(es)` : "sin contrato");
    const lint = await nexoCtl(
      c,
      ["api", "lint", "../../wso2/apim/apis/eventos-red/asyncapi.yaml", "-r", "../../wso2/apim/governance/guia-asyncapi.yaml"],
      "nexo-ctl api lint wso2/apim/apis/eventos-red/asyncapi.yaml -r guia-asyncapi.yaml",
    );
    e.comprueba("el contrato cumple la guía de estilo AsyncAPI", lint.codigo === 0, `código de salida ${lint.codigo}`);
    await e.esperar(1500);

    // 5 ── Eventos en vivo ───────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D06[4]!);
    await c.vista("dividido");
    const url = await urlEventos();
    c.log("suscripción WebSocket a wss://apim:8099/eventos/red/1.0.0/ws con Authorization: Bearer … (cliente ws del guion)", "cmd");
    const con = await suscribir(url, token, 3, 25_000, (ev1, i) => c.log(`  evento ${i}: ${JSON.stringify(ev1).slice(0, 150)}`));
    if (con.abierta) c.log("  suscripción abierta a través del gateway", "ok");
    e.indicadores({ "eventos recibidos": con.eventos.length });
    e.comprueba("con token: llegan eventos por WebSocket", con.abierta && con.eventos.length >= 2, `${con.eventos.length} eventos`);
    c.log("la misma suscripción, sin token", "cmd");
    const sin = await suscribir(url, undefined, 1, 6000);
    c.log(`  ${sin.abierta ? "suscripción abierta" : `rechazada: ${sin.rechazo ?? "sin respuesta"}`}`, sin.abierta ? "mal" : "ok");
    e.comprueba("sin token: no se abre la suscripción", !sin.abierta && sin.eventos.length === 0, sin.rechazo ?? "sin eventos");
    const v = await verificacionLab(c, "check-d06", "check:d06");
    e.comprueba("verificación automática check-d06", v.ok, v.ok ? "GraphQL y eventos a través del gateway" : "falló");
    await e.esperar(2000);

    return {
      medido: `API GraphQL nativa publicada con su esquema (${consultas.length} consultas) y protegida (con token ${r.status}, sin token ${sinToken.status}, fuera del esquema ${fuera.status}); contrato AsyncAPI ${contrato?.version ?? "?"} y ${con.eventos.length} eventos recibidos por WebSocket con token OAuth`,
      datos: { msGraphQL: ms, consultas, sinToken: sinToken.status, fueraDeEsquema: fuera.status, canales: contrato?.canales ?? [], eventos: con.eventos.length },
    };
  },
};
