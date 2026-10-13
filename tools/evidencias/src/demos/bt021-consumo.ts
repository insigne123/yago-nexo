/**
 * BT-021 · Medición de consumo atribuida al consumidor y al endpoint, con límites y sin cobros reales. Dos
 * aplicaciones consumidoras llaman por el gateway a distintos endpoints; la Consola muestra el consumo atribuido
 * (a partir de la analítica del gateway en OpenSearch), se compara con lo que se envió, se exporta en CSV y se
 * comprueba que el plan limita el exceso. La facturación de WSO2 está apagada y los planes no tienen cobro.
 *
 * Veracidad: la Consola filtra por días (no por hora), así que su pantalla muestra el consumo del día de todo el
 * laboratorio, no solo el de esta prueba. Por eso se fija el día de hoy en «Desde» y «Hasta» (el mismo período, en
 * UTC, que consulta el guion), se lee el consumo antes de enviar y se compara lo que sumó cada consumidor y cada
 * endpoint en la pantalla con lo que se envió; el panel y la terminal lo dicen así, con las dos cifras. Las cifras
 * que muestra la pantalla son las de su propia respuesta (se intercepta), no una consulta aparte. Si el total
 * «Llamadas» cambia al agrupar por endpoint, se explica con la analítica (llamadas sin endpoint registrado).
 *
 * Duración estimada: portada 4 s + 5 pasos (≈ 12 + 14 + 50 + 10 + 10 s) + cierre 3 s ≈ 105 s (tope 240 s; la
 * espera de la analítica del gateway es la parte variable, hasta 60 s).
 */
import { readFileSync } from "node:fs";
import type { Locator } from "playwright-core";
import { Agent, fetch } from "undici";
import type { Contexto, DefinicionPaso, Demo } from "../lib/grabador.js";
import type { Caja } from "../lib/trayectoria.js";
import { consola, credencialesDe, GATEWAY, tokenAplicacion, tokenPersona, wso2 } from "../lib/lab.js";
import { buscarAnalitica } from "./ayudas-d.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";
import { esperarCarga, esperarHasta, fmt, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 105;

const SEGUNDO = "FiscalizacionDemo";
const LISTA = `${GATEWAY}/concesiones/1.0.0/concesiones?estado=vigente`;
const DETALLE = `${GATEWAY}/concesiones/1.0.0/concesiones/CON-000002`;
type Fila = { key: string; label: string; llamadas: number; errores: number };
const inseguro = new Agent({ connect: { rejectUnauthorized: false }, connections: 64 });

export const NARRACION_BT021: DefinicionPaso[] = [
  {
    titulo: "Medición sin facturación",
    quePasa:
      "La pantalla de consumo de la Consola avisa que los cobros están desactivados. Se consulta a WSO2 la lista de planes: ninguno tiene cobro.",
    porQueImporta: "Se mide el uso de cada consumidor sin generar cobros reales, como pide el requisito.",
    comprueba: ["todos los planes sin cobro (FREE)"],
  },
  {
    titulo: "Dos consumidores llaman a distintos endpoints",
    quePasa:
      "Dos aplicaciones llaman por el gateway: OperadorDemo hace 40 llamadas a la lista y 16 al detalle; FiscalizacionDemo, 24 al detalle.",
    porQueImporta:
      "Para atribuir el consumo hay que saber exactamente cuánto envió cada uno; aquí se cuenta en el origen.",
    comprueba: ["las 80 llamadas responden 200"],
  },
  {
    titulo: "La Consola atribuye el consumo a cada consumidor y endpoint",
    quePasa:
      "La Consola muestra el consumo de hoy de todo el laboratorio; lo que sumó cada consumidor y endpoint en la prueba se compara con lo enviado.",
    porQueImporta:
      "La atribución es exacta: cada llamada de la prueba queda asignada a su aplicación y a su endpoint, sin diferencias.",
    comprueba: [
      "OperadorDemo: sumó en la Consola lo que envió",
      "FiscalizacionDemo: sumó en la Consola lo que envió",
      "endpoint /concesiones: sumó lo enviado",
      "endpoint /concesiones/{id}: sumó lo enviado",
    ],
  },
  {
    titulo: "Exportación del consumo en CSV",
    quePasa: "Desde la misma pantalla se descarga en CSV el consumo de hoy, con consumidores y endpoints.",
    porQueImporta:
      "El consumo se puede llevar a otras herramientas (planillas, conciliación) sin depender de la Consola.",
    comprueba: ["CSV con consumidores y endpoints"],
  },
  {
    titulo: "El plan limita el exceso",
    quePasa:
      "FiscalizacionDemo envía 45 llamadas en un segundo, más de las 20 por segundo de su plan. El gateway responde 429 a las que sobran.",
    porQueImporta:
      "Los límites de uso se aplican de verdad en el gateway, sin cobros: el exceso se limita, no se factura.",
    comprueba: ["el plan limita el exceso (429), sin cobro"],
  },
];

/** Segunda aplicación consumidora, aprovisionada por el Dev Portal con sus aprobaciones (idempotente). */
async function asegurarSegundoConsumidor(): Promise<string[]> {
  const w = wso2();
  const notas: string[] = [];
  let app = (await w.devportal.listApplications()).list.find((a) => a.name === SEGUNDO);
  const aprobar = async (tipo: string) => {
    for (const p of (await w.admin.listWorkflows(tipo)).list)
      await w.admin.resolveWorkflow(p.referenceId, "APPROVED", "Aprobado para la demostración de consumo");
  };
  if (!app) {
    app = await w.devportal.createApplication(
      SEGUNDO,
      "Sistema de fiscalización de un organismo externo (sintético)",
    );
    await aprobar("AM_APPLICATION_CREATION");
    notas.push(`aplicación ${SEGUNDO} creada y aprobada`);
  }
  const llave = (await w.devportal.listKeys(app.applicationId)).list.find(
    (k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION",
  );
  if (!llave?.consumerKey) {
    await w.devportal.generateKeys(app.applicationId, "Keycloak", ["client_credentials"], "PRODUCTION", {
      subject_type: "public",
      token_endpoint_auth_method: "client_secret_basic",
      tls_client_certificate_bound_access_tokens: "false",
    });
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
  if (!notas.length)
    notas.push(`segunda aplicación consumidora ${SEGUNDO} ya aprovisionada (plan OperadoresEstandar)`);
  return notas;
}

async function enviar(
  url: string,
  token: string,
  n: number,
  porSegundo = 8,
): Promise<Record<string, number>> {
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

/** Llamadas de una fila (por nombre del consumidor, su id o el endpoint); 0 si no está. */
export const llamadasDe = (filas: readonly Fila[], etiqueta: string): number =>
  filas.find((x) => x.label === etiqueta || x.key === etiqueta)?.llamadas ?? 0;

/** Total «Llamadas» de la pantalla: la suma de sus filas (como el indicador de la Consola). */
export const sumaLlamadas = (filas: readonly Fila[]): number =>
  filas.reduce((s, f) => s + (f.llamadas ?? 0), 0);

/** Consumidores que la Consola muestra con su identificador de WSO2 porque no están en su catálogo. */
export const sinNombre = (filas: readonly Fila[]): Fila[] =>
  filas.filter((f) => f.label === f.key && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(f.key));

/**
 * Respuesta de la propia pantalla de consumo (la que dibuja la tabla y el total) para un día y una agrupación.
 * Se registra antes de la acción que la provoca.
 */
function respuestaPantalla(c: Contexto, dia: string, groupBy: string): Promise<Fila[] | undefined> {
  return c.app
    .waitForResponse(
      (r) => {
        const u = new URL(r.url());
        return (
          u.pathname.endsWith("/api/v1/usage") &&
          u.searchParams.get("groupBy") === groupBy &&
          u.searchParams.get("from") === dia &&
          u.searchParams.get("to") === dia
        );
      },
      { timeout: 30_000 },
    )
    .then((r) => r.json() as Promise<Fila[]>)
    .catch(() => undefined);
}

/**
 * Caja que reúne las filas de la tabla cuyo primer dato es una de las etiquetas (para ampliarlas juntas), después
 * de llevar la primera a la vista. Si juntas no caben, solo la primera.
 */
async function cajaFilas(
  c: Contexto,
  tabla: Locator,
  etiquetas: readonly string[],
): Promise<Caja | undefined> {
  const filas = etiquetas.map((t) =>
    tabla
      .locator("tbody tr")
      .filter({ has: c.app.getByRole("cell", { name: t, exact: true }) })
      .first(),
  );
  if (!(await filas[0]!.isVisible().catch(() => false))) return undefined;
  await c.estudio.desplazar(filas[0]!);
  const cajas: Caja[] = [];
  for (const f of filas) {
    const b = await f.boundingBox({ timeout: 1500 }).catch(() => null);
    if (b) cajas.push(b);
  }
  if (!cajas.length) return undefined;
  const x = Math.min(...cajas.map((b) => b.x));
  const y = Math.min(...cajas.map((b) => b.y));
  const union = {
    x,
    y,
    width: Math.max(...cajas.map((b) => b.x + b.width)) - x,
    height: Math.max(...cajas.map((b) => b.y + b.height)) - y,
  };
  const alto = c.app.viewportSize()?.height ?? 570;
  return union.y >= 0 && union.y + union.height <= alto ? union : cajas[0];
}

/** Fija una fecha en un campo «date» de la Consola: clic visible y valor AAAA-MM-DD. */
async function fijarFecha(c: Contexto, campo: Locator, dia: string): Promise<void> {
  if ((await campo.inputValue({ timeout: 3000 }).catch(() => "")) === dia) return;
  await c.estudio.clic(campo);
  await campo.fill(dia);
  await c.estudio.esperar(400);
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
    const leer = async (groupBy: string) =>
      (await consola<Fila[]>(apr, "GET", `/usage?from=${hoy}&to=${hoy}&groupBy=${groupBy}`)).data;

    // 1 ── Sin facturación ───────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[0]!);
    await c.vista("dividido");
    await c.ir("/consumo");
    const aviso = c.app.getByTestId("billing-disabled-notice");
    await aviso.waitFor();
    await verPagina(c, aviso);
    await e.esperar(1500);
    await e.zoom(aviso, { factor: 1.5, ms: 2200 });
    const planes = await w.request<{
      list: Array<{
        policyName: string;
        billingPlan?: string;
        defaultLimit?: { requestCount?: { requestCount?: number; timeUnit?: string } };
      }>;
    }>({
      method: "GET",
      path: "/api/am/admin/v4/throttling/policies/subscription",
    });
    c.log("→ GET /api/am/admin/v4/throttling/policies/subscription", "cmd");
    for (const p of planes.list.filter((x) => /Operadores|Interno|Publico|Unlimited/.test(x.policyName))) {
      c.log(
        `  plan ${p.policyName.padEnd(20)} cobro ${p.billingPlan ?? "—"} · límite ${p.defaultLimit?.requestCount?.requestCount ?? "—"} por ${p.defaultLimit?.requestCount?.timeUnit ?? "—"}`,
      );
    }
    // Todos los planes, no solo los de arriba: así los N de la verificación se pueden contar en pantalla.
    const porCobro = new Map<string, number>();
    for (const p of planes.list)
      porCobro.set(p.billingPlan ?? "FREE", (porCobro.get(p.billingPlan ?? "FREE") ?? 0) + 1);
    c.log(
      `  los ${planes.list.length} planes (${[...porCobro].map(([k, n]) => `${n} con cobro ${k}`).join(", ")}): ${planes.list.map((p) => p.policyName).join(", ")}`,
      "tenue",
    );
    e.comprueba(
      "todos los planes sin cobro (FREE)",
      planes.list.length > 0 && planes.list.every((p) => (p.billingPlan ?? "FREE") === "FREE"),
      `${planes.list.length} planes`,
    );

    // 2 ── Llamadas de dos consumidores ──────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[1]!);
    const antesC = await leer("consumer");
    const antesE = await leer("endpoint");
    c.log(
      `→ GET /api/v1/usage?from=${hoy}&to=${hoy}   # consumo de hoy (UTC) antes de enviar: la misma consulta que hace la pantalla`,
      "cmd",
    );
    c.log(
      `  antes: OperadorDemo ${fmt(llamadasDe(antesC, "OperadorDemo"))} · ${SEGUNDO} ${fmt(llamadasDe(antesC, SEGUNDO))} · /concesiones ${fmt(llamadasDe(antesE, "/concesiones"))} · /concesiones/{id} ${fmt(llamadasDe(antesE, "/concesiones/{id}"))}`,
      "tenue",
    );
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
      c.log(
        `${p.quien.padEnd(18)} GET ${p.endpoint.padEnd(18)} ${p.n} llamadas → ${Object.entries(r)
          .map(([k, v]) => `${k}×${v}`)
          .join(" ")}`,
        r["200"] === p.n ? "ok" : "mal",
      );
      e.indicadores({ "llamadas enviadas": enviadas, "respuestas 200": ok200 });
    }
    e.comprueba("las 80 llamadas responden 200", ok200 === 80, `${ok200} de ${enviadas}`);
    const esperado: Record<string, number> = { OperadorDemo: 56, [SEGUNDO]: 24 };

    // 3 ── Atribución ───────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[2]!);
    const delta = (antes: Fila[], ahora: Fila[], etiqueta: string) =>
      llamadasDe(ahora, etiqueta) - llamadasDe(antes, etiqueta);
    c.log("esperando que la analítica del gateway registre las llamadas…", "tenue");
    const listo = await esperarHasta(
      async () => leer("consumer"),
      (f) => delta(antesC, f, "OperadorDemo") >= 56 && delta(antesC, f, SEGUNDO) >= 24,
      60,
      2000,
    );
    await esperarHasta(
      async () => leer("endpoint"),
      (f) => delta(antesE, f, "/concesiones") >= 40 && delta(antesE, f, "/concesiones/{id}") >= 40,
      20,
      2000,
    );
    if (listo) c.log(`consumo ingresado en la analítica en ${listo.seg.toFixed(0)} s`, "tenue");

    // La pantalla, con el mismo período que se midió: hoy en «Desde» y en «Hasta». Las cifras que se comparan
    // son las de la respuesta que dibuja la tabla.
    const desde = c.app.getByTestId("usage-from");
    const hasta = c.app.getByTestId("usage-to");
    const tabla = c.app.getByTestId("table-usage");
    const conFechas = await desde.isVisible().catch(() => false);
    const pantallaC = respuestaPantalla(c, hoy, "consumer");
    if (conFechas) {
      // Primero «Hasta» (si hiciera falta) y después «Desde»: la Consola exige Desde ≤ Hasta.
      await fijarFecha(c, hasta, hoy);
      await fijarFecha(c, desde, hoy);
      c.log(
        `Consola: período ${hoy} a ${hoy} (el día de hoy completo, en UTC, como la consulta del guion)`,
        "cmd",
      );
    } else {
      c.log("(ensayo: la pantalla simulada ya consulta solo el día de hoy)", "tenue");
      await c.app.reload();
    }
    const filasC = (await pantallaC) ?? (await leer("consumer"));
    const hayTabla = await esperarCarga(c.app, tabla, { ms: e.ensayo ? 2000 : 15_000, redMs: 3000 });
    const ahoraC: Record<string, number> = {};
    for (const [quien, n] of Object.entries(esperado)) {
      const antes = llamadasDe(antesC, quien);
      const ahora = llamadasDe(filasC, quien);
      ahoraC[quien] = ahora - antes;
      c.log(
        `  ${quien.padEnd(18)} en pantalla ${fmt(ahora)} · antes ${fmt(antes)} → sumó ${fmt(ahora - antes)} · enviadas ${n}`,
        ahora - antes === n ? "ok" : "mal",
      );
    }
    const anonimos = sinNombre(filasC);
    if (anonimos.length) {
      // ¿Siguen existiendo en WSO2? (API de administración: todas las aplicaciones, de todos los dueños)
      const apps = await w
        .request<{ list?: Array<{ applicationId: string }> }>({
          method: "GET",
          path: "/api/am/admin/v4/applications?limit=500",
        })
        .catch(() => undefined);
      const vigentes = new Set((apps?.list ?? []).map((a) => a.applicationId));
      const eliminadas = apps ? anonimos.filter((f) => !vigentes.has(f.key)).length : undefined;
      c.log(
        `  ${anonimos.length} consumidor(es) se ven con su identificador de WSO2 (${anonimos.map((f) => `${f.key.slice(0, 8)}…`).join(", ")}): no están en el catálogo de la Consola${
          eliminadas === undefined
            ? ""
            : eliminadas === anonimos.length
              ? " y ya no existen en WSO2 (aplicaciones que crearon y eliminaron otras pruebas)"
              : ` (${eliminadas} ya no existen en WSO2)`
        }`,
        "tenue",
      );
    }
    const otros = filasC.filter((f) => !(f.label in esperado) && !anonimos.includes(f));
    if (otros.length)
      c.log(
        `  ${otros.map((f) => f.label).join(", ")}: consumo de hoy de otras pruebas del laboratorio (esta prueba solo llama con OperadorDemo y ${SEGUNDO})`,
        "tenue",
      );
    // Se amplían las filas de los dos consumidores de la prueba (la cifra «Llamadas» es la de la terminal).
    const filasPrueba = hayTabla ? await cajaFilas(c, tabla, Object.keys(esperado)) : undefined;
    if (filasPrueba) await e.zoom(filasPrueba, { factor: 1.5, ms: 2800 });
    for (const [quien, n] of Object.entries(esperado))
      e.comprueba(
        `${quien}: sumó en la Consola lo que envió`,
        ahoraC[quien] === n,
        `+${ahoraC[quien]} de ${n} · ${fmt(llamadasDe(antesC, quien))} → ${fmt(llamadasDe(filasC, quien))}`,
      );

    // Por endpoint: misma pantalla, mismo período.
    const pantallaE = respuestaPantalla(c, hoy, "endpoint");
    await e.elegir(c.app.getByTestId("usage-group-by"), "endpoint");
    const filasE = (await pantallaE) ?? (await leer("endpoint"));
    await esperarCarga(c.app, tabla, { ms: e.ensayo ? 2000 : 15_000, redMs: 3000 });
    const dLista = delta(antesE, filasE, "/concesiones");
    const dDetalle = delta(antesE, filasE, "/concesiones/{id}");
    for (const [ep, d] of [
      ["/concesiones", dLista],
      ["/concesiones/{id}", dDetalle],
    ] as const)
      c.log(
        `  ${ep.padEnd(18)} en pantalla ${fmt(llamadasDe(filasE, ep))} · antes ${fmt(llamadasDe(antesE, ep))} → sumó ${fmt(d)} · enviadas 40`,
        d === 40 ? "ok" : "mal",
      );
    e.indicadores({
      "OperadorDemo, en la prueba": `+${ahoraC.OperadorDemo ?? 0} de 56`,
      [`${SEGUNDO}, en la prueba`]: `+${ahoraC[SEGUNDO] ?? 0} de 24`,
      "/concesiones, en la prueba": `+${dLista} de 40`,
      "/concesiones/{id}, en la prueba": `+${dDetalle} de 40`,
    });
    // El total «Llamadas» suma las filas de la vista: por endpoint no entran las llamadas sin endpoint registrado
    // (y por consumidor, las que no tienen aplicación). Se mide en la analítica del mismo día.
    const totalC = sumaLlamadas(filasC);
    const totalE = sumaLlamadas(filasE);
    if (totalC !== totalE) {
      type Cubeta = { key: number | string; doc_count: number };
      const q = {
        size: 0,
        query: {
          bool: {
            filter: [
              { range: { "@timestamp": { gte: `${hoy}T00:00:00.000Z`, lte: `${hoy}T23:59:59.999Z` } } },
            ],
            must_not: [{ term: { "applicationName.keyword": "UNKNOWN" } }],
          },
        },
        aggs: {
          sinEndpoint: {
            missing: { field: "apiResourceTemplate.keyword" },
            aggs: { codigo: { terms: { field: "proxyResponseCode", size: 8 } } },
          },
          sinConsumidor: { missing: { field: "applicationId.keyword" } },
        },
      };
      const a = await buscarAnalitica<{
        aggregations?: {
          sinEndpoint?: { doc_count: number; codigo?: { buckets: Cubeta[] } };
          sinConsumidor?: { doc_count: number };
        };
      }>(q).catch(() => undefined);
      const sinE = a?.aggregations?.sinEndpoint;
      const sinC = a?.aggregations?.sinConsumidor?.doc_count ?? 0;
      c.log(
        `total «Llamadas» de hoy: ${fmt(totalC)} por consumidor y ${fmt(totalE)} por endpoint (diferencia ${fmt(totalC - totalE)}): cada vista suma solo las llamadas que traen ese dato en la analítica del gateway`,
        "tenue",
      );
      if (sinE)
        c.log(
          `  analítica del gateway (OpenSearch, hoy): ${fmt(sinE.doc_count)} llamadas sin endpoint (${(sinE.codigo?.buckets ?? []).map((b) => `${b.key}×${fmt(b.doc_count)}`).join(" ")}) y ${fmt(sinC)} sin aplicación${
            sinE.doc_count - sinC === totalC - totalE
              ? `: ${fmt(sinE.doc_count)} − ${fmt(sinC)} = ${fmt(totalC - totalE)}, la diferencia`
              : ""
          }`,
          "tenue",
        );
    }
    const filasEndpoint = hayTabla
      ? await cajaFilas(c, tabla, ["/concesiones", "/concesiones/{id}"])
      : undefined;
    if (filasEndpoint) await e.zoom(filasEndpoint, { factor: 1.5, ms: 2800 });
    e.comprueba(
      "endpoint /concesiones: sumó lo enviado",
      dLista === 40,
      `+${dLista} de 40 · ${fmt(llamadasDe(antesE, "/concesiones"))} → ${fmt(llamadasDe(filasE, "/concesiones"))}`,
    );
    e.comprueba(
      "endpoint /concesiones/{id}: sumó lo enviado",
      dDetalle === 40,
      `+${dDetalle} de 40 · ${fmt(llamadasDe(antesE, "/concesiones/{id}"))} → ${fmt(llamadasDe(filasE, "/concesiones/{id}"))}`,
    );

    // 4 ── CSV ───────────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[3]!);
    const ruta = await c.descargar(c.app.getByTestId("btn-export-usage"), "consumo.csv");
    const csv = readFileSync(ruta, "utf8").trim().split("\n");
    c.log(
      `→ consumo.csv (${csv.length - 1} filas · consumo de hoy, el período que muestra la pantalla)`,
      "cmd",
    );
    for (const l of csv.slice(0, 8)) c.log(`  ${l}`);
    e.comprueba(
      "CSV con consumidores y endpoints",
      csv.some((l) => l.includes(SEGUNDO)) && csv.some((l) => l.includes("/concesiones/{id}")),
      `${csv.length - 1} filas`,
    );

    // 5 ── Límite del plan ───────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT021[4]!);
    const exceso = await enviar(DETALLE, fiscal, 45, 45);
    c.log(
      `45 llamadas en el mismo segundo → ${Object.entries(exceso)
        .map(([k, v]) => `${k}×${v}`)
        .join("  ")}`,
      exceso["429"] ? "ok" : "mal",
    );
    e.indicadores({ "llamadas en 1 s": 45, "limitadas (429)": exceso["429"] ?? 0 });
    e.comprueba(
      "el plan limita el exceso (429), sin cobro",
      (exceso["429"] ?? 0) > 0,
      `${exceso["429"] ?? 0} de 45 limitadas`,
    );
    await e.esperar(2000);

    return {
      medido: `las 80 llamadas de la prueba sumaron en la Consola (consumo de hoy) ${
        Object.entries(esperado).every(([q, n]) => ahoraC[q] === n) && dLista === 40 && dDetalle === 40
          ? "exactamente lo enviado"
          : "con diferencias frente a lo enviado"
      } por cada consumidor (OperadorDemo +${ahoraC.OperadorDemo ?? 0}, ${SEGUNDO} +${ahoraC[SEGUNDO] ?? 0}) y endpoint (+${dLista} y +${dDetalle}), exportadas en CSV; el plan limitó ${exceso["429"] ?? 0} de 45 llamadas en exceso; facturación desactivada`,
      datos: {
        esperado,
        dia: hoy,
        consumidores: ahoraC,
        endpoints: { "/concesiones": dLista, "/concesiones/{id}": dDetalle },
        totales: { porConsumidor: totalC, porEndpoint: totalE },
        exceso,
      },
    };
  },
};
