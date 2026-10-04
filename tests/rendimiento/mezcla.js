// Prueba de rendimiento de Yago Nexo (k6): mezcla de tráfico real a través de los gateways del laboratorio.
//
//   operadores   GET  https://apim:8243/concesiones/1.0.0/concesiones                 (gateway de operadores, REST)
//   publico      GET  https://publico.nexo.lab:18243/publico/concesiones/1.0.0/...     (gateway público, REST)
//   integracion  POST https://apim:8243/solicitudes/1.0.0/                              (gateway → Micro Integrator:
//                validación, llamada SOAP, transformación y publicación en RabbitMQ, con idempotencia)
//
// Todas las llamadas llevan un token OAuth2 de Keycloak (client_credentials) obtenido una vez por fase en
// setup(), para que la emisión de tokens no se mezcle con la medición. Variables de entorno:
//   TASA       transacciones por segundo totales (se reparten según REPARTO)
//   DURACION   duración de la fase a tasa constante (p. ej. "3m")
//   MODO       "constante" (por defecto) o "estres" (rampa desde TASA hasta TASA_MAX)
//   TASA_MAX   techo de la rampa de estrés
//   CONSUMER_KEY, CONSUMER_SECRET, TOKEN_URL   credenciales de la aplicación OperadorDemo en Keycloak
import http from "k6/http";
import { check } from "k6";
import encoding from "k6/encoding";

const REPARTO = { operadores: 0.5, publico: 0.3, integracion: 0.2 };
const TASA = Number(__ENV.TASA || 28);
const TASA_MAX = Number(__ENV.TASA_MAX || TASA * 3);
const DURACION = __ENV.DURACION || "3m";
const MODO = __ENV.MODO || "constante";

function escenario(fn, fraccion) {
  const tasa = Math.max(1, Math.round(TASA * fraccion));
  const vus = Math.max(10, Math.ceil(tasa * 0.6));
  if (MODO === "estres") {
    const techo = Math.max(tasa, Math.round(TASA_MAX * fraccion));
    return {
      executor: "ramping-arrival-rate",
      exec: fn,
      startRate: tasa,
      timeUnit: "1s",
      preAllocatedVUs: vus,
      maxVUs: vus * 8,
      stages: [
        { target: techo, duration: "5m" },
        { target: techo, duration: "1m" },
      ],
    };
  }
  return { executor: "constant-arrival-rate", exec: fn, rate: tasa, timeUnit: "1s", duration: DURACION, preAllocatedVUs: vus, maxVUs: vus * 6 };
}

export const options = {
  insecureSkipTLSVerify: true,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  scenarios: {
    operadores: escenario("operadores", REPARTO.operadores),
    publico: escenario("publico", REPARTO.publico),
    integracion: escenario("integracion", REPARTO.integracion),
  },
  thresholds: {
    // En estrés se corta si la tasa de error supera el 5% (se busca el límite, no aprobar).
    http_req_failed: MODO === "estres" ? [{ threshold: "rate<0.05", abortOnFail: true, delayAbortEval: "30s" }] : ["rate<0.01"],
    "http_req_duration{tipo:operadores}": ["p(99)<1000"],
    "http_req_duration{tipo:publico}": ["p(99)<1000"],
    "http_req_duration{tipo:integracion}": ["p(99)<2000"],
  },
};

export function setup() {
  const res = http.post(__ENV.TOKEN_URL, "grant_type=client_credentials", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${encoding.b64encode(`${__ENV.CONSUMER_KEY}:${__ENV.CONSUMER_SECRET}`)}`,
    },
    tags: { tipo: "token" },
  });
  if (res.status !== 200) throw new Error(`no se obtuvo token: ${res.status}`);
  return { token: res.json("access_token") };
}

const cabeceras = (d) => ({ authorization: `Bearer ${d.token}` });

export function operadores(d) {
  const r = http.get("https://apim:8243/concesiones/1.0.0/concesiones", { headers: cabeceras(d), tags: { tipo: "operadores" } });
  check(r, { "operadores 200": (x) => x.status === 200 });
}

export function publico(d) {
  const r = http.get("https://publico.nexo.lab:18243/publico/concesiones/1.0.0/concesiones/CON-000001", { headers: cabeceras(d), tags: { tipo: "publico" } });
  check(r, { "publico 200": (x) => x.status === 200 });
}

export function integracion(d) {
  const llave = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const r = http.post(
    "https://apim:8243/solicitudes/1.0.0/",
    JSON.stringify({ rutEmpresa: "76.086.428-5", servicio: "Internet", region: "Los Lagos" }),
    { headers: { ...cabeceras(d), "content-type": "application/json", "idempotency-key": llave }, tags: { tipo: "integracion" } },
  );
  check(r, { "integracion 2xx": (x) => x.status >= 200 && x.status < 300 });
}

export function handleSummary(data) {
  return { [__ENV.RESUMEN || "resumen.json"]: JSON.stringify(data, null, 2) };
}
