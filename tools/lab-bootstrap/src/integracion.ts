/**
 * Aserciones de la verificación del flujo de integración (check-integracion, 0-09), separadas de la red para
 * probarlas sin laboratorio. Cada función recibe lo que respondió el laboratorio y devuelve si cumple y por qué.
 */

export interface Resultado {
  nombre: string;
  ok: boolean;
  detalle: string;
}

/** Acumula verificaciones y decide el código de salida: una sola que no cumpla hace fallar el check. */
export class Verificaciones {
  readonly lista: Resultado[] = [];

  constructor(private readonly log: (m: string) => void = console.log) {}

  verificar(nombre: string, ok: boolean, detalle: string): boolean {
    this.lista.push({ nombre, ok, detalle });
    this.log(`[integración] ${ok ? "CUMPLE" : "NO CUMPLE"} · ${nombre}: ${detalle}`);
    return ok;
  }

  get fallidas(): Resultado[] {
    return this.lista.filter((r) => !r.ok);
  }

  resumen(): string {
    return `${this.lista.length - this.fallidas.length} de ${this.lista.length} verificaciones cumplen`;
  }
}

export interface RespuestaSolicitud {
  idSolicitud?: string;
  estado?: string;
  operador?: { rut?: string; razonSocial?: string };
  correlacion?: string;
  repeticion?: boolean;
  error?: string;
}

/** 202 con identificador, correlación y la razón social que agregó el servicio SOAP (enriquecimiento). */
export function evaluarAceptada(status: number, cuerpo: RespuestaSolicitud): Resultado {
  const ok =
    status === 202 &&
    /^SOL-/.test(cuerpo.idSolicitud ?? "") &&
    !!cuerpo.correlacion &&
    !!cuerpo.operador?.razonSocial?.trim();
  const detalle = ok
    ? `202 ${cuerpo.idSolicitud}, razón social «${cuerpo.operador!.razonSocial}» desde el servicio SOAP`
    : status === 202
      ? `202 sin ${!cuerpo.operador?.razonSocial?.trim() ? "razón social del servicio SOAP" : "identificador o correlación"}`
      : `se esperaba 202 y respondió ${status}${cuerpo.error ? ` (${cuerpo.error})` : ""}; si el servicio SOAP está detenido el flujo no puede enriquecer la solicitud`;
  return { nombre: "solicitud válida aceptada (202) y enriquecida por SOAP", ok, detalle };
}

/** La repetición con la misma Idempotency-Key devuelve la respuesta original sin volver a procesar. */
export function evaluarRepeticion(
  status: number,
  cuerpo: RespuestaSolicitud,
  encabezadoReplay: string | null,
  original: RespuestaSolicitud,
): Resultado {
  const ok =
    status === 200 &&
    cuerpo.repeticion === true &&
    cuerpo.idSolicitud === original.idSolicitud &&
    cuerpo.correlacion === original.correlacion &&
    encabezadoReplay === "true";
  return {
    nombre: "repetición con la misma Idempotency-Key (idempotencia)",
    ok,
    detalle: ok
      ? `200 con la misma solicitud ${cuerpo.idSolicitud} y X-Idempotent-Replay: true`
      : `respondió ${status}, repeticion=${String(cuerpo.repeticion)}, id ${cuerpo.idSolicitud ?? "-"} (original ${original.idSolicitud ?? "-"}), X-Idempotent-Replay=${encabezadoReplay ?? "-"}`,
  };
}

export function evaluarInvalida(status: number, cuerpo: RespuestaSolicitud): Resultado {
  const ok = status === 422 && cuerpo.error === "solicitud inválida";
  return {
    nombre: "solicitud inválida rechazada por el esquema (422)",
    ok,
    detalle: ok
      ? "422 solicitud inválida"
      : `se esperaba 422 y respondió ${status}${cuerpo.error ? ` (${cuerpo.error})` : ""}`,
  };
}

/** Fila de GET /_recepciones del sistema de destino de ejemplo. */
export interface Recepcion {
  en: string;
  correlacion: string;
  idempotencyKey: string;
  status: number;
  resultado: "creado" | "repeticion" | "rechazado" | "falla-simulada";
}

/** El destino registró la solicitud exactamente una vez, aunque el consumidor la haya enviado dos veces. */
export function evaluarEntrega(recepciones: Recepcion[], correlacion: string): Resultado {
  const propias = recepciones.filter((r) => r.correlacion === correlacion);
  const creadas = propias.filter((r) => r.resultado === "creado").length;
  const ok = creadas === 1;
  return {
    nombre: "entrega al sistema de destino, una sola vez",
    ok,
    detalle: ok
      ? `el destino registró la solicitud 1 vez (${propias.length} recepción${propias.length === 1 ? "" : "es"} con la correlación)`
      : `el destino la registró ${creadas} veces (${propias.map((r) => `${r.status} ${r.resultado}`).join(", ") || "sin recepciones"})`,
  };
}

/** Un rechazo 4xx del destino no se reintenta (0-32): una sola recepción y el mensaje en la cola de fallidos. */
export function evaluarRechazoSinReintento(
  recepciones: Recepcion[],
  correlacion: string,
  status: number,
): Resultado {
  const propias = recepciones.filter((r) => r.correlacion === correlacion);
  const ok = propias.length === 1 && propias[0]!.status === status;
  return {
    nombre: `rechazo ${status} del destino sin reintentos`,
    ok,
    detalle: ok
      ? `1 recepción (${status}) y ningún reintento`
      : `${propias.length} recepciones: ${propias.map((r) => r.status).join(", ") || "ninguna"}`,
  };
}

/** Mensaje de GET (peek) de la API de administración de RabbitMQ. */
export interface MensajeCola {
  payload: string;
  properties?: { headers?: Record<string, unknown> };
}

export function buscarEnCola(mensajes: MensajeCola[], correlacion: string): MensajeCola | undefined {
  return mensajes.find((m) => m.properties?.headers?.["x-correlacion"] === correlacion);
}

export function evaluarEnFallidos(mensaje: MensajeCola | undefined, status: number): Resultado {
  const h = mensaje?.properties?.headers ?? {};
  const ok = !!mensaje && String(h["x-intentos"]) === "1" && h["x-motivo"] === `HTTP ${status}`;
  return {
    nombre: "mensaje rechazado en la cola de fallidos con 1 intento",
    ok,
    detalle: mensaje
      ? `x-intentos=${String(h["x-intentos"])}, x-motivo=${String(h["x-motivo"])}`
      : "no está en la cola de fallidos",
  };
}

/** Información de la cola (GET /api/queues/{vhost}/{cola}) que interesa para la política de fallidos. */
export interface InfoCola {
  messages?: number;
  policy?: string | null;
  effective_policy_definition?: Record<string, unknown>;
  /** Límite de entregas efectivo que informa RabbitMQ 4.x: un número o "unlimited". */
  delivery_limit?: number | string;
}

/** La cola de fallidos tiene desactivado el límite de entregas (política delivery-limit -1). */
export function sinLimiteDeEntregas(info: InfoCola): boolean {
  return info.delivery_limit === "unlimited" || info.effective_policy_definition?.["delivery-limit"] === -1;
}

/**
 * 1-06: consultar la cola de fallidos no la vacía. Medido en RabbitMQ 4.3.6: sin la política, una lectura con
 * reject_requeue_true descarta el mensaje al pasar el límite de entregas por omisión (20) de las colas quorum; la
 * lectura de la Consola (ack_requeue_true) no lo descarta. Se exige la política y que el mensaje siga ahí después
 * de más de 20 lecturas en el modo que sí descartaría.
 */
export function evaluarConsultaNoDestructiva(
  info: InfoCola,
  lecturas: number | undefined,
  sigueEnLaCola: boolean,
): Resultado {
  const politica = sinLimiteDeEntregas(info);
  const ok = politica && lecturas !== undefined && sigueEnLaCola;
  const limite =
    info.delivery_limit ?? info.effective_policy_definition?.["delivery-limit"] ?? "por omisión: 20";
  return {
    nombre: "consultar la cola de fallidos no descarta mensajes",
    ok,
    detalle: !politica
      ? `la cola no tiene la política sin límite de entregas (política ${info.policy ?? "ninguna"}, límite ${String(limite)}): no se hacen las lecturas, porque vaciarían la cola; ejecute make bootstrap`
      : `política ${info.policy ?? "?"} (límite ${String(limite)}); tras ${lecturas ?? 0} lecturas con reject_requeue_true el mensaje ${sigueEnLaCola ? "sigue en la cola" : "ya no está"}`,
  };
}

interface TrazaJaeger {
  result?: {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
      scopeSpans?: Array<{ spans?: unknown[] }>;
    }>;
  };
}

/** Spans por servicio de una traza de la API v3 de Jaeger. */
export function spansPorServicio(t: TrazaJaeger): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of t.result?.resourceSpans ?? []) {
    const s =
      r.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue ?? "(sin nombre)";
    out[s] = (out[s] ?? 0) + (r.scopeSpans ?? []).reduce((n, x) => n + (x.spans?.length ?? 0), 0);
  }
  return out;
}

/** La traza de extremo a extremo cruza el gateway y Micro Integrator. */
export function evaluarTraza(status: number, t: TrazaJaeger | undefined, traceId: string): Resultado {
  const spans = t ? spansPorServicio(t) : {};
  const ok = status === 200 && (spans["API:Gateway"] ?? 0) > 0 && (spans["WSO2-SYNAPSE"] ?? 0) > 0;
  return {
    nombre: "traza de extremo a extremo (gateway y Micro Integrator)",
    ok,
    detalle:
      status === 200
        ? `traza ${traceId}: ${
            Object.entries(spans)
              .map(([s, n]) => `${s} ${n} spans`)
              .join(", ") || "sin spans"
          }`
        : `traza ${traceId} no encontrada en Jaeger (${status})`,
  };
}
