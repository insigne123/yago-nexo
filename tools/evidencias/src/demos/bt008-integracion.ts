/**
 * Flujo de integración con validación, transformación, mapeo, orquestación y tratamiento de errores.
 * El flujo SolicitudesConcesion (Micro Integrator) recibe solicitudes por el gateway: valida contra su esquema,
 * aplica idempotencia, consulta el registro de operadores por SOAP 1.2, transforma y publica en RabbitMQ; un
 * consumidor entrega al sistema de destino con reintentos acotados y cola de fallidos. Cada etapa queda en el
 * registro con su correlación y en la traza de OpenTelemetry (Jaeger).
 */
import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import type { Demo } from "../lib/grabador.js";
import { consola, contenedor, credencialesDe, gateway, tokenAplicacion, tokenPersona } from "../lib/lab.js";
import { esperarHasta, verificacionLab } from "./comun.js";

const URL = "/solicitudes/1.0.0/";
const CHAOS_V1 = process.env.NEXO_LAB_CHAOS_URL ?? "http://localhost:7001/_chaos";
type DeadLetter = { id: string; status: string; error?: string; payloadPreview?: string; attempts?: number };

async function chaos(failRate: number) {
  await fetch(CHAOS_V1, { method: "POST", headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" }, body: JSON.stringify({ failRate }) });
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
    "El flujo de solicitudes de concesión valida cada mensaje contra su contrato, evita duplicados, orquesta una consulta SOAP 1.2 y una cola de mensajería, transforma los datos, trata las fallas del destino con reintentos y cola de fallidos, y registra cada etapa con su correlación.",
  pasos: 5,
  usuarioInicial: "luis.aprobador",

  async preparar() {
    await chaos(0);
    return ["sistema de destino (backend de concesiones) respondiendo normalmente"];
  },

  async ejecutar(c) {
    const token = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const apr = await tokenPersona("luis.aprobador");

    c.paso("El flujo: validación → idempotencia → SOAP 1.2 → transformación → cola → destino, con reintentos y fallidos");
    await c.ir("/dependencias");
    await c.app.getByTestId("graph-canvas").waitFor();
    await c.esperar(1500);
    const nodo = c.app.locator('[data-testid^="graph-node-flujo"]').first();
    await nodo.waitFor({ timeout: 20_000 }).catch(() => undefined);
    await c.esperar(1000);
    if (await nodo.isVisible().catch(() => false)) await c.clic(nodo);
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
    await c.esperar(4000);

    const logs = c.seguir("docker", ["logs", "-f", "--since", "1s", contenedor("mi")], { mostrar: "docker logs -f mi | grep etapa", filtro: etapa });

    c.paso("Solicitud válida por el gateway: 202 y cada etapa registrada con su correlación");
    const idem = `evidencia-${randomUUID()}`;
    const traceId = randomUUID().replace(/-/g, "");
    const cuerpo = { rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" };
    const llamar = (k: string, b: unknown = cuerpo) =>
      gateway(URL, { metodo: "POST", token, cuerpo: b, headers: { "idempotency-key": k, traceparent: `00-${traceId}-${traceId.slice(0, 16)}-01` } });
    c.log(`$ POST gateway${URL}  Idempotency-Key: ${idem.slice(0, 18)}…  ${JSON.stringify(cuerpo)}`, "cmd");
    const r1 = await llamar(idem);
    c.log(`HTTP ${r1.status} ${JSON.stringify(r1.data).slice(0, 170)}`, r1.status === 202 ? "ok" : "mal");
    const correlacion = (r1.data as { correlacion?: string }).correlacion;
    c.exigir("solicitud aceptada (202) con correlación", r1.status === 202 && !!correlacion, correlacion);
    await c.esperar(4000);

    c.paso("Misma Idempotency-Key: no se duplica; solicitud inválida: rechazo con el detalle de la validación");
    const r2 = await llamar(idem);
    c.log(`repetición → HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 150)}`, "ok");
    c.verificar("repetición idempotente: misma correlación, sin reprocesar", (r2.data as { correlacion?: string }).correlacion === correlacion, `HTTP ${r2.status}`);
    const r3 = await llamar(`${idem}-inv`, { rutEmpresa: "1", servicio: "X" });
    const rechazo = r3.status === 400 || r3.status === 422;
    c.log(`inválida → HTTP ${r3.status} ${JSON.stringify(r3.data).slice(0, 200)}`, rechazo ? "ok" : "mal");
    c.verificar("solicitud inválida rechazada por el esquema", rechazo, `HTTP ${r3.status}`);
    await c.esperar(2500);

    c.paso("Ruta de excepción: el destino falla; el flujo reintenta 3 veces y deja el mensaje en la cola de fallidos");
    c.log("$ inyectar falla en el sistema de destino: 100 % de respuestas 500", "cmd");
    await chaos(1);
    const r4 = await llamar(`evidencia-${randomUUID()}`, { rutEmpresa: "96.512.340-1", servicio: "Telefonía móvil", region: "Aysén" });
    const corr4 = (r4.data as { correlacion?: string }).correlacion;
    c.log(`HTTP ${r4.status} · correlación ${corr4}`, r4.status === 202 ? "ok" : "mal");
    await c.ir("/mensajes-fallidos");
    const dl = await esperarHasta(
      // El id del mensaje fallido es la correlación del flujo.
      async () => (await consola<DeadLetter[]>(apr, "GET", "/dead-letters")).data.find((d) => d.id === corr4 && d.status === "pendiente"),
      (d) => !!d,
      60,
      1500,
    );
    await chaos(0);
    c.log("$ el sistema de destino vuelve a responder normalmente", "cmd");
    await c.app.reload();
    await c.esperar(2500);
    c.verificar("mensaje en la cola de fallidos tras agotar los reintentos", !!dl?.valor, dl ? `${dl.seg.toFixed(0)} s después de aceptado` : "no llegó");
    if (dl?.valor) {
      c.log(`mensaje fallido: ${dl.valor.attempts ?? "?"} intentos · ${dl.valor.error ?? ""} · vista previa enmascarada: ${(dl.valor.payloadPreview ?? "").slice(0, 90)}`);
      await c.clic(c.app.getByTestId(`btn-reprocess-${dl.valor.id}`));
      const razon = c.app.getByTestId("reprocess-dialog-reason");
      if (await razon.isVisible({ timeout: 3000 }).catch(() => false)) {
        await c.escribir(razon, "Destino restablecido; se reprocesa", 12);
        await c.clic(c.app.getByTestId("reprocess-dialog-confirm"));
      }
      const rep = await esperarHasta(async () => (await consola<DeadLetter[]>(apr, "GET", "/dead-letters")).data.find((d) => d.id === dl.valor!.id), (d) => !!d && d.status !== "pendiente", 30, 1500);
      await c.esperar(3000);
      c.verificar("reproceso aprobado y entregado al destino", !!rep && rep.valor!.status !== "pendiente", rep?.valor?.status ?? "sigue pendiente");
    }
    logs.detener();

    c.paso("Traza de punta a punta (OpenTelemetry → Jaeger) y verificación automática del flujo");
    await c.vista("app");
    await c.ir(`http://localhost:16686/trace/${traceId}`);
    await c.esperar(6000);
    await c.vista("dividido");
    const traza = (await (await fetch(`http://localhost:16686/api/traces/${traceId}`)).json()) as { data?: Array<{ spans: unknown[]; processes: Record<string, { serviceName: string }> }> };
    const servicios = [...new Set(Object.values(traza.data?.[0]?.processes ?? {}).map((p) => p.serviceName))];
    c.log(`traza ${traceId.slice(0, 12)}…: ${traza.data?.[0]?.spans.length ?? 0} tramos · servicios ${servicios.join(", ")}`);
    c.verificar("traza con el gateway y el integrador", servicios.length >= 2, servicios.join(", "));
    const v = await verificacionLab(c, "check-integracion", "check:integracion");
    c.verificar("check-integracion: gateway → integrador → cola → destino", v.ok);

    return {
      medido: `solicitud válida aceptada y trazada etapa por etapa, repetición sin duplicar, inválida rechazada (${r3.status}) y falla del destino derivada a fallidos en ${dl ? dl.seg.toFixed(0) : "?"} s tras 3 reintentos`,
      datos: { correlacion, segundosHastaFallidos: dl?.seg, servicios },
    };
  },

  async limpiar() {
    await chaos(0);
  },
};
