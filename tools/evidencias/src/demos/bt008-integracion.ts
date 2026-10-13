/**
 * BT-008 · Flujo de integración con validación, transformación, mapeo, orquestación y tratamiento de errores.
 * El flujo SolicitudesConcesion (Micro Integrator) recibe solicitudes por el gateway: valida contra su esquema,
 * aplica idempotencia, consulta el registro de operadores por SOAP 1.2, transforma y publica en RabbitMQ; un
 * consumidor entrega al sistema de destino con reintentos acotados y cola de fallidos.
 *
 * Veracidad (0-30 y 1-06): las solicitudes usan RUT válidos (dígito verificador calculado aquí); la entrega se
 * comprueba en el propio sistema de destino (contador de registros creados de concesiones-v1, /_estadisticas);
 * la cola de fallidos se vigila con la API de administración de RabbitMQ en modo solo lectura (cantidad de
 * mensajes de la cola, sin leerlos ni retirarlos) y al final se comprueba que queda como estaba (vacía).
 *
 * Duración estimada: portada 4 s + 6 pasos (≈ 14 + 16 + 14 + 32 + 24 + 22 s) + cierre 3 s ≈ 130 s (tope 240 s).
 */
import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { consola, contenedor, credencialesDe, gateway, tokenAplicacion, tokenPersona } from "../lib/lab.js";
import { prepararEnsayo, urlLab } from "./bt0x-ensayo.js";
import { esperarHasta, verificacionLab, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 130;

const URL = "/solicitudes/1.0.0/";
const DESTINO = "http://localhost:7001";
const RABBIT = process.env.NEXO_LAB_RABBITMQ_API ?? "http://localhost:15672/api";
const COLA_FALLIDOS = process.env.NEXO_RABBITMQ_DLQ ?? "solicitudes.dlq";
const COLA_ENTRADA = "solicitudes.nuevas";
type DeadLetter = { id: string; status: string; error?: string; payloadPreview?: string; attempts?: number; reprocessedBy?: string };

/** Dígito verificador de un RUT chileno (módulo 11). */
export function digitoRut(cuerpo: number): string {
  let suma = 0;
  let m = 2;
  for (const d of String(cuerpo).split("").reverse()) {
    suma += Number(d) * m;
    m = m === 7 ? 2 : m + 1;
  }
  const r = 11 - (suma % 11);
  return r === 11 ? "0" : r === 10 ? "K" : String(r);
}

/** true si el RUT (con puntos y guion) tiene el dígito verificador correcto. */
export function rutValido(rut: string): boolean {
  const m = /^(\d{1,8})-([\dK])$/.exec(rut.replace(/\./g, "").toUpperCase());
  return !!m && digitoRut(Number(m[1])) === m[2];
}

/** RUT sintéticos de las dos solicitudes del video (ambos válidos: el flujo no reintenta errores 4xx). */
export const RUT_VALIDA = "76.086.428-5";
export const RUT_FALLA = "96.806.980-2";

export const NARRACION_BT008: DefinicionPaso[] = [
  {
    titulo: "El flujo de solicitudes de concesión, etapa por etapa",
    quePasa: "El grafo muestra el flujo SolicitudesConcesion: recibe por el gateway, valida, evita duplicados, consulta por SOAP, transforma y encola.",
    porQueImporta: "Es la orquestación que pide el requisito: validación, transformación, mapeo, mensajería y tratamiento de errores en un solo flujo.",
    comprueba: ["el flujo aparece en el grafo de dependencias"],
  },
  {
    titulo: "Solicitud válida: aceptada y entregada al destino",
    quePasa: "Un sistema envía por el gateway una solicitud con RUT válido. El flujo responde 202 con una correlación y el destino la registra.",
    porQueImporta: "No basta con que el flujo acepte el mensaje: se comprueba en el destino que la entrega ocurrió de verdad.",
    comprueba: ["solicitud aceptada (202) con correlación", "el sistema de destino registró la solicitud"],
  },
  {
    titulo: "Sin duplicados y con rechazo de datos inválidos",
    quePasa: "Se reenvía la misma solicitud con la misma clave: misma correlación y ningún registro nuevo en el destino. Una inválida se rechaza.",
    porQueImporta: "Los reintentos de los consumidores no duplican trámites, y los datos mal formados se detienen en la entrada.",
    comprueba: ["repetición idempotente: misma correlación", "el destino no registró un duplicado", "solicitud inválida rechazada por el esquema"],
  },
  {
    titulo: "Falla del destino: reintentos y cola de fallidos",
    quePasa: "Se inyecta una falla: el destino responde error a todo. Otra solicitud válida se reintenta 3 veces y queda en la cola de fallidos.",
    porQueImporta: "Una caída del destino no pierde solicitudes: quedan guardadas para reprocesarlas cuando el destino vuelva.",
    comprueba: ["el mensaje llega a la cola de fallidos tras agotar los reintentos", "la Consola muestra el mensaje con sus intentos"],
  },
  {
    titulo: "Reproceso aprobado: entrega real y cola vacía",
    quePasa: "Con el destino de vuelta, la persona aprobadora reprocesa el mensaje en la Consola. El destino lo registra y la cola queda como estaba.",
    porQueImporta: "La recuperación es controlada y auditada, y se verifica en el destino que el mensaje recuperado se entregó.",
    comprueba: ["reproceso registrado por la persona aprobadora", "el sistema de destino recibió la solicitud reprocesada", "cola de fallidos vacía"],
  },
  {
    titulo: "Traza de punta a punta y verificación automática",
    quePasa: "La traza en Jaeger muestra el recorrido de la primera solicitud por el gateway y el integrador. Cierra la verificación automática.",
    porQueImporta: "Cada etapa deja rastro con la misma correlación: si algo falla en producción, se sabe dónde.",
    comprueba: ["traza con el gateway y el integrador", "verificación automática check-integracion"],
  },
];

async function chaos(failRate: number) {
  const url = urlLab(process.env.NEXO_LAB_CHAOS_URL ?? `${DESTINO}/_chaos`);
  await fetch(url, { method: "POST", headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" }, body: JSON.stringify({ failRate }) });
}

/** Registros creados en el sistema de destino (concesiones-v1). */
async function registrosDestino(): Promise<number> {
  const r = await fetch(urlLab(`${DESTINO}/_estadisticas`));
  const b = (await r.json()) as { registrosCreados?: number };
  if (typeof b.registrosCreados !== "number") throw new Error(`el destino no informó sus registros (HTTP ${r.status})`);
  return b.registrosCreados;
}

/** Cantidad de mensajes de una cola (API de administración de RabbitMQ, solo lectura: no lee ni retira mensajes). */
async function mensajesEnCola(cola: string): Promise<number> {
  const auth = `Basic ${Buffer.from(`${process.env.RABBITMQ_USER ?? "nexo"}:${process.env.RABBITMQ_PASSWORD ?? ""}`).toString("base64")}`;
  const r = await fetch(urlLab(`${RABBIT}/queues/%2F/${encodeURIComponent(cola)}`), { headers: { authorization: auth } });
  const b = (await r.json()) as { messages?: number };
  if (typeof b.messages !== "number") throw new Error(`RabbitMQ no informó la cola ${cola} (HTTP ${r.status})`);
  return b.messages;
}

const etapa = (l: string) => {
  const m = /etapa = ([^,]+), correlacion = urn:uuid:([0-9a-f-]{8})[0-9a-f-]*(.*)$/.exec(l);
  return m ? `MI · ${m[1]!.padEnd(26)} correlación ${m[2]}…${m[3]!.replace(/\s+$/, "")}` : undefined;
};

export const bt008: Demo = {
  id: "BT-008",
  archivo: "BT-008_flujo_integracion",
  nombre: "Flujo de integración con validación, transformación y orquestación",
  afirmacion:
    "El flujo de solicitudes de concesión valida cada mensaje contra su contrato, evita duplicados, orquesta una consulta SOAP 1.2 y una cola de mensajería, transforma los datos y los entrega al sistema de destino; ante una falla del destino reintenta, deja el mensaje en la cola de fallidos y lo entrega al reprocesarlo, registrando cada etapa con su correlación.",
  pasos: NARRACION_BT008.length,
  agenda: NARRACION_BT008.map((p) => p.titulo),
  usuarioInicial: "luis.aprobador",

  async preparar(c) {
    await prepararEnsayo(c);
    await chaos(0);
    const fallidos = await mensajesEnCola(COLA_FALLIDOS);
    return ["sistema de destino (concesiones-v1) respondiendo normalmente", `cola de fallidos ${COLA_FALLIDOS}: ${fallidos} mensajes (consulta de solo lectura)`];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const apr = await tokenPersona("luis.aprobador");
    const fallidosAntes = await mensajesEnCola(COLA_FALLIDOS);

    // 1 ── El flujo ──────────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[0]!);
    await c.vista("dividido");
    await c.ir("/dependencias");
    await c.app.getByTestId("graph-canvas").waitFor();
    const nodo = c.app.locator('[data-testid^="graph-node-flujo"]').first();
    await nodo.waitFor({ timeout: 20_000 }).catch(() => undefined);
    const hayNodo = await nodo.isVisible().catch(() => false);
    if (hayNodo) {
      await e.clic(nodo);
      await e.zoom(nodo, { factor: 1.6, ms: 2000 });
    }
    for (const l of [
      "1  recepción por el gateway (OAuth Keycloak) → Micro Integrator",
      "   validación contra el esquema JSON EsquemaSolicitud (422 si no cumple)",
      "2  idempotencia por Idempotency-Key (PostgreSQL de integración)",
      "3  enriquecimiento: RegistroOperadores por SOAP 1.2",
      "4  transformación y mapeo al mensaje canónico",
      "5  publicación en RabbitMQ (nexo.solicitudes) → 202 al consumidor",
      "6-7 consumo de la cola y entrega al sistema de destino",
      "8  reintentos con espera progresiva (2, 4 y 8 s)",
      "9  cola de fallidos (nexo.dlq) y reproceso con aprobación",
    ])
      c.log(l, "tenue", false);
    e.comprueba("el flujo aparece en el grafo de dependencias", hayNodo, hayNodo ? ((await nodo.textContent().catch(() => "")) ?? "").slice(0, 40) : "sin nodo");
    await e.esperar(1500);

    const logs = c.seguir("docker", ["logs", "-f", "--since", "1s", contenedor("mi")], { mostrar: "docker logs -f mi | grep etapa", filtro: etapa });

    // 2 ── Solicitud válida y entrega ────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[1]!);
    const idem = `evidencia-${randomUUID()}`;
    const traceId = randomUUID().replace(/-/g, "");
    const cuerpo = { rutEmpresa: RUT_VALIDA, servicio: "Internet", region: "Los Lagos" };
    const llamar = (k: string, b: unknown = cuerpo, traza = traceId) =>
      gateway(URL, { metodo: "POST", token, cuerpo: b, headers: { "idempotency-key": k, traceparent: `00-${traza}-${traza.slice(0, 16)}-01` } });
    const registros0 = await registrosDestino();
    c.log(`RUT ${RUT_VALIDA}: dígito verificador ${rutValido(RUT_VALIDA) ? "correcto" : "INCORRECTO"} · registros en el destino antes: ${registros0}`, "tenue");
    c.log(`→ POST gateway${URL}  Idempotency-Key: ${idem.slice(0, 18)}…  ${JSON.stringify(cuerpo)}`, "cmd");
    const r1 = await llamar(idem);
    c.log(`HTTP ${r1.status} ${JSON.stringify(r1.data).slice(0, 170)}`, r1.status === 202 ? "ok" : "mal");
    const correlacion = (r1.data as { correlacion?: string }).correlacion;
    e.exige("solicitud aceptada (202) con correlación", r1.status === 202 && !!correlacion, correlacion ? `HTTP ${r1.status} · ${correlacion.slice(0, 22)}…` : `HTTP ${r1.status}`);
    const entrega = await esperarHasta(registrosDestino, (n) => n >= registros0 + 1, 30, 1000);
    const registros1 = entrega?.valor ?? (await registrosDestino());
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros0} → ${registros1}`, "cmd");
    e.indicadores({ "registros en el destino": `${registros0} → ${registros1}`, "cola de fallidos": fallidosAntes });
    e.comprueba("el sistema de destino registró la solicitud", registros1 === registros0 + 1, entrega ? `+${registros1 - registros0} en ${entrega.seg.toFixed(0)} s` : `${registros1 - registros0} nuevos`);
    await e.esperar(1500);

    // 3 ── Idempotencia y validación ─────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[2]!);
    const r2 = await llamar(idem);
    c.log(`repetición (misma Idempotency-Key) → HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 150)}`, "ok");
    e.comprueba("repetición idempotente: misma correlación", (r2.data as { correlacion?: string }).correlacion === correlacion, `HTTP ${r2.status}`);
    const r3 = await llamar(`${idem}-inv`, { rutEmpresa: "1", servicio: "X" });
    const rechazo = r3.status === 400 || r3.status === 422;
    c.log(`inválida {"rutEmpresa":"1","servicio":"X"} → HTTP ${r3.status} ${JSON.stringify(r3.data).slice(0, 200)}`, rechazo ? "ok" : "mal");
    e.comprueba("solicitud inválida rechazada por el esquema", rechazo, `HTTP ${r3.status}`);
    await c.esperar(5000);
    const registros2 = await registrosDestino();
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros2}`, "cmd");
    e.indicadores({ "registros en el destino": `${registros0} → ${registros2}`, "cola de fallidos": fallidosAntes });
    e.comprueba("el destino no registró un duplicado", registros2 === registros1, `${registros2 - registros0} registro de 2 envíos`);

    // 4 ── Falla del destino ─────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[3]!);
    // La Consola ya muestra la cola de fallidos (una lectura al cargar; luego se vigila solo la cantidad).
    await c.ir("/mensajes-fallidos");
    await c.app.getByTestId("table-dead-letters").waitFor({ timeout: 20_000 }).catch(() => undefined);
    await verPagina(c, c.app.getByTestId("table-dead-letters"));
    c.log("→ inyectar falla en el sistema de destino: 100 % de respuestas 500", "cmd");
    await chaos(1);
    const r4 = await llamar(`evidencia-${randomUUID()}`, { rutEmpresa: RUT_FALLA, servicio: "Telefonía móvil", region: "Aysén" }, randomUUID().replace(/-/g, ""));
    const corr4 = (r4.data as { correlacion?: string }).correlacion;
    c.log(`RUT ${RUT_FALLA} (dígito verificador ${rutValido(RUT_FALLA) ? "correcto" : "INCORRECTO"}) → HTTP ${r4.status} · correlación ${corr4}`, r4.status === 202 ? "ok" : "mal");
    c.log(`→ vigilar la cola ${COLA_FALLIDOS} (RabbitMQ, solo lectura: cantidad de mensajes)`, "cmd");
    let ultimo = fallidosAntes;
    const llego = await esperarHasta(
      async () => {
        const n = await mensajesEnCola(COLA_FALLIDOS);
        if (n !== ultimo) c.log(`  ${COLA_FALLIDOS}: ${n} mensaje(s)`, "aviso");
        ultimo = n;
        e.indicadores({ "registros en el destino": `${registros0} → ${registros2}`, "cola de fallidos": n });
        return n;
      },
      (n) => n >= fallidosAntes + 1,
      60,
      2000,
    );
    await chaos(0);
    c.log("→ el sistema de destino vuelve a responder normalmente", "cmd");
    e.comprueba("el mensaje llega a la cola de fallidos tras agotar los reintentos", !!llego, llego ? `${llego.seg.toFixed(0)} s después de aceptado` : "no llegó");
    await c.app.reload();
    const filaDl = c.app.getByTestId(`btn-reprocess-${corr4}`);
    await filaDl.waitFor({ timeout: 20_000 }).catch(() => undefined);
    // Una sola lectura del registro de la Consola (la página ya lo pidió al cargar).
    const lista = (await consola<DeadLetter[]>(apr, "GET", "/dead-letters")).data;
    const dl = Array.isArray(lista) ? lista.find((d) => d.id === corr4 && d.status === "pendiente") : undefined;
    if (dl) c.log(`mensaje fallido: ${dl.attempts ?? "?"} intentos · ${dl.error ?? ""} · vista previa enmascarada: ${(dl.payloadPreview ?? "").slice(0, 80)}`);
    if (await filaDl.isVisible().catch(() => false)) await verPagina(c, filaDl);
    if (await filaDl.isVisible().catch(() => false)) await e.zoom(c.app.getByTestId(`dlq-row-${corr4}`), { factor: 1.5, ms: 2200 });
    e.comprueba("la Consola muestra el mensaje con sus intentos", !!dl && (dl.attempts ?? 0) >= 3, dl ? `${dl.attempts} intentos` : "no aparece");

    // 5 ── Reproceso y entrega ──────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[4]!);
    const registros3 = await registrosDestino();
    let reproceso: DeadLetter | undefined;
    if (dl && (await filaDl.isVisible().catch(() => false))) {
      await e.clic(filaDl);
      const razon = c.app.getByTestId("reprocess-dialog-reason");
      await razon.waitFor({ timeout: 5000 }).catch(() => undefined);
      if (await razon.isVisible().catch(() => false)) {
        await e.escribir(razon, "Destino restablecido; se reprocesa");
        const respuesta = c.app.waitForResponse((r) => /\/dead-letters\/[^/]+\/reprocess$/.test(r.url()), { timeout: 20_000 }).catch(() => undefined);
        await e.clic(c.app.getByTestId("reprocess-dialog-confirm"));
        const res = await respuesta;
        reproceso = res ? ((await res.json().catch(() => undefined)) as DeadLetter | undefined) : undefined;
      }
    }
    e.comprueba("reproceso registrado por la persona aprobadora", reproceso?.status === "reprocesado" && reproceso.reprocessedBy === "luis.aprobador", reproceso ? `${reproceso.status} · ${reproceso.reprocessedBy}` : "sin reproceso");
    const entregada = await esperarHasta(registrosDestino, (n) => n >= registros3 + 1, 30, 1000);
    const registros4 = entregada?.valor ?? (await registrosDestino());
    const fallidosDespues = await esperarHasta(() => mensajesEnCola(COLA_FALLIDOS), (n) => n <= fallidosAntes, 20, 1500);
    const enCola = fallidosDespues?.valor ?? (await mensajesEnCola(COLA_FALLIDOS));
    const entrada = await mensajesEnCola(COLA_ENTRADA).catch(() => undefined);
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros3} → ${registros4}`, "cmd");
    c.log(`→ RabbitMQ (solo lectura): ${COLA_FALLIDOS} ${enCola} mensaje(s)${entrada !== undefined ? ` · ${COLA_ENTRADA} ${entrada}` : ""}`, "cmd");
    e.indicadores({ "registros en el destino": `${registros0} → ${registros4}`, "cola de fallidos": enCola });
    e.comprueba("el sistema de destino recibió la solicitud reprocesada", registros4 === registros3 + 1, entregada ? `+1 en ${entregada.seg.toFixed(0)} s` : `${registros4 - registros3} nuevos`);
    if (fallidosAntes === 0) e.comprueba("cola de fallidos vacía", enCola === 0, `${enCola} mensajes`);
    else e.comprueba(`cola de fallidos sin el mensaje (vuelve a ${fallidosAntes})`, enCola === fallidosAntes, `${enCola} mensajes`);
    logs.detener();
    await e.esperar(1500);

    // 6 ── Traza y verificación automática ──────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[5]!);
    await c.vista("app");
    await c.ir(`http://localhost:16686/trace/${traceId}`);
    await c.app.waitForLoadState("networkidle").catch(() => undefined);
    await verPagina(c);
    await e.esperar(3000);
    await c.vista("dividido");
    const traza = (await (await fetch(urlLab(`http://localhost:16686/api/traces/${traceId}`))).json()) as { data?: Array<{ spans: unknown[]; processes: Record<string, { serviceName: string }> }> };
    const servicios = [...new Set(Object.values(traza.data?.[0]?.processes ?? {}).map((p) => p.serviceName))];
    c.log(`traza ${traceId.slice(0, 12)}…: ${traza.data?.[0]?.spans.length ?? 0} tramos · servicios ${servicios.join(", ")}`);
    e.comprueba("traza con el gateway y el integrador", servicios.length >= 2, servicios.join(", "));
    const v = await verificacionLab(c, "check-integracion", "check:integracion");
    e.comprueba("verificación automática check-integracion", v.ok, v.ok ? "gateway → integrador → cola → destino" : "falló");

    return {
      medido: `solicitud válida entregada al destino (+1 registro), repetición sin duplicar, inválida rechazada (${r3.status}); con el destino caído el mensaje llegó a fallidos en ${llego ? llego.seg.toFixed(0) : "?"} s y, reprocesado, se entregó (+1 registro) y la cola quedó en ${enCola}`,
      datos: { correlacion, registrosDestino: { antes: registros0, final: registros4 }, segundosHastaFallidos: llego?.seg, colaFallidos: { antes: fallidosAntes, despues: enCola }, servicios },
    };
  },

  async limpiar() {
    await chaos(0).catch(() => undefined);
  },
};
