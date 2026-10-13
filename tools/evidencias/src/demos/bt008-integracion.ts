/**
 * BT-008 · Flujo de integración con validación, transformación, mapeo, orquestación y tratamiento de errores.
 * El flujo SolicitudesConcesion (Micro Integrator) recibe solicitudes por el gateway: valida contra su esquema,
 * aplica idempotencia, consulta el registro de operadores por SOAP 1.2, transforma y publica en RabbitMQ; un
 * consumidor entrega al sistema de destino con reintentos acotados y cola de fallidos.
 *
 * Veracidad (0-30 y 1-06): las solicitudes usan RUT válidos (dígito verificador calculado aquí; el de la falla es
 * un número repetido, claramente ficticio); la entrega se comprueba en el propio sistema de destino (contador de
 * registros creados de concesiones-v1, /_estadisticas); la cola de fallidos se vigila con la API de
 * administración de RabbitMQ en modo solo lectura (cantidad de mensajes de la cola, sin leerlos ni retirarlos).
 * La cola puede traer mensajes de antes de la grabación (cada check:integracion deja uno, el rechazo 422 del
 * destino que prueba): se cuentan al empezar, se dicen en el panel y se sigue solo el mensaje de esta solicitud,
 * que entra (+1) y, reprocesado, sale (−1). Nada se borra de la cola para grabar.
 *
 * Duración estimada: portada 4 s + 6 pasos (≈ 14 + 16 + 14 + 32 + 24 + 22 s) + cierre 3 s ≈ 130 s (tope 240 s).
 */
import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { consola, contenedor, credencialesDe, gateway, tokenAplicacion, tokenPersona } from "../lib/lab.js";
import { prepararEnsayo, urlLab } from "./bt0x-ensayo.js";
import {
  cambiarVista,
  esperarCarga,
  esperarHasta,
  textoEnLinea,
  verificacionLab,
  verPagina,
} from "./comun.js";

export const DURACION_ESTIMADA_S = 130;

const URL = "/solicitudes/1.0.0/";
const DESTINO = "http://localhost:7001";
const RABBIT = process.env.NEXO_LAB_RABBITMQ_API ?? "http://localhost:15672/api";
const COLA_FALLIDOS = process.env.NEXO_RABBITMQ_DLQ ?? "solicitudes.dlq";
const COLA_ENTRADA = "solicitudes.nuevas";
type DeadLetter = {
  id: string;
  status: string;
  error?: string;
  payloadPreview?: string;
  attempts?: number;
  reprocessedBy?: string;
};

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

/**
 * RUT de las dos solicitudes del video (ambos válidos: el flujo no reintenta errores 4xx). El de la solicitud
 * válida es el que usan las verificaciones del laboratorio (check:integracion); el de la falla es un número
 * repetido con su dígito verificador correcto (44.444.444-4), claramente ficticio.
 */
export const RUT_VALIDA = "76.086.428-5";
export const RUT_FALLA = "44.444.444-4";

export const NARRACION_BT008: DefinicionPaso[] = [
  {
    titulo: "El flujo de solicitudes de concesión, etapa por etapa",
    quePasa:
      "El grafo muestra el flujo SolicitudesConcesion: recibe por el gateway, valida, evita duplicados, consulta por SOAP, transforma y encola.",
    porQueImporta:
      "Es la orquestación que pide el requisito: validación, transformación, mapeo, mensajería y tratamiento de errores en un solo flujo.",
    comprueba: ["el flujo aparece en el grafo de dependencias"],
  },
  {
    titulo: "Solicitud válida: aceptada y entregada al destino",
    quePasa:
      "Un sistema envía por el gateway una solicitud con RUT válido. El flujo responde 202 con una correlación y el destino la registra.",
    porQueImporta:
      "No basta con que el flujo acepte el mensaje: se comprueba en el destino que la entrega ocurrió de verdad.",
    comprueba: ["solicitud aceptada (202) con correlación", "el sistema de destino registró la solicitud"],
  },
  {
    titulo: "Sin duplicados y con rechazo de datos inválidos",
    quePasa:
      "Se reenvía la misma solicitud con la misma clave: misma correlación y ningún registro nuevo en el destino. Una inválida se rechaza.",
    porQueImporta:
      "Los reintentos de los consumidores no duplican trámites, y los datos mal formados se detienen en la entrada.",
    comprueba: [
      "repetición idempotente: misma correlación",
      "el destino no registró un duplicado",
      "solicitud inválida rechazada por el esquema",
      "la inválida no llega a la cola de fallidos",
    ],
  },
  {
    titulo: "Falla del destino: reintentos y cola de fallidos",
    quePasa:
      "Se inyecta una falla: el destino responde error a todo. Otra solicitud válida se reintenta 3 veces y queda en la cola de fallidos.",
    porQueImporta:
      "Una caída del destino no pierde solicitudes: quedan guardadas para reprocesarlas cuando el destino vuelva.",
    comprueba: [
      "el mensaje llega a la cola de fallidos tras agotar los reintentos",
      "la Consola muestra el mensaje con sus intentos",
    ],
  },
  {
    titulo: "Reproceso aprobado: entrega real y salida de la cola de fallidos",
    quePasa:
      "Con el destino de vuelta, la persona aprobadora reprocesa el mensaje en la Consola. El destino lo registra y el mensaje sale de la cola.",
    porQueImporta:
      "La recuperación es controlada y auditada, y se verifica en el destino que el mensaje recuperado se entregó.",
    comprueba: [
      "reproceso registrado por la persona aprobadora",
      "el sistema de destino recibió la solicitud reprocesada",
      "el mensaje reprocesado sale de la cola de fallidos",
    ],
  },
  {
    titulo: "Traza de punta a punta y verificación automática",
    quePasa:
      "La traza en Jaeger muestra el recorrido de la primera solicitud por el gateway y el integrador. Cierra la verificación automática.",
    porQueImporta:
      "Cada etapa deja rastro con la misma correlación: si algo falla en producción, se sabe dónde.",
    comprueba: ["traza con el gateway y el integrador", "verificación automática check-integracion"],
  },
];

/**
 * Paso 4 con lo que ya había en la cola de fallidos antes de grabar (medido al empezar): así el panel dice que
 * esos mensajes no son de esta prueba y que se sigue solo el de esta solicitud.
 */
export function pasoFalla(previos: number): DefinicionPaso {
  const base = NARRACION_BT008[3]!;
  if (previos <= 0) return base;
  return {
    ...base,
    quePasa: `Se inyecta una falla en el destino. Otra solicitud válida se reintenta 3 veces y llega a la cola de fallidos (${previos} ${previos === 1 ? "mensaje es" : "mensajes son"} de antes).`,
  };
}

/** Indicador de la cola de fallidos: total y, si había, cuántos eran de antes de la grabación. */
export const textoCola = (n: number, previos: number) =>
  previos > 0 ? `${n} · ${previos} de antes` : `${n}`;

type Tramo = { spanID: string; references?: Array<{ refType?: string; spanID?: string }> };

/**
 * Tramos de una traza cuyo tramo padre no está en la traza (Jaeger los cuenta para su aviso «Incomplete») y los
 * padres que faltan.
 */
export function tramosHuerfanos(tramos: readonly Tramo[]): { huerfanos: number; padres: string[] } {
  const ids = new Set(tramos.map((t) => t.spanID));
  const padres = new Set<string>();
  let huerfanos = 0;
  for (const t of tramos) {
    const faltan = (t.references ?? []).filter(
      (r) => (r.refType ?? "CHILD_OF") === "CHILD_OF" && !!r.spanID && !ids.has(r.spanID),
    );
    if (faltan.length) huerfanos++;
    for (const r of faltan) padres.add(r.spanID!);
  }
  return { huerfanos, padres: [...padres] };
}

async function chaos(failRate: number) {
  const url = urlLab(process.env.NEXO_LAB_CHAOS_URL ?? `${DESTINO}/_chaos`);
  await fetch(url, {
    method: "POST",
    headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" },
    body: JSON.stringify({ failRate }),
  });
}

/** Registros creados en el sistema de destino (concesiones-v1). */
async function registrosDestino(): Promise<number> {
  const r = await fetch(urlLab(`${DESTINO}/_estadisticas`));
  const b = (await r.json()) as { registrosCreados?: number };
  if (typeof b.registrosCreados !== "number")
    throw new Error(`el destino no informó sus registros (HTTP ${r.status})`);
  return b.registrosCreados;
}

/** Cantidad de mensajes de una cola (API de administración de RabbitMQ, solo lectura: no lee ni retira mensajes). */
async function mensajesEnCola(cola: string): Promise<number> {
  const auth = `Basic ${Buffer.from(`${process.env.RABBITMQ_USER ?? "nexo"}:${process.env.RABBITMQ_PASSWORD ?? ""}`).toString("base64")}`;
  const r = await fetch(urlLab(`${RABBIT}/queues/%2F/${encodeURIComponent(cola)}`), {
    headers: { authorization: auth },
  });
  const b = (await r.json()) as { messages?: number };
  if (typeof b.messages !== "number")
    throw new Error(`RabbitMQ no informó la cola ${cola} (HTTP ${r.status})`);
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
    // La Consola registra los mensajes de la cola cuando alguien abre su lista (su «Primer fallo» es esa hora):
    // se abre aquí, antes de grabar, para que los que ya estaban queden con una hora anterior al video.
    const registro = await consola<DeadLetter[]>(
      await tokenPersona("luis.aprobador"),
      "GET",
      "/dead-letters",
    );
    const pendientes = Array.isArray(registro.data)
      ? registro.data.filter((d) => d.status === "pendiente").length
      : 0;
    return [
      "sistema de destino (concesiones-v1) respondiendo normalmente",
      `cola de fallidos ${COLA_FALLIDOS}: ${fallidos} mensajes de antes de esta grabación (consulta de solo lectura)`,
      `registro de la Consola al día con la cola: ${pendientes} pendientes (GET /api/v1/dead-letters)`,
    ];
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
    // El nombre del flujo: el título de la tarjeta del nodo (o, si no lo tiene, su primera línea de texto).
    const nombreNodo = hayNodo
      ? ((await nodo
          .locator("p[title]")
          .first()
          .getAttribute("title", { timeout: 1000 })
          .catch(() => null)) ?? (await textoEnLinea(nodo)).split(" · ")[0])
      : undefined;
    e.comprueba("el flujo aparece en el grafo de dependencias", hayNodo, nombreNodo ?? "sin nodo");
    await e.esperar(1500);

    const logs = c.seguir("docker", ["logs", "-f", "--since", "1s", contenedor("mi")], {
      mostrar: "docker logs -f mi | grep etapa",
      filtro: etapa,
    });

    // 2 ── Solicitud válida y entrega ────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[1]!);
    const idem = `evidencia-${randomUUID()}`;
    // Cada envío lleva su propia traza: la de Jaeger (paso 6) es solo la de esta primera solicitud.
    const nuevaTraza = () => randomUUID().replace(/-/g, "");
    const traceId = nuevaTraza();
    const cuerpo = { rutEmpresa: RUT_VALIDA, servicio: "Internet", region: "Los Lagos" };
    const llamar = (k: string, b: unknown = cuerpo, traza = traceId) =>
      gateway(URL, {
        metodo: "POST",
        token,
        cuerpo: b,
        headers: { "idempotency-key": k, traceparent: `00-${traza}-${traza.slice(0, 16)}-01` },
      });
    const registros0 = await registrosDestino();
    c.log(
      `RUT ${RUT_VALIDA}: dígito verificador ${rutValido(RUT_VALIDA) ? "correcto" : "INCORRECTO"} · registros en el destino antes: ${registros0}`,
      "tenue",
    );
    c.log(`→ POST gateway${URL}  Idempotency-Key: ${idem.slice(0, 18)}…  ${JSON.stringify(cuerpo)}`, "cmd");
    c.log(
      `  traceparent: traza ${traceId.slice(0, 12)}… · tramo padre ${traceId.slice(0, 16)} (el de esta prueba como cliente)`,
      "tenue",
    );
    const r1 = await llamar(idem);
    c.log(`HTTP ${r1.status} ${JSON.stringify(r1.data).slice(0, 170)}`, r1.status === 202 ? "ok" : "mal");
    const correlacion = (r1.data as { correlacion?: string }).correlacion;
    e.exige(
      "solicitud aceptada (202) con correlación",
      r1.status === 202 && !!correlacion,
      correlacion ? `HTTP ${r1.status} · ${correlacion.slice(0, 22)}…` : `HTTP ${r1.status}`,
    );
    const entrega = await esperarHasta(registrosDestino, (n) => n >= registros0 + 1, 30, 1000);
    const registros1 = entrega?.valor ?? (await registrosDestino());
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros0} → ${registros1}`, "cmd");
    e.indicadores({
      "registros en el destino": `${registros0} → ${registros1}`,
      "cola de fallidos": textoCola(fallidosAntes, fallidosAntes),
    });
    e.comprueba(
      "el sistema de destino registró la solicitud",
      registros1 === registros0 + 1,
      entrega
        ? `+${registros1 - registros0} en ${entrega.seg.toFixed(0)} s`
        : `${registros1 - registros0} nuevos`,
    );
    await e.esperar(1500);

    // 3 ── Idempotencia y validación ─────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[2]!);
    const r2 = await llamar(idem, cuerpo, nuevaTraza());
    c.log(
      `repetición (misma Idempotency-Key) → HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 150)}`,
      "ok",
    );
    e.comprueba(
      "repetición idempotente: misma correlación",
      (r2.data as { correlacion?: string }).correlacion === correlacion,
      `HTTP ${r2.status}`,
    );
    const r3 = await llamar(`${idem}-inv`, { rutEmpresa: "1", servicio: "X" }, nuevaTraza());
    const rechazo = r3.status === 400 || r3.status === 422;
    c.log(
      `inválida {"rutEmpresa":"1","servicio":"X"} → HTTP ${r3.status} ${JSON.stringify(r3.data).slice(0, 200)}`,
      rechazo ? "ok" : "mal",
    );
    e.comprueba("solicitud inválida rechazada por el esquema", rechazo, `HTTP ${r3.status}`);
    const corrInvalida = (r3.data as { correlacion?: string }).correlacion;
    await c.esperar(5000);
    const registros2 = await registrosDestino();
    const fallidos3 = await mensajesEnCola(COLA_FALLIDOS);
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros2}`, "cmd");
    c.log(`→ RabbitMQ (solo lectura): ${COLA_FALLIDOS} ${fallidos3} mensaje(s)`, "cmd");
    e.indicadores({
      "registros en el destino": `${registros0} → ${registros2}`,
      "cola de fallidos": textoCola(fallidos3, fallidosAntes),
    });
    e.comprueba(
      "el destino no registró un duplicado",
      registros2 === registros1,
      `${registros2 - registros0} registro de 2 envíos`,
    );
    e.comprueba(
      "la inválida no llega a la cola de fallidos",
      fallidos3 === fallidosAntes,
      `${fallidosAntes} → ${fallidos3} mensajes`,
    );

    // 4 ── Falla del destino ─────────────────────────────────────────────────────────────────────────
    await e.paso(pasoFalla(fallidosAntes));
    // La Consola ya muestra la cola de fallidos (una lectura al cargar; luego se vigila solo la cantidad).
    await c.ir("/mensajes-fallidos");
    await c.app
      .getByTestId("table-dead-letters")
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    await verPagina(c, c.app.getByTestId("table-dead-letters"));
    c.log("→ inyectar falla en el sistema de destino: 100 % de respuestas 500", "cmd");
    await chaos(1);
    const r4 = await llamar(
      `evidencia-${randomUUID()}`,
      { rutEmpresa: RUT_FALLA, servicio: "Telefonía móvil", region: "Aysén" },
      nuevaTraza(),
    );
    const corr4 = (r4.data as { correlacion?: string }).correlacion;
    c.log(
      `RUT ${RUT_FALLA} (ficticio; dígito verificador ${rutValido(RUT_FALLA) ? "correcto" : "INCORRECTO"}) → HTTP ${r4.status} · correlación ${corr4}`,
      r4.status === 202 ? "ok" : "mal",
    );
    c.log(`→ vigilar la cola ${COLA_FALLIDOS} (RabbitMQ, solo lectura: cantidad de mensajes)`, "cmd");
    let ultimo = fallidosAntes;
    const llego = await esperarHasta(
      async () => {
        const n = await mensajesEnCola(COLA_FALLIDOS);
        if (n !== ultimo) c.log(`  ${COLA_FALLIDOS}: ${n} mensaje(s)`, "aviso");
        ultimo = n;
        e.indicadores({
          "registros en el destino": `${registros0} → ${registros2}`,
          "cola de fallidos": textoCola(n, fallidosAntes),
        });
        return n;
      },
      (n) => n >= fallidosAntes + 1,
      60,
      2000,
    );
    await chaos(0);
    c.log("→ el sistema de destino vuelve a responder normalmente", "cmd");
    e.comprueba(
      "el mensaje llega a la cola de fallidos tras agotar los reintentos",
      !!llego,
      llego ? `${llego.seg.toFixed(0)} s después de aceptado` : "no llegó",
    );
    await c.app.reload();
    const filaDl = c.app.getByTestId(`btn-reprocess-${corr4}`);
    await filaDl.waitFor({ timeout: 20_000 }).catch(() => undefined);
    // Una sola lectura del registro de la Consola (la página ya lo pidió al cargar).
    const lista = (await consola<DeadLetter[]>(apr, "GET", "/dead-letters")).data;
    const dl = Array.isArray(lista)
      ? lista.find((d) => d.id === corr4 && d.status === "pendiente")
      : undefined;
    if (dl)
      c.log(
        `mensaje fallido: ${dl.attempts ?? "?"} intentos · ${dl.error ?? ""} · vista previa enmascarada: ${(dl.payloadPreview ?? "").slice(0, 80)}`,
      );
    if (Array.isArray(lista)) {
      const otros = lista.filter((d) => d.status === "pendiente" && d.id !== corr4).length;
      if (otros)
        c.log(
          `los otros ${otros} pendientes ya estaban en la cola antes de esta grabación (${fallidosAntes} al empezar); su «Primer fallo» es la hora en que la Consola los registró, no la del fallo`,
          "tenue",
        );
      if (corrInvalida)
        c.log(
          `la solicitud inválida (correlación ${corrInvalida.replace(/^urn:uuid:/, "").slice(0, 8)}…) ${lista.some((d) => d.id === corrInvalida) ? "ESTÁ" : "no está"} en la cola de fallidos: se rechazó en la entrada`,
          lista.some((d) => d.id === corrInvalida) ? "mal" : "tenue",
        );
    }
    if (await filaDl.isVisible().catch(() => false)) await verPagina(c, filaDl);
    if (await filaDl.isVisible().catch(() => false))
      await e.zoom(c.app.getByTestId(`dlq-row-${corr4}`), { factor: 1.5, ms: 2200 });
    e.comprueba(
      "la Consola muestra el mensaje con sus intentos",
      !!dl && (dl.attempts ?? 0) >= 3,
      dl ? `${dl.attempts} intentos` : "no aparece",
    );

    // 5 ── Reproceso y entrega ──────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[4]!);
    const registros3 = await registrosDestino();
    const antesReproceso = await mensajesEnCola(COLA_FALLIDOS);
    let reproceso: DeadLetter | undefined;
    if (dl && (await filaDl.isVisible().catch(() => false))) {
      await e.clic(filaDl);
      const razon = c.app.getByTestId("reprocess-dialog-reason");
      await razon.waitFor({ timeout: 5000 }).catch(() => undefined);
      if (await razon.isVisible().catch(() => false)) {
        await e.escribir(razon, "Destino restablecido; se reprocesa");
        const respuesta = c.app
          .waitForResponse((r) => /\/dead-letters\/[^/]+\/reprocess$/.test(r.url()), { timeout: 20_000 })
          .catch(() => undefined);
        await e.clic(c.app.getByTestId("reprocess-dialog-confirm"));
        const res = await respuesta;
        reproceso = res ? ((await res.json().catch(() => undefined)) as DeadLetter | undefined) : undefined;
      }
    }
    e.comprueba(
      "reproceso registrado por la persona aprobadora",
      reproceso?.status === "reprocesado" && reproceso.reprocessedBy === "luis.aprobador",
      reproceso ? `${reproceso.status} · ${reproceso.reprocessedBy}` : "sin reproceso",
    );
    const entregada = await esperarHasta(registrosDestino, (n) => n >= registros3 + 1, 30, 1000);
    const registros4 = entregada?.valor ?? (await registrosDestino());
    const fallidosDespues = await esperarHasta(
      () => mensajesEnCola(COLA_FALLIDOS),
      (n) => n <= antesReproceso - 1,
      20,
      1500,
    );
    const enCola = fallidosDespues?.valor ?? (await mensajesEnCola(COLA_FALLIDOS));
    const entrada = await mensajesEnCola(COLA_ENTRADA).catch(() => undefined);
    c.log(`→ GET concesiones-v1/_estadisticas → registrosCreados ${registros3} → ${registros4}`, "cmd");
    c.log(
      `→ RabbitMQ (solo lectura): ${COLA_FALLIDOS} ${enCola} mensaje(s)${entrada !== undefined ? ` · ${COLA_ENTRADA} ${entrada}` : ""}`,
      "cmd",
    );
    e.indicadores({
      "registros en el destino": `${registros0} → ${registros4}`,
      "cola de fallidos": textoCola(enCola, fallidosAntes),
    });
    e.comprueba(
      "el sistema de destino recibió la solicitud reprocesada",
      registros4 === registros3 + 1,
      entregada ? `+1 en ${entregada.seg.toFixed(0)} s` : `${registros4 - registros3} nuevos`,
    );
    e.comprueba(
      "el mensaje reprocesado sale de la cola de fallidos",
      enCola === antesReproceso - 1,
      `${antesReproceso} → ${enCola} mensajes`,
    );
    if (fallidosAntes > 0 && enCola === fallidosAntes)
      c.log(
        `en la cola quedan los ${fallidosAntes} mensajes que ya estaban antes de esta grabación`,
        "tenue",
      );
    logs.detener();
    await e.esperar(1500);

    // 6 ── Traza y verificación automática ──────────────────────────────────────────────────────────
    await e.paso(NARRACION_BT008[5]!);
    // La traza se carga a pantalla completa y se espera a que Jaeger dibuje sus tramos antes de mirarla.
    await cambiarVista(c, "app");
    await c.ir(`http://localhost:16686/trace/${traceId}`);
    const tramoGateway = c.app.getByText(/API:Gateway|apim-gateway/).first();
    await esperarCarga(c.app, tramoGateway, { ms: 20_000 });
    await verPagina(c);
    const traza = (await (await fetch(urlLab(`http://localhost:16686/api/traces/${traceId}`))).json()) as {
      data?: Array<{ spans: Tramo[]; processes: Record<string, { serviceName: string }> }>;
    };
    const tramos = traza.data?.[0]?.spans ?? [];
    const servicios = [...new Set(Object.values(traza.data?.[0]?.processes ?? {}).map((p) => p.serviceName))];
    c.log(`traza ${traceId.slice(0, 12)}…: ${tramos.length} tramos · servicios ${servicios.join(", ")}`);
    const { huerfanos, padres } = tramosHuerfanos(tramos);
    const padrePrueba = traceId.slice(0, 16);
    if (huerfanos)
      c.log(
        `Jaeger marca «Incomplete»: ${huerfanos} tramo(s) apuntan a un tramo padre que no está en la traza${
          padres.length === 1 && padres[0] === padrePrueba
            ? ` (${padrePrueba}, el que declaró esta prueba en su traceparent: la prueba no envía tramos a Jaeger)`
            : ` (${padres.map((x) => x.slice(0, 16)).join(", ")})`
        }`,
        "tenue",
      );
    e.comprueba("traza con el gateway y el integrador", servicios.length >= 2, servicios.join(", "));
    // Los nombres de los tramos se leen ampliados: el paso del gateway al integrador.
    const tramoIntegrador = c.app.getByText(/WSO2-SYNAPSE|micro-integrator/).first();
    if (await tramoIntegrador.isVisible().catch(() => false))
      await e.zoom(tramoIntegrador, { factor: 1.6, ms: 2600 });
    await e.esperar(1500);
    // Para la verificación automática, vista dividida: la traza sigue a todo lo ancho, sobre la terminal.
    await cambiarVista(c, "dividido");
    const v = await verificacionLab(c, "check-integracion", "check:integracion");
    const propias = v.salida.map((l) => /(\d+) de (\d+) verificaciones/.exec(l)).find(Boolean);
    e.comprueba(
      "verificación automática check-integracion",
      v.ok,
      propias ? `${propias[1]} de ${propias[2]} comprobaciones propias` : v.ok ? "código 0" : "falló",
    );
    // check:integracion prueba también el rechazo 422 del destino: ese mensaje suyo queda en la cola.
    const trasVerificacion = await mensajesEnCola(COLA_FALLIDOS).catch(() => enCola);
    if (trasVerificacion !== enCola) {
      c.log(
        `→ RabbitMQ (solo lectura): ${COLA_FALLIDOS} ${enCola} → ${trasVerificacion}: check:integracion deja su propio mensaje de prueba (rechazo 422 del destino, sin reintentos)`,
        "cmd",
      );
      e.indicadores({
        "registros en el destino": `${registros0} → ${registros4}`,
        "cola de fallidos": textoCola(trasVerificacion, fallidosAntes),
      });
    }

    return {
      medido: `solicitud válida entregada al destino (+1 registro), repetición sin duplicar, inválida rechazada (${r3.status}) sin pasar a fallidos; con el destino caído el mensaje llegó a fallidos en ${llego ? llego.seg.toFixed(0) : "?"} s y, reprocesado, se entregó (+1 registro) y salió de la cola (${antesReproceso} → ${enCola} mensajes)`,
      datos: {
        correlacion,
        registrosDestino: { antes: registros0, final: registros4 },
        segundosHastaFallidos: llego?.seg,
        colaFallidos: {
          antesDeGrabar: fallidosAntes,
          antesDelReproceso: antesReproceso,
          despuesDelReproceso: enCola,
          trasVerificacion,
        },
        servicios,
      },
    };
  },

  async limpiar() {
    await chaos(0).catch(() => undefined);
  },
};
