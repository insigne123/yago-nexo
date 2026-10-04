/**
 * D-04 · Despliegue canary y blue-green con reversión automática y sin corte de servicio.
 * Con carga continua a través del gateway (OAuth con Keycloak), tres despliegues de la API Concesiones por
 * nexo-division (Envoy): una versión defectuosa que el controlador revierte solo, la versión corregida en
 * canary 5/25/50/100 % y un blue-green de vuelta. Cada uno lo solicita desarrollo y lo aprueba otra persona.
 */
import { fetch } from "undici";
import type { Demo } from "../lib/grabador.js";
import { consola, GATEWAY, tokenPersona } from "../lib/lab.js";
import { iniciarCarga, type CargaEnCurso } from "./carga.js";
import { esperarHasta } from "./comun.js";

const URL = `${GATEWAY}/concesiones/1.0.0/concesiones`;
const V1 = "http://concesiones-v1:7001";
const V2 = "http://concesiones-v2:7001";
const CHAOS_V2 = process.env.NEXO_LAB_CHAOS_V2 ?? "http://localhost:7011/_chaos";
type Ruta = { apiId: string; apiName: string; stableUrl: string; rolloutId?: string };
type Rollout = { id: string; status: string; rollbackReason?: string; currentWeight?: number; stepsDone: Array<{ kind: string; weight: number; requests: number; decision: string; errorRate?: number }> };

async function chaos(failRate: number) {
  await fetch(CHAOS_V2, { method: "POST", headers: { "x-chaos-token": "nexo-lab-chaos", "content-type": "application/json" }, body: JSON.stringify({ failRate }) });
}

let carga: CargaEnCurso | undefined;
/** Despliegues creados por la demostración (si algo falla, se detienen al limpiar). */
const creados: string[] = [];

export const d04: Demo = {
  id: "D-04",
  archivo: "D-04_canary_blue_green",
  nombre: "Despliegue canary y blue-green con reversión automática y sin corte",
  afirmacion:
    "Con consumidores llamando sin pausa por el gateway, una versión defectuosa se revierte sola durante su fase sombra, la versión corregida avanza en canary 5 → 25 → 50 → 100 % y un blue-green devuelve el tráfico de una vez, sin que ningún consumidor reciba un error.",
  pasos: 5,
  usuarioInicial: "luis.aprobador",

  async preparar() {
    await chaos(0);
    const apr = await tokenPersona("luis.aprobador");
    const rutas = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data;
    const ruta = rutas.find((r) => r.apiName.startsWith("Concesiones "));
    if (!ruta) throw new Error("La API Concesiones no pasa por nexo-division (make deploy-apis)");
    if (ruta.rolloutId) throw new Error("hay un despliegue en curso en la ruta de Concesiones");
    const notas = ["falla inyectable del backend 1.1.0 en 0 %", "reglas del guardián de anomalías en pausa (tratarían la carga de prueba de 20 llamadas/s como abuso)"];
    if (ruta.stableUrl !== V1) {
      const dev = await tokenPersona("ana.desarrollo");
      const r = await consola<Rollout>(dev, "POST", "/rollouts", { apiId: ruta.apiId, strategy: "blue_green", candidateEndpoint: V1, stepDurationSec: 10, thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 1 } });
      await consola(apr, "POST", `/rollouts/${r.data.id}/approve`);
      const fin = await esperarHasta(async () => (await consola<Rollout>(apr, "GET", `/rollouts/${r.data.id}`)).data, (x) => x.status !== "en_curso", 120, 2000);
      notas.push(`ruta devuelta a la versión estable 1.0.0 (blue-green previo: ${fin?.valor.status})`);
    } else notas.push("ruta de Concesiones en producción con la versión estable 1.0.0");
    return notas;
  },

  async ejecutar(c) {
    const apr = await tokenPersona("luis.aprobador");
    const dev = await tokenPersona("ana.desarrollo");
    const ruta = (await consola<Ruta[]>(apr, "GET", "/traffic-routes")).data.find((r) => r.apiName.startsWith("Concesiones "))!;

    c.paso("Concesiones en producción pasa por nexo-division (Envoy); los consumidores llaman sin pausa");
    await c.ir("/despliegues");
    c.log(`ruta ${ruta.apiName}: estable ${ruta.stableUrl}`, "tenue");
    carga = iniciarCarga(c, { url: URL, rps: 20, segundos: 175, etiqueta: "consumidor OperadorDemo, todo el escenario", cadaSeg: 4 });
    await c.esperar(5000);

    const desplegar = async (cuerpo: Record<string, unknown>, titulo: string) => {
      c.log(`$ POST /api/v1/rollouts  (ana.desarrollo, pipeline)  ${titulo}`, "cmd");
      const r = await consola<Rollout & { message?: string }>(dev, "POST", "/rollouts", { apiId: ruta.apiId, ...cuerpo });
      if (r.status !== 201) throw new Error(`no se pudo crear el despliegue: ${r.status} ${r.data.message ?? ""}`);
      creados.push(r.data.id);
      await c.ir(`/despliegues/${r.data.id}`);
      await c.app.getByTestId("rollout-pending").waitFor();
      await c.esperar(1200);
      await c.clic(c.app.getByTestId("btn-approve-rollout"));
      c.log(`aprobado por luis.aprobador (regla de cuatro ojos: quien solicita no aprueba)`, "tenue");
      const t0 = Date.now();
      const fin = await esperarHasta(async () => (await consola<Rollout>(apr, "GET", `/rollouts/${r.data.id}`)).data, (x) => x.status !== "en_curso" && x.status !== "pendiente_aprobacion", 150, 2000);
      const seg = Math.round((Date.now() - t0) / 1000);
      return { r: fin?.valor, seg };
    };
    const erroresHasta = () => carga!.segundos.reduce((n, s) => n + s.errores, 0);

    c.paso("Versión 1.1.0 defectuosa: canary con fase sombra (recibe copias del tráfico real)");
    c.log("$ inyectar falla en el backend 1.1.0: 100 % de respuestas 500   # simula un error de la versión nueva", "cmd");
    await chaos(1);
    const e0 = erroresHasta();
    const mala = await desplegar(
      { strategy: "canary", candidateEndpoint: V2, shadowSeconds: 20, steps: [5, 25, 50, 100], stepDurationSec: 10, thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 10 } },
      "canary 1.1.0 · sombra 20 s · 5/25/50/100 %",
    );
    await chaos(0);
    c.rotulo("El controlador detectó los errores en la sombra y revirtió solo; los consumidores no vieron ninguno");
    await c.app.getByTestId("rollback-banner").waitFor({ timeout: 20_000 }).catch(() => undefined);
    await c.esperar(3500);
    const e1 = erroresHasta();
    c.log(`decisión del controlador: ${mala.r?.rollbackReason ?? mala.r?.status}`, mala.r?.status === "revertido" ? "aviso" : "mal");
    c.exigir("versión defectuosa revertida automáticamente en la sombra", mala.r?.status === "revertido" && mala.r.stepsDone.at(-1)?.kind === "sombra", `${mala.r?.status} a los ${mala.seg} s`);
    c.verificar("ningún error para los consumidores durante la reversión", e1 - e0 === 0, `${e1 - e0} errores`);

    c.paso("Versión 1.1.0 corregida: canary 5 → 25 → 50 → 100 % según errores y latencia");
    const e2 = erroresHasta();
    const buena = await desplegar(
      { strategy: "canary", candidateEndpoint: V2, shadowSeconds: 10, steps: [5, 25, 50, 100], stepDurationSec: 10, thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 8 } },
      "canary 1.1.0 · sombra 10 s · 5/25/50/100 % · pasos de 10 s",
    );
    await c.app.getByTestId("rollout-completed").waitFor({ timeout: 20_000 }).catch(() => undefined);
    await c.app.mouse.move(600, 400);
    await c.app.mouse.wheel(0, 380);
    await c.esperar(3000);
    const e3 = erroresHasta();
    const plan = buena.r?.stepsDone.map((s) => (s.kind === "sombra" ? "sombra" : `${s.weight}%`)).join(" → ");
    c.exigir("canary completado: la versión nueva recibe el 100 %", buena.r?.status === "completado", `${plan} en ${buena.seg} s`);
    c.verificar("sin errores para los consumidores durante el canary", e3 - e2 === 0, `${e3 - e2} errores`);

    c.paso("Blue-green: el tráfico vuelve a 1.0.0 de una sola vez");
    const e4 = erroresHasta();
    const bg = await desplegar({ strategy: "blue_green", candidateEndpoint: V1, stepDurationSec: 10, thresholds: { maxErrorRate: 0.02, maxP99Ms: 800, minRequests: 8 } }, "blue-green → 1.0.0");
    await c.esperar(3000);
    carga.detener();
    const total = await carga.resultado;
    const e5 = erroresHasta();
    c.verificar("blue-green completado", bg.r?.status === "completado", `en ${bg.seg} s`);
    c.verificar("sin errores durante el blue-green", e5 - e4 === 0, `${e5 - e4} errores`);
    const v1 = total.porVersion["1.0.0"] ?? 0;
    const v11 = total.porVersion["1.1.0"] ?? 0;
    c.log(`resumen de la carga: ${total.llamadas} llamadas · ${total.ok} con 2xx · ${total.errores} errores · 1.0.0: ${v1} · 1.1.0: ${v11}`, total.errores ? "mal" : "ok");
    c.verificar("ambas versiones atendieron y el servicio no se cortó", total.errores === 0 && v1 > 0 && v11 > 0, `${total.llamadas} llamadas, ${total.errores} errores`);
    await c.ir("/despliegues");
    await c.esperar(3000);

    return {
      medido: `${total.llamadas} llamadas de consumidores, 0 errores: reversión automática en ${mala.seg} s, canary completo en ${buena.seg} s y blue-green en ${bg.seg} s`,
      datos: { llamadas: total.llamadas, errores: total.errores, porVersion: total.porVersion, segReversion: mala.seg, segCanary: buena.seg, segBlueGreen: bg.seg, motivoReversion: mala.r?.rollbackReason },
    };
  },

  async limpiar() {
    carga?.detener();
    carga = undefined;
    await chaos(0);
    const apr = await tokenPersona("luis.aprobador");
    for (const id of creados.splice(0)) {
      const r = (await consola<Rollout>(apr, "GET", `/rollouts/${id}`)).data;
      if (r.status === "en_curso" || r.status === "pendiente_aprobacion") await consola(apr, "POST", `/rollouts/${id}/abort`, { reason: "Demostración interrumpida: se detiene y revierte" });
    }
  },
};
