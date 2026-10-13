/**
 * D-04 · Despliegue canary y blue-green con reversión automática y sin corte de servicio.
 *
 * Con un consumidor real llamando sin pausa por el gateway (OAuth con Keycloak), la API Concesiones cambia de
 * backend tres veces por nexo-division (Envoy):
 *   1. producción estable en el backend concesiones-v1 (tarjeta «Endpoint estable» de la Consola);
 *   2. desarrollo solicita un canary del backend concesiones-v2 y otra persona lo aprueba (quien solicita
 *      recibe 403 si intenta aprobar);
 *   3. con el 25 % del tráfico real en concesiones-v2 se inyecta una falla real (respuestas 500): el
 *      controlador mide la tasa de error del paso y revierte solo; los errores quedan acotados a ese tramo;
 *   4. corregida la falla, el canary avanza 5 → 25 → 50 → 100 % y concesiones-v2 pasa a ser el estable;
 *   5. un blue-green devuelve todo el tráfico a concesiones-v1 de una vez, sin errores.
 * Los backends se nombran por su contenedor: sus números (1.0.0 y 1.1.0) son de la API de ejemplo, no del
 * producto. Duración estimada: ≈ 170 s (ver revisarGuion en ayudas-d.test.ts).
 */
import { fetch } from "undici";
import type { Contexto, Demo } from "../lib/grabador.js";
import { consola, ENSAYO, GATEWAY, reescribirUrlEnsayo, tokenPersona } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";
import {
  abrir,
  agendaDe,
  ampliar,
  aparece,
  backendDeUrl,
  cargaContinua,
  comando,
  desplazarSiHay,
  n,
  seg,
  type CargaD,
  type PasoGuion,
} from "./ayudas-d.js";
import { prepararEnsayoD } from "./d0x-ensayo.js";

const URL = `${GATEWAY}/concesiones/1.0.0/concesiones`;
const V1 = "http://concesiones-v1:7001";
const V2 = "http://concesiones-v2:7001";
/** Falla inyectable del backend concesiones-v2 (en ensayo, la línea se desvía al servidor de ensayo). */
const CHAOS_V2 = ENSAYO
  ? "http://localhost:7011/_chaos"
  : (process.env.NEXO_LAB_CHAOS_V2 ?? "http://localhost:7011/_chaos");
const UMBRALES = { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 8 };
type Ruta = { apiId: string; apiName: string; stableUrl: string; rolloutId?: string };
type Paso = { kind: string; weight: number; requests: number; decision: string; errorRate?: number };
type Rollout = {
  id: string;
  status: string;
  rollbackReason?: string;
  currentWeight?: number;
  stableEndpoint?: string;
  approvedBy?: string;
  stepsDone: Paso[];
};

export const PASOS_D04: PasoGuion[] = [
  {
    titulo: "Producción estable: el consumidor llama sin pausa",
    quePasa:
      "La API Concesiones atiende desde el backend estable concesiones-v1. Un consumidor real la llama 20 veces por segundo durante todo el video.",
    porQueImporta:
      "Cambiar de versión no puede cortar el servicio: cada error que reciba este consumidor se cuenta y queda a la vista.",
    comprueba: ["endpoint estable: concesiones-v1", "el consumidor recibe respuestas sin errores"],
    estimadoS: 9,
  },
  {
    titulo: "Una persona pide el cambio y otra lo aprueba",
    quePasa:
      "Desarrollo pide un despliegue gradual (canary) hacia el backend concesiones-v2. Si intenta aprobarlo ella misma, se rechaza; lo aprueba otra persona.",
    porQueImporta:
      "La regla de cuatro ojos evita que una sola persona ponga un cambio en producción sin revisión.",
    comprueba: ["quien solicita no puede aprobar (HTTP 403)", "aprobado por otra persona"],
    estimadoS: 14,
  },
  {
    titulo: "Falla real con el 25 % del tráfico: se revierte solo",
    quePasa:
      "concesiones-v2 recibe el 5 % y luego el 25 % del tráfico real. Ahí empieza a responder errores 500 y el controlador la retira solo, sin intervención.",
    porQueImporta:
      "Un defecto que solo aparece con carga real queda limitado a una parte del tráfico y a pocos segundos.",
    comprueba: [
      "reversión automática en el paso de 25 %",
      "errores solo mientras duró la falla",
      "el tráfico vuelve entero a concesiones-v1",
    ],
    estimadoS: 36,
  },
  {
    titulo: "Versión corregida: avanza 5 → 25 → 50 → 100 %",
    quePasa:
      "Con la falla corregida se repite el canary. En cada paso el controlador revisa errores y latencia del tráfico real antes de subir el porcentaje.",
    porQueImporta:
      "La versión nueva llega al 100 % solo si se comportó bien en cada etapa; mientras, el resto del tráfico sigue en la estable.",
    comprueba: [
      "canary completado al 100 %",
      "sin errores para el consumidor",
      "endpoint estable ahora: concesiones-v2",
    ],
    estimadoS: 62,
  },
  {
    titulo: "Blue-green: vuelta a concesiones-v1 de una vez",
    quePasa:
      "Un despliegue blue-green, también aprobado por otra persona, cambia todo el tráfico de una vez de vuelta al backend concesiones-v1.",
    porQueImporta:
      "Permite volver a una versión conocida en segundos y sin cortes para quienes consumen la API.",
    comprueba: [
      "blue-green completado",
      "sin errores durante el cambio",
      "ambos backends atendieron tráfico real",
    ],
    estimadoS: 28,
  },
];

async function chaos(failRate: number) {
  await fetch(reescribirUrlEnsayo(CHAOS_V2), {
    method: "POST",
    headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" },
    body: JSON.stringify({ failRate }),
  });
}

/** La misma inyección de falla, como comando real a la vista: curl contra el backend de demostración. */
async function chaosVisible(c: Contexto, failRate: number, comentario: string) {
  await comando(
    c,
    `curl -s -X POST -H 'x-chaos-token: nexo-lab-chaos' -H 'content-type: application/json' -d '{"failRate":${failRate}}' ${CHAOS_V2}   # ${comentario}`,
  );
}

let carga: CargaD | undefined;
/** Despliegues creados por la demostración (si algo falla, se detienen al limpiar). */
const creados: string[] = [];

export const d04: Demo = {
  id: "D-04",
  archivo: "D-04_canary_blue_green",
  nombre: "Despliegue canary y blue-green con reversión automática y sin corte",
  afirmacion:
    "Con un consumidor llamando sin pausa por el gateway, una versión que falla con el 25 % del tráfico real se revierte sola, la versión corregida avanza en canary 5 → 25 → 50 → 100 % y un blue-green devuelve el tráfico de una vez; cada cambio lo aprueba una persona distinta de quien lo pide.",
  pasos: PASOS_D04.length,
  agenda: agendaDe(PASOS_D04),
  usuarioInicial: "luis.aprobador",

  async preparar(c) {
    await prepararEnsayoD(c);
    await chaos(0);
    const apr = await tokenPersona("luis.aprobador");
    const rutas = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data;
    const ruta = rutas.find((r) => r.apiName.startsWith("Concesiones "));
    if (!ruta) throw new Error("La API Concesiones no pasa por nexo-division (make deploy-apis)");
    if (ruta.rolloutId) throw new Error("hay un despliegue en curso en la ruta de Concesiones");
    const notas = [
      "falla inyectable del backend concesiones-v2 en 0 %",
      "reglas del guardián de anomalías en pausa (tratarían la carga de prueba de 20 llamadas/s como abuso)",
    ];
    if (ruta.stableUrl !== V1) {
      const dev = await tokenPersona("ana.desarrollo");
      const r = await consola<Rollout>(dev, "POST", "/rollouts", {
        apiId: ruta.apiId,
        strategy: "blue_green",
        candidateEndpoint: V1,
        stepDurationSec: 10,
        thresholds: { ...UMBRALES, minRequests: 1 },
      });
      await consola(apr, "POST", `/rollouts/${r.data.id}/approve`);
      const fin = await esperarHasta(
        async () => (await consola<Rollout>(apr, "GET", `/rollouts/${r.data.id}`)).data,
        (x) => x.status !== "en_curso",
        120,
        2000,
      );
      notas.push(`ruta devuelta al backend estable concesiones-v1 (blue-green previo: ${fin?.valor.status})`);
    } else notas.push("ruta de Concesiones en producción con el backend estable concesiones-v1");
    return notas;
  },

  async ejecutar(c) {
    const e = c.estudio;
    const apr = await tokenPersona("luis.aprobador");
    const dev = await tokenPersona("ana.desarrollo");
    const ruta = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data.find((r) =>
      r.apiName.startsWith("Concesiones "),
    )!;
    const estado = async (id: string) => (await consola<Rollout>(apr, "GET", `/rollouts/${id}`)).data;
    const errores = () => carga?.errores() ?? 0;
    let pesoActual = 0;
    const indicadores = (peso?: number) => {
      if (peso !== undefined) pesoActual = peso;
      const b = carga?.porBackend() ?? {};
      e.indicadores({
        "llamadas a concesiones-v1": n(b["concesiones-v1"] ?? 0),
        "llamadas a concesiones-v2": n(b["concesiones-v2"] ?? 0),
        "errores del consumidor": errores(),
        "tráfico a concesiones-v2": `${pesoActual} %`,
      });
    };
    const reloj = setInterval(() => indicadores(), 2000);

    /** Crea el despliegue como desarrollo (API de la Consola) y lo muestra pendiente de aprobación. */
    const solicitar = async (cuerpo: Record<string, unknown>, resumen: string) => {
      c.log(`ana.desarrollo → POST /api/v1/rollouts  ${resumen}`, "cmd");
      const r = await consola<Rollout & { message?: string }>(dev, "POST", "/rollouts", {
        apiId: ruta.apiId,
        ...cuerpo,
      });
      if (r.status !== 201)
        throw new Error(`no se pudo crear el despliegue: ${r.status} ${r.data.message ?? ""}`);
      c.log(`  HTTP 201 · despliegue ${r.data.id} pendiente de aprobación`, "tenue");
      creados.push(r.data.id);
      await c.ir(`/despliegues/${r.data.id}`);
      await aparece(c.app.getByTestId("rollout-pending"), 20_000);
      return r.data.id;
    };
    /** Aprobación visible por luis.aprobador (la persona en pantalla). */
    const aprobar = async (id: string) => {
      await e.clic(c.app.getByTestId("btn-approve-rollout"));
      const ok = await esperarHasta(
        () => estado(id),
        (x) => x.status !== "pendiente_aprobacion",
        20,
        1000,
      );
      c.log(
        `  aprobado por ${ok?.valor.approvedBy ?? "luis.aprobador"} · estado ${ok?.valor.status}`,
        "tenue",
      );
      return ok?.valor;
    };
    const terminado = (x: Rollout) => x.status !== "en_curso" && x.status !== "pendiente_aprobacion";

    try {
      // ── 1. Producción estable ────────────────────────────────────────────────────────────────────
      await abrir(c, PASOS_D04[0]!);
      await c.ir("/despliegues");
      c.log(
        `ruta ${ruta.apiName} en nexo-division · endpoint estable ${ruta.stableUrl} (${backendDeUrl(ruta.stableUrl)})`,
        "tenue",
      );
      carga = cargaContinua(c, {
        url: URL,
        rps: 20,
        segundos: 230,
        etiqueta: "todo el escenario",
        cadaSeg: 4,
      });
      await c.esperar(5000);
      e.comprueba("endpoint estable: concesiones-v1", ruta.stableUrl === V1, ruta.stableUrl);
      const b0 = carga.porBackend();
      e.comprueba(
        "el consumidor recibe respuestas sin errores",
        errores() === 0 && (b0["concesiones-v1"] ?? 0) > 0,
        `${n(b0["concesiones-v1"] ?? 0)} respuestas de concesiones-v1 · ${errores()} errores`,
      );
      indicadores(0);

      // ── 2. Solicitud y aprobación con cuatro ojos ───────────────────────────────────────────────
      await abrir(c, PASOS_D04[1]!);
      const id1 = await solicitar(
        {
          strategy: "canary",
          candidateEndpoint: V2,
          shadowSeconds: 0,
          steps: [5, 25, 50, 100],
          stepDurationSec: 10,
          thresholds: UMBRALES,
        },
        "canary hacia concesiones-v2 · 5/25/50/100 % · pasos de 10 s · umbral de errores 2 %",
      );
      c.log(
        `ana.desarrollo → POST /api/v1/rollouts/${id1}/approve   # intenta aprobar su propia solicitud`,
        "cmd",
      );
      const propio = await consola<{ message?: string }>(dev, "POST", `/rollouts/${id1}/approve`);
      c.log(
        `  HTTP ${propio.status} · ${propio.data.message ?? ""}`,
        propio.status === 403 ? "aviso" : "mal",
      );
      e.comprueba(
        "quien solicita no puede aprobar (HTTP 403)",
        propio.status === 403,
        `HTTP ${propio.status}`,
      );
      await ampliar(c, c.app.getByTestId("rollout-pending"), 2400);
      const ap1 = await aprobar(id1);
      e.comprueba(
        "aprobado por otra persona",
        ap1?.status === "en_curso" && ap1.approvedBy !== undefined && ap1.approvedBy !== "ana.desarrollo",
        ap1?.approvedBy ?? ap1?.status ?? "sin respuesta",
      );

      // ── 3. Falla real al 25 %: reversión automática ─────────────────────────────────────────────
      await abrir(c, PASOS_D04[2]!);
      await desplazarSiHay(c, c.app.getByTestId("chart-weight"));
      const al25 = await esperarHasta(
        () => estado(id1),
        (x) => (x.currentWeight ?? 0) >= 25 || terminado(x),
        60,
        500,
      );
      indicadores(al25?.valor.currentWeight ?? 0);
      await c.esperar(2000); // tráfico real sano al 25 % antes de la falla
      const eAntes = errores();
      const tFalla = Date.now();
      await chaosVisible(c, 1, "desde ahora concesiones-v2 responde 500 a todo (falla real)");
      const rev = await esperarHasta(() => estado(id1), terminado, 60, 500);
      const tRev = Date.now();
      await chaosVisible(c, 0, "se corrige la falla");
      const r1 = rev?.valor;
      indicadores(0);
      c.log(
        `decisión del controlador: ${r1?.rollbackReason ?? r1?.status}`,
        r1?.status === "revertido" ? "aviso" : "mal",
      );
      await aparece(c.app.getByTestId("rollback-banner"), 10_000);
      await desplazarSiHay(c, c.app.getByTestId("rollback-banner"));
      await ampliar(c, c.app.getByTestId("rollback-banner"), 2800);
      const ultimo = r1?.stepsDone.at(-1);
      e.exige(
        "reversión automática en el paso de 25 %",
        r1?.status === "revertido" && (ultimo?.weight ?? 0) === 25,
        r1 ? `${r1.status} a los ${seg((tRev - tFalla) / 1000)} de empezar la falla` : "sin respuesta",
      );
      await c.esperar(3000);
      const eFalla = errores() - eAntes;
      const tras = carga.segundos.slice(-3);
      const limpios = tras.length > 0 && tras.every((s) => s.errores === 0);
      e.comprueba(
        "errores solo mientras duró la falla",
        eFalla > 0 && limpios,
        `${eFalla} errores en ${seg((tRev - tFalla) / 1000)} · después, 0`,
      );
      const rutaTras = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data.find(
        (r) => r.apiId === ruta.apiId,
      );
      const ult = tras.reduce((m, s) => ({ ...m, ...s.versiones }), {} as Record<string, number>);
      e.comprueba(
        "el tráfico vuelve entero a concesiones-v1",
        rutaTras?.stableUrl === V1 && !ult["1.1.0"],
        `estable ${backendDeUrl(rutaTras?.stableUrl)} · últimos 3 s sin concesiones-v2`,
      );

      // ── 4. Canary corregido 5 → 25 → 50 → 100 % ─────────────────────────────────────────────────
      await abrir(c, PASOS_D04[3]!);
      const e2 = errores();
      const id2 = await solicitar(
        {
          strategy: "canary",
          candidateEndpoint: V2,
          shadowSeconds: 5,
          steps: [5, 25, 50, 100],
          stepDurationSec: 10,
          thresholds: UMBRALES,
        },
        "canary corregido hacia concesiones-v2 · sombra 5 s · 5/25/50/100 %",
      );
      await aprobar(id2);
      await desplazarSiHay(c, c.app.getByTestId("rollout-weight"));
      let pesoVisto = -1;
      const t2 = Date.now();
      const fin2 = await esperarHasta(
        async () => {
          const x = await estado(id2);
          const peso = x.currentWeight ?? 0;
          if (peso !== pesoVisto) {
            pesoVisto = peso;
            indicadores(peso);
            c.log(`peso de concesiones-v2: ${peso} % · ${x.status}`, "tenue");
            if (peso === 50) void ampliar(c, c.app.getByTestId("rollout-weight"), 2200, 1.6);
          }
          return x;
        },
        terminado,
        150,
        1000,
      );
      const seg2 = (Date.now() - t2) / 1000;
      await aparece(c.app.getByTestId("rollout-completed"), 15_000);
      await desplazarSiHay(c, c.app.getByTestId("chart-weight"));
      await ampliar(c, c.app.getByTestId("chart-weight"), 2600, 1.5);
      const r2 = fin2?.valor;
      const plan = r2?.stepsDone.map((s) => (s.kind === "sombra" ? "sombra" : `${s.weight} %`)).join(" → ");
      e.exige("canary completado al 100 %", r2?.status === "completado", `${plan ?? "?"} en ${seg(seg2, 0)}`);
      e.comprueba("sin errores para el consumidor", errores() - e2 === 0, `${errores() - e2} errores`);
      await e.desplazar(-2000).catch(() => undefined);
      const tarjeta = c.app.getByText("Endpoint estable", { exact: true }).first().locator("..");
      const rutaV2 = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data.find(
        (r) => r.apiId === ruta.apiId,
      );
      await ampliar(c, tarjeta, 2400);
      e.comprueba(
        "endpoint estable ahora: concesiones-v2",
        rutaV2?.stableUrl === V2,
        rutaV2?.stableUrl ?? "sin ruta",
      );

      // ── 5. Blue-green de vuelta ─────────────────────────────────────────────────────────────────
      await abrir(c, PASOS_D04[4]!);
      const e4 = errores();
      const id3 = await solicitar(
        { strategy: "blue_green", candidateEndpoint: V1, stepDurationSec: 10, thresholds: UMBRALES },
        "blue-green hacia concesiones-v1 · todo el tráfico de una vez",
      );
      await aprobar(id3);
      const t3 = Date.now();
      const fin3 = await esperarHasta(() => estado(id3), terminado, 90, 1000);
      const seg3 = (Date.now() - t3) / 1000;
      await aparece(c.app.getByTestId("rollout-completed"), 15_000);
      e.comprueba("blue-green completado", fin3?.valor.status === "completado", `en ${seg(seg3, 0)}`);
      await c.esperar(3000);
      carga.detener();
      const total = await carga.resultado;
      clearInterval(reloj);
      indicadores(0);
      e.comprueba("sin errores durante el cambio", errores() - e4 === 0, `${errores() - e4} errores`);
      const v1 = total.porVersion["1.0.0"] ?? 0;
      const v2 = total.porVersion["1.1.0"] ?? 0;
      c.log(
        `resumen del consumidor: ${n(total.llamadas)} llamadas · ${n(total.ok)} con 2xx · ${total.errores} errores (todos durante la falla del paso 3) · concesiones-v1: ${n(v1)} · concesiones-v2: ${n(v2)}`,
        "ok",
      );
      e.comprueba(
        "ambos backends atendieron tráfico real",
        v1 > 0 && v2 > 0 && total.errores === eFalla,
        `${n(total.llamadas)} llamadas · ${total.errores} errores, solo durante la falla`,
      );
      await c.ir("/despliegues");
      await e.esperar(2500);

      return {
        medido: `${n(total.llamadas)} llamadas del consumidor: la falla con el 25 % del tráfico se revirtió sola en ${seg((tRev - tFalla) / 1000)} (${total.errores} errores, solo en ese tramo); el canary corregido llegó al 100 % en ${seg(seg2, 0)} y el blue-green volvió en ${seg(seg3, 0)} sin errores`,
        datos: {
          llamadas: total.llamadas,
          errores: total.errores,
          porBackend: { "concesiones-v1": v1, "concesiones-v2": v2 },
          segReversionDesdeFalla: Math.round((tRev - tFalla) / 100) / 10,
          segCanary: Math.round(seg2),
          segBlueGreen: Math.round(seg3),
          motivoReversion: r1?.rollbackReason,
        },
      };
    } finally {
      clearInterval(reloj);
    }
  },

  async limpiar() {
    carga?.detener();
    carga = undefined;
    await chaos(0);
    const apr = await tokenPersona("luis.aprobador");
    for (const id of creados.splice(0)) {
      const r = (await consola<Rollout>(apr, "GET", `/rollouts/${id}`)).data;
      if (r.status === "en_curso" || r.status === "pendiente_aprobacion")
        await consola(apr, "POST", `/rollouts/${id}/abort`, {
          reason: "Demostración interrumpida: se detiene y revierte",
        });
    }
  },
};
