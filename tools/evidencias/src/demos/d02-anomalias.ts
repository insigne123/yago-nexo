/**
 * D-02 · Detección de anomalías de consumo por comportamiento, con alerta y bloqueo configurable, en 4 partes
 * (V14):
 *   1. la línea base: el guardián compara cada ventana de 30 s con las 60 anteriores (61 ventanas, ≈ 31 min).
 *      Antes de grabar corren 31 min de tráfico normal de dos consumidores: A (OperadorDemo, 2 llamadas/s) y
 *      B (ConsumidorAltoVolumen, 25 llamadas/s). Se mide en la analítica del gateway y se declara en pantalla;
 *   2. el administrador configura la regla en la Consola (volumen, sensibilidad, bloqueo automático por 2 min);
 *   3. A irrumpe con 20 llamadas/s: el guardián lo detecta contra SU línea base, alerta y lo bloquea en el
 *      gateway (política de denegación de WSO2), mientras B, que llama aún más pero como siempre, sigue atendido;
 *   4. un aprobador, con su propia sesión, libera el bloqueo; el acceso vuelve y todo queda en la auditoría.
 *
 * Línea base (antes de grabar; dejarla correr hasta que empiece D-02, p. ej. 45 min si D-02 va 10 min después):
 *   pnpm --filter @nexo/evidencias exec tsx src/demos/d02-anomalias.ts --linea-base 45
 * preparar() mide en la analítica que A y B tengan tráfico en las 60 ventanas previas y, si falta, no graba;
 * desde ahí mantiene el tráfico normal de A y B hasta la ráfaga, para que no quede un hueco.
 * Duración estimada del video: ≈ 185 s (ver ayudas-d.test.ts).
 */
import { pathToFileURL } from "node:url";
import { setTimeout as dormir } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { Contexto, Demo } from "../lib/grabador.js";
import { consola, credencialesDe, GATEWAY, tokenAplicacion, tokenPersona, wso2 } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";
import {
  abrir,
  agendaDe,
  alertasVigentes,
  ampliar,
  aparece,
  asegurarConsumidor,
  cargaContinua,
  clicSiHay,
  curl,
  n,
  seg,
  ventanasConTrafico,
  type CargaD,
  type PasoGuion,
} from "./ayudas-d.js";
import { nuevaSesionD, prepararEnsayoD } from "./d0x-ensayo.js";

const URL = `${GATEWAY}/concesiones/1.0.0/concesiones`;
const URL_MOSTRADA = "https://apim:8243/concesiones/1.0.0/concesiones";
const A = "OperadorDemo";
const B = "ConsumidorAltoVolumen";
/** Llamadas por segundo de tráfico normal de cada consumidor (línea base y video). */
export const RPS_NORMAL: Readonly<Record<string, number>> = { [A]: 2, [B]: 25 };
const RPS_RAFAGA = 20;
/** Ventanas que usa el guardián: la actual y 60 anteriores de 30 s (laboratorio: NEXO_GUARDIAN_WINDOW_SEC=30). */
export const VENTANAS_LINEA_BASE = 61;
export const VENTANA_S = 30;

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  metric: string;
  sensitivity: number;
  minVolume: number;
  action: string;
  blockTtlMinutes: number;
  apiId?: string;
};
type Anomaly = {
  id: string;
  ruleId: string;
  status: string;
  blockId?: string;
  observed: number;
  baseline: number;
  score: number;
  consumer?: string;
};
type Block = { id: string; active: boolean; conditionValue: string; releasedBy?: string; expiresAt?: string };

export const PASOS_D02: PasoGuion[] = [
  {
    titulo: "Parte 1 · La línea base: 31 min de tráfico normal",
    quePasa:
      "Durante 31 min antes de grabar, A llamó 2 veces por segundo y B, de alto volumen, 25. Cada ventana de 30 s se compara con las 60 anteriores.",
    porQueImporta:
      "Cada consumidor se compara con su propio comportamiento, no con un umbral fijo igual para todos.",
    comprueba: [
      "consumidor A: 60 de 60 ventanas previas con tráfico",
      "consumidor B: 60 de 60 ventanas previas con tráfico",
    ],
    estimadoS: 12,
  },
  {
    titulo: "Parte 2 · El administrador configura la regla",
    quePasa:
      "En la Consola crea la regla: volumen anómalo en la API Concesiones, con su sensibilidad y un mínimo de llamadas; si se cumple, bloquea 2 minutos.",
    porQueImporta:
      "La institución decide qué se vigila y qué se hace: solo alertar, bloquear con aprobación o bloquear de inmediato.",
    comprueba: ["regla creada y activa"],
    estimadoS: 30,
  },
  {
    titulo: "Parte 3 · Ráfaga de A: alerta y bloqueo en el gateway",
    quePasa:
      "A pasa de 2 a 20 llamadas por segundo. El guardián lo compara con su línea base, lo bloquea en el gateway y avisa. B sigue atendido como siempre.",
    porQueImporta:
      "Un abuso o una aplicación descontrolada se corta sola, sin afectar a quien consume de forma normal.",
    comprueba: [
      "A bloqueado en el gateway (HTTP 403)",
      "B sigue atendido sin rechazos",
      "política de denegación activa en WSO2",
      "evento con lo observado y su línea base",
      "alerta enviada",
    ],
    estimadoS: 80,
  },
  {
    titulo: "Parte 4 · Un aprobador libera el bloqueo",
    quePasa:
      "Otra persona, con su propia sesión, revisa el caso y libera el bloqueo indicando el motivo. El consumidor A vuelve a recibir respuestas.",
    porQueImporta: "El bloqueo es reversible y cada decisión queda registrada con quién la tomó y por qué.",
    comprueba: [
      "bloqueo liberado por el aprobador",
      "acceso restablecido (HTTP 200)",
      "bloqueo y liberación en la auditoría",
    ],
    estimadoS: 40,
  },
];

let previas: Rule[] = [];
let nuestra: string | undefined;
let adminWso2: Page | undefined;
let cargaB: CargaD | undefined;
let cargaA: CargaD | undefined;

async function activar(tok: string, r: Rule, enabled: boolean) {
  await consola(tok, "PATCH", `/anomaly-rules/${r.id}`, {
    name: r.name,
    apiId: r.apiId,
    metric: r.metric,
    sensitivity: r.sensitivity,
    minVolume: r.minVolume,
    action: r.action,
    blockTtlMinutes: r.blockTtlMinutes,
    enabled,
  });
}

/** Mueve el control deslizante de la sensibilidad con el teclado visible hasta el valor pedido. */
async function sensibilidad(c: Contexto, valor: number) {
  const r = c.app.getByTestId("rule-sensitivity");
  if (!(await aparece(r, 3000))) return;
  await c.estudio.clic(r);
  for (let i = 0; i < 12; i++) {
    const actual = Number(await r.inputValue().catch(() => String(valor)));
    if (Math.abs(actual - valor) < 0.25) return;
    await c.estudio.tecla(actual < valor ? "ArrowRight" : "ArrowLeft");
  }
  await r.fill(String(valor)).catch(() => undefined);
}

export const d02: Demo = {
  id: "D-02",
  archivo: "D-02_anomalias",
  nombre: "Detección de anomalías de consumo con alerta y bloqueo configurable",
  afirmacion:
    "El guardián compara el consumo de cada consumidor con su propia línea base (61 ventanas de 30 s, unos 31 min de tráfico normal); ante una ráfaga anómala alerta y, según la regla, lo bloquea en el gateway hasta que un aprobador lo libere o venza el bloqueo, sin afectar a los consumidores que se comportan como siempre.",
  pasos: PASOS_D02.length,
  agenda: agendaDe(PASOS_D02),
  usuarioInicial: "admin.nexo",

  async preparar(c) {
    await prepararEnsayoD(c);
    const notas: string[] = [];
    notas.push(
      ...(await asegurarConsumidor(
        B,
        "Sistema de reportes masivos de un operador (sintético, alto volumen)",
        "Concesiones",
        "Unlimited",
      )),
    );
    // La línea base se genera ANTES de grabar (≥ 31 min); aquí solo se mide y, si falta, no se graba.
    const base = await ventanasConTrafico({
      apiNombre: "Concesiones",
      aplicaciones: [A, B],
      ventanaS: VENTANA_S,
      n: VENTANAS_LINEA_BASE - 1,
    });
    for (const app of [A, B]) {
      const v = base[app]!;
      if (v.ventanas < VENTANAS_LINEA_BASE - 1)
        throw new Error(
          `línea base insuficiente para ${app}: ${v.ventanas} de ${VENTANAS_LINEA_BASE - 1} ventanas de ${VENTANA_S} s con tráfico. Antes de grabar: pnpm --filter @nexo/evidencias exec tsx src/demos/d02-anomalias.ts --linea-base 32`,
        );
      notas.push(
        `línea base de ${app}: ${v.ventanas} ventanas de ${VENTANA_S} s con tráfico (≈ ${v.porVentana} llamadas por ventana)`,
      );
    }
    const adm = await tokenPersona("admin.nexo");
    previas = (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data.filter((r) => r.enabled);
    for (const r of previas) await activar(adm, r, false);
    const apr = await tokenPersona("luis.aprobador");
    for (const b of (await consola<Block[]>(apr, "GET", "/blocks")).data.filter((x) => x.active))
      await consola(apr, "POST", `/blocks/${b.id}/release`, {
        reason: "Preparación de la demostración D-02",
      });
    // A y B siguen llamando como siempre hasta la ráfaga (su tráfico normal no se interrumpe al grabar).
    cargaB = cargaContinua(c, {
      url: URL,
      rps: RPS_NORMAL[B]!,
      segundos: 600,
      etiqueta: "consumidor B, tráfico normal",
      cadaSeg: 1000,
      app: B,
    });
    cargaA = cargaContinua(c, {
      url: URL,
      rps: RPS_NORMAL[A]!,
      segundos: 600,
      etiqueta: "consumidor A, tráfico normal",
      cadaSeg: 1000,
    });
    const sesionWso2 = await nuevaSesionD(c);
    // Si el Admin Portal no responde, el video sigue sin esa vista (la política se verifica igual por el 403).
    await c
      .ingresarWso2("admin", "admin", undefined, sesionWso2)
      .then(() => (adminWso2 = sesionWso2))
      .catch((err: unknown) =>
        notas.push(
          `Admin Portal de WSO2 no disponible: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
        ),
      );
    notas.push(
      "otras reglas del guardián en pausa: solo actúa la regla que se configura en el video",
      "sin bloqueos activos en el gateway al empezar",
    );
    return notas;
  },

  async ejecutar(c) {
    const e = c.estudio;
    const adm = await tokenPersona("admin.nexo");
    const apr = await tokenPersona("luis.aprobador");
    const tokenA = await tokenAplicacion(await credencialesDe(A));
    const apis = (
      await consola<Array<{ id: string; wso2ApiId: string; name: string }>>(apr, "GET", "/apis?q=Concesiones")
    ).data;
    if (!apis.find((a) => a.name === "Concesiones"))
      throw new Error("falta la API Concesiones en el catálogo");
    const erroresB0 = cargaB?.errores() ?? 0;

    // ── Parte 1 · Línea base ───────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D02[0]!);
    await c.ir("/anomalias?pestana=eventos");
    c.log(
      `GET ${"http://localhost:9200"}/nexo-apim-metrics-*/_search   # analítica del gateway: ventanas de ${VENTANA_S} s con tráfico, últimas ${VENTANAS_LINEA_BASE}`,
      "cmd",
    );
    const base = await ventanasConTrafico({
      apiNombre: "Concesiones",
      aplicaciones: [A, B],
      ventanaS: VENTANA_S,
      n: VENTANAS_LINEA_BASE - 1,
    });
    for (const app of [A, B])
      c.log(
        `  ${app}: ${base[app]!.ventanas} ventanas con tráfico · ${n(base[app]!.llamadas)} llamadas · ≈ ${n(base[app]!.porVentana)} por ventana`,
        base[app]!.ventanas >= VENTANAS_LINEA_BASE - 1 ? "ok" : "mal",
      );
    e.indicadores({
      "A · llamadas por ventana": n(base[A]!.porVentana),
      "B · llamadas por ventana": n(base[B]!.porVentana),
      "ventanas de línea base": `${VENTANAS_LINEA_BASE} × ${VENTANA_S} s`,
    });
    // La línea base son las 60 ventanas completas anteriores a la actual (61 con la actual, ≈ 31 min).
    e.comprueba(
      "consumidor A: 60 de 60 ventanas previas con tráfico",
      base[A]!.ventanas >= VENTANAS_LINEA_BASE - 1,
      `${base[A]!.ventanas} de 60 · ≈ ${n(base[A]!.porVentana)} llamadas por ventana`,
    );
    e.comprueba(
      "consumidor B: 60 de 60 ventanas previas con tráfico",
      base[B]!.ventanas >= VENTANAS_LINEA_BASE - 1,
      `${base[B]!.ventanas} de 60 · ≈ ${n(base[B]!.porVentana)} llamadas por ventana`,
    );
    await e.esperar(3500); // lectura de la línea base declarada

    // ── Parte 2 · Regla ────────────────────────────────────────────────────────────────────────────
    await abrir(c, PASOS_D02[1]!);
    const NOMBRE = `Ráfaga de consumo en Concesiones (${c.hora().slice(0, 5)})`;
    await c.ir("/anomalias?pestana=reglas");
    await e.clic(c.app.getByTestId("btn-new-rule"));
    await aparece(c.app.getByTestId("rule-form"), 10_000);
    await e.escribir(c.app.getByTestId("rule-name"), NOMBRE, { ms: 45 });
    await e.elegir(c.app.getByTestId("rule-api"), /^Concesiones/);
    await e.elegir(c.app.getByTestId("rule-metric"), "volumen");
    await sensibilidad(c, 6);
    await e.escribir("#rule-min-volume", "30");
    await e.elegir(c.app.getByTestId("rule-action"), "bloquear_automatico");
    await e.escribir("#rule-ttl", "2");
    await e.clic(c.app.getByTestId("btn-save-rule"));
    const regla = await esperarHasta(
      async () =>
        (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data.find(
          (r) => r.name === NOMBRE && r.enabled,
        ),
      (r) => !!r,
      15,
    );
    nuestra = regla?.valor?.id;
    e.exige(
      "regla creada y activa",
      !!regla?.valor,
      regla?.valor
        ? `volumen · sensibilidad ${regla.valor.sensitivity} · mínimo ${regla.valor.minVolume} · bloqueo de ${regla.valor.blockTtlMinutes} min`
        : "no encontrada",
    );

    // ── Parte 3 · Ráfaga, bloqueo y alerta ─────────────────────────────────────────────────────────
    await abrir(c, PASOS_D02[2]!);
    await clicSiHay(c, c.app.getByTestId("tab-eventos"));
    cargaA?.detener();
    const t0 = Date.now();
    let bloqueadoEn: number | undefined;
    const rafaga = cargaContinua(c, {
      url: URL,
      rps: RPS_RAFAGA,
      segundos: 150,
      etiqueta: "consumidor A, ráfaga anómala",
      cadaSeg: 3,
    });
    const vigilar = setInterval(() => {
      const s = rafaga.segundos.at(-1);
      e.indicadores({
        "A · llamadas por segundo": s ? s.ok + s.errores : 0,
        "A · rechazadas": rafaga.errores(),
        "B · errores": (cargaB?.errores() ?? 0) - erroresB0,
      });
      if (s && s.ok === 0 && s.errores > 0 && bloqueadoEn === undefined) {
        bloqueadoEn = Date.now();
        setTimeout(() => rafaga.detener(), 3000);
      }
    }, 500);
    const rr = await rafaga.resultado;
    clearInterval(vigilar);
    const segBloqueo = bloqueadoEn ? (bloqueadoEn - t0) / 1000 : undefined;
    c.log(
      `códigos que recibió A: ${Object.entries(rr.porCodigo)
        .map(([k, v]) => `${k}×${v}`)
        .join("  ")}`,
    );
    const r403 = await curl(c, URL_MOSTRADA, { token: tokenA, comentario: "consumidor A tras el bloqueo" });
    e.exige(
      "A bloqueado en el gateway (HTTP 403)",
      segBloqueo !== undefined && r403.status === 403,
      segBloqueo !== undefined
        ? `HTTP ${r403.status ?? "?"} a los ${seg(segBloqueo, 0)} de empezar la ráfaga`
        : "sin bloqueo",
    );
    const erroresB = (cargaB?.errores() ?? 0) - erroresB0;
    const okB =
      cargaB?.segundos.slice(-Math.ceil((Date.now() - t0) / 1000)).reduce((s, x) => s + x.ok, 0) ?? 0;
    e.comprueba(
      "B sigue atendido sin rechazos",
      erroresB === 0 && okB > 0,
      `${n(okB)} respuestas a B durante la ráfaga · ${erroresB} rechazos`,
    );
    c.log(
      "admin → GET https://apim:9443/api/am/admin/v4/throttling/deny-policies   # políticas de denegación vigentes en WSO2",
      "cmd",
    );
    const denegaciones = await wso2()
      .request<{
        list?: Array<{ conditionType?: string; conditionValue?: string; conditionStatus?: boolean }>;
      }>({ method: "GET", path: "/api/am/admin/v4/throttling/deny-policies" })
      .catch(() => ({ list: [] }));
    const politica = (denegaciones.list ?? []).find(
      (p) => String(p.conditionValue ?? "").endsWith(A) && p.conditionStatus !== false,
    );
    e.comprueba(
      "política de denegación activa en WSO2",
      !!politica,
      politica
        ? `${politica.conditionType ?? "APPLICATION"} · ${politica.conditionValue}`
        : "sin política para A",
    );
    const ev = (await consola<Anomaly[]>(apr, "GET", "/anomalies")).data.find((x) => x.ruleId === nuestra);
    await c.app.reload();
    await aparece(c.app.getByTestId("table-anomalies").locator("tbody tr").first(), 15_000);
    await ampliar(c, c.app.getByTestId("table-anomalies").locator("tbody tr").first(), 3000, 1.5);
    e.comprueba(
      "evento con lo observado y su línea base",
      ev?.status === "bloqueada" && ev.baseline > 0,
      ev
        ? `${n(Math.round(ev.observed))} llamadas en la ventana frente a una línea base de ${n(Math.round(ev.baseline))} · puntaje ${ev.score}`
        : "sin evento",
    );
    const alerta = (await alertasVigentes().catch(() => [])).find(
      (a) => a.labels.alertname === "ConsumidorBloqueado",
    );
    if (alerta)
      c.log(
        `Alertmanager: ${alerta.labels.alertname} [${alerta.labels.severidad ?? ""}] ${alerta.annotations.resumen ?? ""}`.slice(
          0,
          200,
        ),
        "aviso",
      );
    e.comprueba(
      "alerta enviada",
      !!alerta,
      alerta ? `ConsumidorBloqueado · ${alerta.labels.consumidor ?? A}` : "sin alerta en Alertmanager",
    );
    await clicSiHay(c, c.app.getByTestId("tab-bloqueos"));
    await e.esperar(1500);
    if (adminWso2) {
      await c.mostrar(adminWso2);
      await e.mover({ x: 420, y: 160, width: 20, height: 20 }); // el cursor se mueve: la página quieta vuelve a pintarse
      // Vista de apoyo (el bloqueo ya se midió con el 403): si el menú no aparece, se sigue sin ella.
      const menu = adminWso2.getByText(/Deny Policies|Políticas de denegación/).first();
      if (await aparece(menu, 8000)) {
        await e.clic(menu);
        await aparece(adminWso2.getByText(new RegExp(A)).first(), 15_000);
        await ampliar(c, adminWso2.getByText(new RegExp(A)).first(), 2400);
      }
    }

    // ── Parte 4 · Liberación por un aprobador ──────────────────────────────────────────────────────
    await abrir(c, PASOS_D02[3]!);
    const pantalla = await nuevaSesionD(c);
    await c.mostrar(pantalla);
    await c.ingresarConsola("luis.aprobador");
    await c.ir("/anomalias?pestana=bloqueos");
    const bloqueo =
      (await consola<Block[]>(apr, "GET", "/blocks")).data.find((b) => b.id === ev?.blockId) ??
      (await consola<Block[]>(apr, "GET", "/blocks")).data.find((b) => b.active);
    await e.clic(c.app.getByTestId(`btn-release-${bloqueo?.id ?? ""}`));
    await e.escribir(
      c.app.getByTestId("release-dialog-reason"),
      "Consumidor contactado: la ráfaga fue una carga masiva",
      { ms: 45 },
    );
    await e.clic(c.app.getByTestId("release-dialog-confirm"));
    const tLib = Date.now();
    let vuelta: number | undefined;
    for (let i = 0; i < 40 && vuelta === undefined; i++) {
      const r = await curl(c, URL_MOSTRADA, { token: tokenA, comentario: "consumidor A" });
      if (r.status === 200) vuelta = (Date.now() - tLib) / 1000;
      else await dormir(1500);
    }
    const liberado = (await consola<Block[]>(apr, "GET", "/blocks")).data.find((b) => b.id === bloqueo?.id);
    e.comprueba(
      "bloqueo liberado por el aprobador",
      liberado?.active === false && liberado.releasedBy === "luis.aprobador",
      liberado?.releasedBy ?? "sigue activo",
    );
    e.comprueba(
      "acceso restablecido (HTTP 200)",
      vuelta !== undefined,
      vuelta !== undefined ? `HTTP 200 a los ${seg(vuelta, 0)} de liberar` : "sigue bloqueado",
    );
    const audit = (
      await consola<Array<{ action: string }>>(
        await tokenPersona("pedro.auditoria"),
        "GET",
        "/audit-events?limit=200",
      )
    ).data.map((x) => x.action);
    const faltan = ["anomalias.bloqueo.automatico", "anomalias.bloqueo.liberar"].filter(
      (a) => !audit.includes(a),
    );
    e.comprueba(
      "bloqueo y liberación en la auditoría",
      !faltan.length,
      faltan.length
        ? `faltan ${faltan.join(", ")}`
        : "anomalias.bloqueo.automatico · anomalias.bloqueo.liberar",
    );
    await c.app.reload();
    await e.esperar(1500);

    return {
      medido: `ráfaga de A bloqueada en el gateway a los ${segBloqueo !== undefined ? seg(segBloqueo, 0) : "?"} frente a su línea base de 31 min, con alerta; B (25 llamadas/s) no fue afectado; acceso restablecido ${vuelta !== undefined ? seg(vuelta, 0) : "?"} después de la liberación`,
      datos: {
        segundosHastaBloqueo: segBloqueo,
        respuestas403: rr.porCodigo["403"] ?? 0,
        segundosHastaAcceso: vuelta,
        observado: ev?.observed,
        lineaBase: ev?.baseline,
        ventanasLineaBase: { [A]: base[A]!.ventanas, [B]: base[B]!.ventanas },
        rechazosB: erroresB,
      },
    };
  },

  async limpiar() {
    cargaB?.detener();
    cargaA?.detener();
    cargaB = undefined;
    cargaA = undefined;
    const adm = await tokenPersona("admin.nexo");
    const reglas = (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data;
    const r =
      reglas.find((x) => x.id === nuestra) ??
      reglas.find((x) => x.name.startsWith("Ráfaga de consumo en Concesiones") && x.enabled);
    if (r) await activar(adm, r, false);
    for (const p of previas) await activar(adm, p, true);
    const apr = await tokenPersona("luis.aprobador");
    for (const b of (await consola<Block[]>(apr, "GET", "/blocks")).data.filter((x) => x.active))
      await consola(apr, "POST", `/blocks/${b.id}/release`, { reason: "Fin de la demostración D-02" });
    previas = [];
    nuestra = undefined;
    adminWso2 = undefined;
  },
};

// ── Línea base: tráfico normal de A y B antes de grabar (CLI) ───────────────────────────────────────

/** Genera la línea base: A y B llaman a su ritmo normal durante `minutos` (≥ 31). Uso: --linea-base 32 */
export async function generarLineaBase(
  minutos: number,
  log: (l: string) => void = console.log,
): Promise<void> {
  const notas = await asegurarConsumidor(
    B,
    "Sistema de reportes masivos de un operador (sintético, alto volumen)",
    "Concesiones",
    "Unlimited",
  );
  for (const nota of notas) log(nota);
  const { runLoad } = await import("../../../lab-bootstrap/src/load.js");
  // Las reglas activas del guardián quedan en pausa mientras se genera la línea base (como en grabar.ts): sin
  // historia previa, el tráfico normal del primer minuto podría tratarse como abuso y bloquear a A o a B.
  const adm = await tokenPersona("admin.nexo");
  const enPausa = (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data.filter((r) => r.enabled);
  for (const r of enPausa) await activar(adm, r, false);
  if (enPausa.length)
    log(`reglas del guardián en pausa durante la línea base: ${enPausa.map((r) => r.name).join(", ")}`);
  log(
    `línea base D-02: ${minutos} min · ${A} ${RPS_NORMAL[A]} llamadas/s · ${B} ${RPS_NORMAL[B]} llamadas/s`,
  );
  const t0 = Date.now();
  const cada = setInterval(
    () => log(`  ${((Date.now() - t0) / 60000).toFixed(1)} de ${minutos} min`),
    60_000,
  );
  let r: Awaited<ReturnType<typeof runLoad>>[];
  try {
    r = await Promise.all(
      [A, B].map((app) => runLoad({ url: URL, rps: RPS_NORMAL[app]!, seconds: minutos * 60, app })),
    );
  } finally {
    clearInterval(cada);
    const tok = await tokenPersona("admin.nexo");
    for (const x of enPausa)
      await activar(tok, x, true).catch((e: unknown) =>
        log(`  no se pudo reactivar la regla ${x.name}: ${e instanceof Error ? e.message : String(e)}`),
      );
    if (enPausa.length) log(`reglas reactivadas: ${enPausa.map((x) => x.name).join(", ")}`);
  }
  [A, B].forEach((app, i) => log(`  ${app}: ${r[i]!.llamadas} llamadas · ${r[i]!.errores} errores`));
  const base = await ventanasConTrafico({
    apiNombre: "Concesiones",
    aplicaciones: [A, B],
    ventanaS: VENTANA_S,
    n: VENTANAS_LINEA_BASE - 1,
  });
  for (const app of [A, B])
    log(
      `  ${app}: ${base[app]!.ventanas} de ${VENTANAS_LINEA_BASE - 1} ventanas de ${VENTANA_S} s con tráfico`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--linea-base");
  const minutos = i >= 0 ? Number(process.argv[i + 1] ?? 32) : NaN;
  if (!Number.isFinite(minutos) || minutos < 31) {
    console.error("uso: tsx src/demos/d02-anomalias.ts --linea-base <minutos ≥ 31>");
    process.exit(2);
  }
  const { cargarEnv } = await import("../lib/entorno.js");
  cargarEnv();
  generarLineaBase(minutos).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
