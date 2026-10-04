/**
 * D-02 · Detección de anomalías de consumo por comportamiento, con alerta y bloqueo configurable.
 * El administrador configura la regla en la Consola; el consumidor pasa de tráfico normal a una ráfaga; el
 * guardián la detecta contra la línea base, alerta y bloquea en el gateway (política de denegación de WSO2);
 * un aprobador libera el bloqueo y el acceso vuelve.
 */
import { fetch } from "undici";
import type { Page } from "playwright-core";
import type { Demo } from "../lib/grabador.js";
import { consola, GATEWAY, gateway, tokenAplicacion, credencialesDe, tokenPersona } from "../lib/lab.js";
import { iniciarCarga } from "./carga.js";
import { esperarHasta } from "./comun.js";

const URL = `${GATEWAY}/concesiones/1.0.0/concesiones`;
type Rule = { id: string; name: string; enabled: boolean; metric: string; sensitivity: number; minVolume: number; action: string; blockTtlMinutes: number; apiId?: string };
type Anomaly = { id: string; ruleId: string; status: string; blockId?: string; observed: number; baseline: number; score: number; consumer?: string };
type Block = { id: string; active: boolean; conditionValue: string; releasedBy?: string; expiresAt?: string };

let previas: Rule[] = [];
let nuestra: string | undefined;
let admin: Page | undefined;

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

export const d02: Demo = {
  id: "D-02",
  archivo: "D-02_anomalias",
  nombre: "Detección de anomalías de consumo con alerta y bloqueo configurable",
  afirmacion:
    "El guardián compara el consumo de cada consumidor con su línea base; ante una ráfaga anómala alerta y, según la regla configurada, bloquea al consumidor en el gateway de WSO2 hasta que un aprobador lo libere o venza el bloqueo.",
  pasos: 5,
  usuarioInicial: "admin.nexo",

  async preparar(c) {
    const adm = await tokenPersona("admin.nexo");
    // La sesión de grabación ya pausó las reglas activas; por si se graba suelta, se pausan también aquí.
    previas = (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data.filter((r) => r.enabled);
    for (const r of previas) await activar(adm, r, false);
    const apr = await tokenPersona("luis.aprobador");
    for (const b of (await consola<Block[]>(apr, "GET", "/blocks")).data.filter((x) => x.active))
      await consola(apr, "POST", `/blocks/${b.id}/release`, { reason: "Preparación de la demostración D-02" });
    admin = await c.nuevaSesion();
    await c.ingresarWso2("admin", "admin", undefined, admin);
    return [
      "otras reglas del guardián en pausa: solo actúa la regla que se configura en el video",
      "sin bloqueos activos en el gateway al empezar",
    ];
  },

  async ejecutar(c) {
    const adm = await tokenPersona("admin.nexo");
    const apr = await tokenPersona("luis.aprobador");
    const consumidor = await tokenAplicacion(await credencialesDe("OperadorDemo"));
    const apis = (await consola<Array<{ id: string; wso2ApiId: string; name: string }>>(apr, "GET", "/apis?q=Concesiones")).data;
    const api = apis.find((a) => a.name === "Concesiones");
    if (!api) throw new Error("falta la API Concesiones en el catálogo");

    const NOMBRE = `Ráfaga de consumo en Concesiones (${c.hora().slice(0, 5)})`;
    c.paso("El administrador configura la regla: volumen anómalo en Concesiones → bloqueo automático por 2 min");
    await c.ir("/anomalias?pestana=reglas");
    await c.clic(c.app.getByTestId("btn-new-rule"));
    await c.app.getByTestId("rule-form").waitFor();
    await c.escribir(c.app.getByTestId("rule-name"), NOMBRE, 18);
    await c.clic(c.app.getByTestId("rule-api"), 150);
    await c.app.getByTestId("rule-api").selectOption({ label: (await c.app.getByTestId("rule-api").locator("option", { hasText: /^Concesiones/ }).first().textContent())!.trim() });
    await c.app.getByTestId("rule-metric").selectOption("volumen");
    await c.app.getByTestId("rule-sensitivity").fill("6");
    await c.escribir(c.app.locator("#rule-min-volume"), "30", 60);
    await c.clic(c.app.getByTestId("rule-action"), 150);
    await c.app.getByTestId("rule-action").selectOption("bloquear_automatico");
    await c.escribir(c.app.locator("#rule-ttl"), "2", 60);
    c.log("Acciones configurables por regla: Solo alertar · Bloquear con aprobación (cuatro ojos) · Bloquear automáticamente (con vencimiento)", "tenue");
    c.log("Métricas: volumen, tasa de errores, latencia, tamaño, IPs distintas, uso fuera de horario", "tenue");
    await c.esperar(1500);
    await c.clic(c.app.getByTestId("btn-save-rule"));
    const regla = await esperarHasta(
      async () => (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data.find((r) => r.name === NOMBRE && r.enabled),
      (r) => !!r,
      15,
    );
    nuestra = regla?.valor?.id;
    c.exigir("regla creada y activa", !!regla?.valor, regla?.valor ? `sensibilidad ${regla.valor.sensitivity} · mínimo ${regla.valor.minVolume} · ${regla.valor.action} · ${regla.valor.blockTtlMinutes} min` : "no encontrada");

    c.paso("Tráfico normal del consumidor OperadorDemo: 2 llamadas por segundo");
    await c.clic(c.app.getByRole("tab", { name: "Eventos" }));
    const normal = iniciarCarga(c, { url: URL, rps: 2, segundos: 16, etiqueta: "tráfico normal", cadaSeg: 4 });
    const rn = await normal.resultado;
    c.verificar("tráfico normal atendido", rn.errores === 0, `${rn.ok} de ${rn.llamadas} con 200`);

    c.paso("El consumidor irrumpe con 20 llamadas por segundo; el guardián evalúa ventanas de 30 s (laboratorio)");
    const t0 = Date.now();
    let bloqueadoEn: number | undefined;
    const rafaga = iniciarCarga(c, { url: URL, rps: 20, segundos: 140, etiqueta: "ráfaga anómala", cadaSeg: 3 });
    const vigilar = setInterval(() => {
      const s = rafaga.segundos.at(-1);
      if (s && s.ok === 0 && s.errores > 0 && bloqueadoEn === undefined) {
        bloqueadoEn = Date.now();
        setTimeout(() => rafaga.detener(), 3000);
      }
    }, 200);
    const rr = await rafaga.resultado;
    clearInterval(vigilar);
    const segDeteccion = bloqueadoEn ? Math.round((bloqueadoEn - t0) / 1000) : undefined;
    c.log(`códigos vistos por el consumidor: ${Object.entries(rr.porCodigo).map(([k, n]) => `${k}×${n}`).join("  ")}`);
    c.exigir("ráfaga bloqueada en el gateway (HTTP 403)", !!segDeteccion && (rr.porCodigo["403"] ?? 0) > 0, segDeteccion ? `a los ${segDeteccion} s de iniciada` : "sin bloqueo");

    c.paso("Alerta, evento y bloqueo: en la Consola y como política de denegación en WSO2");
    const ev = (await consola<Anomaly[]>(apr, "GET", "/anomalies")).data.find((e) => e.ruleId === nuestra);
    await c.app.reload();
    await c.app.getByTestId("table-anomalies").waitFor();
    await c.esperar(3500);
    await c.clic(c.app.getByRole("tab", { name: "Bloqueos activos" }));
    await c.esperar(3500);
    c.verificar("evento registrado como bloqueado", ev?.status === "bloqueada", ev ? `${Math.round(ev.observed)} llamadas en la ventana frente a línea base ${Math.round(ev.baseline)} · puntaje ${ev.score}` : "sin evento");
    const am = (await (await fetch("http://localhost:9093/api/v2/alerts")).json()) as Array<{ labels: Record<string, string>; annotations: Record<string, string> }>;
    const alerta = am.find((a) => a.labels.alertname === "ConsumidorBloqueado");
    if (alerta) c.log(`Alertmanager: ${alerta.labels.alertname} [${alerta.labels.severidad ?? ""}] ${alerta.annotations.resumen ?? ""}`.slice(0, 220), "aviso");
    c.verificar("alerta enviada a Alertmanager", !!alerta, alerta?.labels.consumidor ?? "sin alerta");
    if (admin) {
      await c.mostrar(admin);
      await c.clic(admin.getByText("Deny Policies").first());
      await admin.getByText(/OperadorDemo/).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      await c.esperar(4500);
      const visible = await admin.getByText(/OperadorDemo/).first().isVisible().catch(() => false);
      c.verificar("política de denegación activa en WSO2 (Admin Portal)", visible, "condición APPLICATION sobre OperadorDemo");
    }

    c.paso("Un aprobador libera el bloqueo y el consumidor vuelve a operar");
    const pantallaConsola = await c.nuevaSesion();
    await c.mostrar(pantallaConsola);
    await c.ingresarConsola("luis.aprobador");
    await c.ir("/anomalias?pestana=bloqueos");
    const bloqueo = (await consola<Block[]>(apr, "GET", "/blocks")).data.find((b) => b.id === ev?.blockId);
    await c.clic(c.app.getByTestId(`btn-release-${bloqueo?.id ?? ""}`));
    await c.escribir(c.app.getByTestId("release-dialog-reason"), "Consumidor contactado; ráfaga explicada por una carga masiva", 12);
    await c.clic(c.app.getByTestId("release-dialog-confirm"));
    const tLib = Date.now();
    let vuelta: number | undefined;
    for (let i = 0; i < 60 && vuelta === undefined; i++) {
      const r = await gateway(URL, { token: consumidor });
      if (i % 3 === 0 || r.status === 200) c.log(`GET /concesiones/1.0.0/concesiones → ${r.status}`, r.status === 200 ? "ok" : "mal");
      if (r.status === 200) vuelta = (Date.now() - tLib) / 1000;
      else await c.esperar(1000);
    }
    const liberado = (await consola<Block[]>(apr, "GET", "/blocks")).data.find((b) => b.id === bloqueo?.id);
    c.verificar("bloqueo liberado por el aprobador", liberado?.active === false && liberado.releasedBy === "luis.aprobador", liberado?.releasedBy ?? "sigue activo");
    c.verificar("acceso restablecido en el gateway", vuelta !== undefined, vuelta !== undefined ? `200 a los ${vuelta.toFixed(0)} s` : "sigue bloqueado");
    await c.app.reload();
    await c.esperar(3000);
    const audit = (await consola<Array<{ action: string }>>(await tokenPersona("pedro.auditoria"), "GET", "/audit-events?limit=200")).data.map((e) => e.action);
    const faltan = ["anomalias.bloqueo.automatico", "anomalias.bloqueo.liberar"].filter((a) => !audit.includes(a));
    c.verificar("bloqueo y liberación en la auditoría encadenada", !faltan.length, faltan.length ? `faltan ${faltan.join(", ")}` : "anomalias.bloqueo.automatico · anomalias.bloqueo.liberar");

    return {
      medido: `ráfaga bloqueada en el gateway a los ${segDeteccion} s, con alerta; acceso restablecido ${vuelta?.toFixed(0)} s después de la liberación`,
      datos: { segundosHastaBloqueo: segDeteccion, respuestas403: rr.porCodigo["403"] ?? 0, segundosHastaAcceso: vuelta, observado: ev?.observed, lineaBase: ev?.baseline },
    };
  },

  async limpiar() {
    const adm = await tokenPersona("admin.nexo");
    const reglas = (await consola<Rule[]>(adm, "GET", "/anomaly-rules")).data;
    const r = reglas.find((x) => x.id === nuestra) ?? reglas.find((x) => x.name.startsWith("Ráfaga de consumo en Concesiones") && x.enabled);
    if (r) await activar(adm, r, false);
    for (const p of previas) await activar(adm, p, true);
    const apr = await tokenPersona("luis.aprobador");
    for (const b of (await consola<Block[]>(apr, "GET", "/blocks")).data.filter((x) => x.active))
      await consola(apr, "POST", `/blocks/${b.id}/release`, { reason: "Fin de la demostración D-02" });
    previas = [];
    nuestra = undefined;
    admin = undefined;
  },
};
