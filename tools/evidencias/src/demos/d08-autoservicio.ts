/**
 * D-08 · Portal de desarrolladores con autoservicio de registro, solicitud y aprovisionamiento de credenciales
 * sujeto a flujo de aprobación institucional. Una persona de un operador se registra en el Dev Portal de WSO2,
 * pide una aplicación, credenciales en Keycloak y la suscripción a una API; cada paso queda pendiente hasta que
 * la institución lo aprueba en el Admin Portal. Al final consume la API por el gateway con su credencial.
 *
 * Sin ritmo propio (V03): el guion no fija --ritmo; las pausas de lectura son las del motor.
 *
 * Pantalla: cada página de otra sesión (la persona o la institución) se carga fuera de pantalla y se muestra
 * cuando ya dibujó lo que se va a mirar, para no narrar sobre páginas en blanco ni ampliar un «Loading…». Los
 * avisos flotantes de WSO2 (p. ej. la solicitud de claves pendiente) no se amplían: duran poco y quedan junto al
 * borde; se leen a tamaño normal y su texto se copia en la terminal, junto a la solicitud pendiente en el Admin.
 * Duración estimada: portada 4 s + 6 pasos (≈ 40 + 18 + 14 + 55 + 30 + 16 s) + cierre 3 s ≈ 180 s (tope 240 s).
 */
import type { Page } from "playwright-core";
import { Wso2Client } from "@nexo/wso2-client";
import type { DefinicionPaso, Demo } from "../lib/grabador.js";
import { gateway, reescribirUrlEnsayo, tokenAplicacion, WSO2, wso2 } from "../lib/lab.js";
import { prepararEnsayo } from "./bt0x-ensayo.js";
import { cambiarVista, esperarCarga, esperarHasta, mostrarLista, textoEnLinea, verPagina } from "./comun.js";

export const DURACION_ESTIMADA_S = 180;

const CLAVE = "Operador-2026!x";
const URL = "/concesiones/1.0.0/concesiones?estado=vigente";
let usuario = "";
let aplicacion = "";
let admin: Page | undefined;

export const NARRACION_D08: DefinicionPaso[] = [
  {
    titulo: "Autorregistro de una persona de un operador",
    quePasa:
      "Una persona externa entra al portal de desarrolladores y crea su cuenta sola: usuario, nombre, correo, organización y clave.",
    porQueImporta:
      "Los operadores no dependen de que la institución les cree cuentas a mano: el alta empieza por autoservicio.",
    comprueba: ["la cuenta queda registrada"],
  },
  {
    titulo: "Sin aprobación no hay acceso",
    quePasa:
      "La persona intenta entrar con su cuenta nueva. El portal la rechaza: el registro está pendiente de la institución.",
    porQueImporta: "El autoservicio no abre la puerta por sí solo: la institución decide quién entra.",
    comprueba: ["registro pendiente: la persona no entra al portal"],
  },
  {
    titulo: "La institución aprueba el registro",
    quePasa:
      "En el portal de administración, una persona de la institución revisa las tareas pendientes de creación de usuarios y aprueba la solicitud.",
    porQueImporta:
      "Cada alta queda decidida por una persona responsable, en una bandeja de tareas propia de la plataforma.",
    comprueba: ["registro aprobado por la institución"],
  },
  {
    titulo: "Aplicación y credenciales en Keycloak, con aprobación",
    quePasa:
      "La persona crea una aplicación y pide sus credenciales de producción a Keycloak. Las dos solicitudes esperan y la institución las aprueba.",
    porQueImporta: "Ninguna credencial de producción se emite sin una decisión institucional registrada.",
    comprueba: [
      "creación de la aplicación aprobada",
      "credenciales de producción emitidas en Keycloak tras la aprobación",
    ],
  },
  {
    titulo: "Suscripción a una API: pendiente hasta aprobarla",
    quePasa:
      "La persona pide suscribirse a la API Concesiones con el plan OperadoresEstandar. Mientras se aprueba, el gateway rechaza sus llamadas.",
    porQueImporta:
      "Tener credenciales no basta para consumir una API: cada acceso a una API también pasa por aprobación.",
    comprueba: ["con la suscripción pendiente el gateway la rechaza"],
  },
  {
    titulo: "Con todo aprobado, la persona consume la API",
    quePasa:
      "Con la suscripción aprobada, la misma credencial llama a Concesiones por el gateway y recibe datos. No queda ninguna solicitud pendiente.",
    porQueImporta:
      "El circuito completo, del registro al consumo, ocurrió por autoservicio y con cuatro aprobaciones institucionales.",
    comprueba: [
      "suscripción aprobada: acceso a la API",
      "cuatro aprobaciones resueltas: registro, aplicación, credenciales y suscripción",
    ],
  },
];

const clienteDe = (u: string) =>
  new Wso2Client({
    baseUrl: WSO2,
    auth: { type: "basic", username: u, password: CLAVE },
    tls: { rejectUnauthorized: false },
  });

/** Elimina la cuenta de laboratorio creada por la demostración (servicio de administración de usuarios de WSO2). */
async function borrarUsuario(u: string) {
  const sobre = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.ws.um.carbon.wso2.org"><soapenv:Body><ser:deleteUser><ser:userName>${u}</ser:userName></ser:deleteUser></soapenv:Body></soapenv:Envelope>`;
  const { fetch, Agent } = await import("undici");
  await fetch(reescribirUrlEnsayo("https://apim:9443/services/RemoteUserStoreManagerService"), {
    method: "POST",
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    headers: {
      "content-type": "text/xml",
      SOAPAction: "urn:deleteUser",
      authorization: `Basic ${Buffer.from(`admin:${process.env.APIM_ADMIN_PASSWORD ?? "admin"}`).toString("base64")}`,
    },
    body: sobre,
  }).catch(() => undefined);
}

async function pendientes(tipo: string, filtro: (p: Record<string, unknown>) => boolean) {
  return (await wso2().admin.listWorkflows(tipo)).list.filter((w) =>
    filtro((w.properties ?? {}) as Record<string, unknown>),
  );
}

const exprUsuario = () => new RegExp(usuario.replace(".", "\\."));

export const d08: Demo = {
  id: "D-08",
  archivo: "D-08_autoservicio_aprobacion",
  nombre: "Autoservicio en el portal de desarrolladores con aprobación institucional",
  afirmacion:
    "Una persona externa se registra sola en el portal de desarrolladores, solicita una aplicación, sus credenciales y la suscripción a una API; cada paso queda pendiente hasta que la institución lo aprueba, y solo entonces puede consumir la API.",
  pasos: NARRACION_D08.length,
  agenda: NARRACION_D08.map((p) => p.titulo),

  async preparar(c) {
    await prepararEnsayo(c);
    const sufijo = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    usuario = `operador.${sufijo}`;
    aplicacion = `Reportes ${sufijo}`;
    admin = await c.nuevaSesion();
    await c.ingresarWso2("admin", "admin", undefined, admin);
    await c.app.goto("https://apim:9443/devportal/apis");
    await c.app.getByText("Concesiones").first().waitFor({ timeout: 60_000 });
    return [
      `cuenta nueva para la demostración: ${usuario} (se elimina al terminar)`,
      "sesión de la institución abierta en el Admin Portal de WSO2 (usuario admin)",
    ];
  },

  async ejecutar(c) {
    const e = c.estudio;
    const u = c.app;
    const adm = admin!;
    const w = wso2();
    const conc = (await w.devportal.listApis()).list.find((a) => a.name === "Concesiones")!;

    // 1 ── Autorregistro ─────────────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[0]!);
    await c.vista("app");
    await e.clic(u.getByText(/registrarse/i).first());
    await e.clic(u.getByText("Create Account"));
    await e.escribir("#username", usuario);
    await e.clic("#registrationSubmit");
    await u.locator("#firstname").waitFor();
    await e.escribir("#firstname", "Paula");
    await e.escribir("#lastname", "Rojas");
    await e.escribir("#password", CLAVE);
    await e.escribir("#password2", CLAVE);
    await e.escribir("#email", `${usuario}@operador.invalid`, { ms: 45 });
    await e.escribir("input[name='http://wso2.org/claims/organization']", "Operador Ejemplo SpA", {
      ms: 55,
      campo: "Organización",
    });
    await e.desplazar(u.locator("#termsCheckbox"));
    await e.clic("#termsCheckbox");
    await e.clic("#registrationSubmit");
    const completado = u.getByText(/registration completed|registro completado/i).first();
    await completado.waitFor();
    await e.zoom(completado, { factor: 1.6, ms: 1800 });
    e.comprueba("la cuenta queda registrada", await completado.isVisible(), usuario);

    // 2 ── Sin aprobación, sin acceso ────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[1]!);
    await u.goto("https://apim:9443/devportal/apis");
    await e.clic(u.getByText(/registrarse/i).first());
    await e.escribir("#username", usuario);
    await e.escribir("#password", CLAVE);
    await e.clic("button[type=submit]");
    const rechazo = u.getByText(/403|privilegios/i).first();
    await rechazo.waitFor({ timeout: 30_000 });
    await e.zoom(rechazo, { factor: 1.6, ms: 1800 });
    await cambiarVista(c, "dividido");
    const reg = await pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario);
    c.log("→ GET /api/am/admin/v4/workflows?workflowType=AM_USER_SIGNUP", "cmd");
    for (const r of reg)
      c.log(
        `  ${r.workflowType} · ${r.workflowStatus} · ${String(r.description ?? "").slice(0, 90)}`,
        "aviso",
      );
    e.comprueba(
      "registro pendiente: la persona no entra al portal",
      reg.length === 1 && (await rechazo.isVisible().catch(() => false)),
      `Error 403 · ${reg.length} solicitud pendiente`,
    );

    // 3 ── La institución aprueba el registro ───────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[2]!);
    // La bandeja de la institución se carga fuera de pantalla y se muestra con la solicitud ya a la vista.
    await adm.goto("https://apim:9443/admin/tasks/user-creation");
    const filaU = adm.getByRole("row", { name: exprUsuario() });
    await esperarCarga(adm, filaU, { ms: 30_000 });
    await mostrarLista(c, adm);
    await cambiarVista(c, "app");
    await verPagina(c, filaU);
    await e.zoom(filaU, { factor: 1.5 });
    await e.clic(filaU.getByText("Approve"));
    const aprobadoU = await esperarHasta(
      async () => pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario),
      (l) => l.length === 0,
      20,
    );
    e.comprueba("registro aprobado por la institución", !!aprobadoU, `${usuario} · por admin`);

    // 4 ── Aplicación y credenciales ────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[3]!);
    await mostrarLista(c, u);
    await e.clic(u.getByText(/cerrar sesión/i).first());
    await u.waitForTimeout(2500);
    await u.goto("https://apim:9443/devportal/apis");
    await e.clic(u.getByText(/registrarse/i).first());
    if (
      await u
        .locator("#username")
        .isVisible({ timeout: 5000 })
        .catch(() => false)
    ) {
      await e.escribir("#username", usuario);
      await e.escribir("#password", CLAVE);
      await e.clic("button[type=submit]");
    }
    await u.waitForURL(/devportal\/apis/);
    await esperarCarga(u, u.getByText("Concesiones"), { ms: 30_000 });
    await u.goto("https://apim:9443/devportal/applications/create");
    await esperarCarga(u, u.locator("#application-name"), { ms: 30_000 });
    await e.escribir("#application-name", aplicacion);
    await e.escribir("#application-description", "Sistema de reportes del operador", { ms: 50 });
    await e.clic("#itest-application-create-save");
    const pendienteApp = u.getByText(/espera de la aprobación|pending/i).first();
    await pendienteApp.waitFor({ timeout: 20_000 });
    await e.zoom(pendienteApp, { factor: 1.5, ms: 1500 });
    const filaA = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await adm.goto("https://apim:9443/admin/tasks/application-creation");
    await esperarCarga(adm, filaA, { ms: 30_000 });
    await mostrarLista(c, adm);
    await verPagina(c, filaA);
    await e.clic(filaA.getByText("Approve"));
    const aprobadaA = await esperarHasta(
      async () => pendientes("AM_APPLICATION_CREATION", (p) => p.applicationName === aplicacion),
      (l) => l.length === 0,
      20,
    );
    e.comprueba("creación de la aplicación aprobada", !!aprobadaA, aplicacion);
    // La lista de aplicaciones de la persona se recarga fuera de pantalla y se muestra ya dibujada.
    const enlaceApp = u.getByRole("link", { name: aplicacion, exact: true }).first();
    await u.goto("https://apim:9443/devportal/applications");
    await esperarCarga(u, enlaceApp, { ms: 30_000 });
    await mostrarLista(c, u);
    await e.clic(enlaceApp);
    await e.clic("#production-keys");
    await e.clic("button#Keycloak");
    await e.clic("#generate-keys");
    // El aviso de WSO2 dura unos segundos junto al borde: se lee sin ampliar y su texto va a la terminal.
    const pendienteK = u.getByText(/pending approval|pendiente de aprobación/i).first();
    await pendienteK.waitFor({ timeout: 20_000 });
    const avisoK = await textoEnLinea(pendienteK);
    if (avisoK) c.log(`Dev Portal: «${avisoK}»`, "aviso");
    const pendK = await pendientes(
      "AM_APPLICATION_REGISTRATION_PRODUCTION",
      (p) => p.applicationName === aplicacion,
    );
    c.log(
      `→ GET /api/am/admin/v4/workflows?workflowType=AM_APPLICATION_REGISTRATION_PRODUCTION → ${pendK.length} pendiente(s) de «${aplicacion}»`,
      pendK.length ? "aviso" : "mal",
    );
    await e.esperar(2200);
    const filaK = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await adm.goto("https://apim:9443/admin/tasks/application-registration");
    await esperarCarga(adm, filaK, { ms: 30_000 });
    await mostrarLista(c, adm);
    await verPagina(c, filaK);
    await e.clic(filaK.getByText("Approve"));
    await esperarHasta(
      async () =>
        pendientes("AM_APPLICATION_REGISTRATION_PRODUCTION", (p) => p.applicationName === aplicacion),
      (l) => l.length === 0,
      20,
    );
    // Fuera de pantalla: se recarga la página de claves y se vuelve a la pestaña de Keycloak (la recarga abre la
    // del gestor de claves interno de WSO2, que no se usa aquí); se muestra cuando ya se ve la clave emitida.
    await u.reload();
    const pestanaK = u.locator("button#Keycloak");
    await esperarCarga(u, pestanaK, { ms: 30_000 });
    await e.clic(pestanaK, { pagina: u });
    const llaveVisible = u.getByText(/clave del consumidor|consumer key/i).first();
    await llaveVisible.waitFor({ timeout: 20_000 });
    await mostrarLista(c, u);
    await verPagina(c, llaveVisible);
    await e.zoom(llaveVisible, { factor: 1.5, ms: 1800 });
    const cu = clienteDe(usuario);
    const app = (await cu.devportal.listApplications()).list.find((a) => a.name === aplicacion)!;
    const llave = (await cu.devportal.listKeys(app.applicationId)).list.find(
      (k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION",
    );
    e.comprueba(
      "credenciales de producción emitidas en Keycloak tras la aprobación",
      !!llave?.consumerKey,
      llave?.consumerKey ? `${llave.consumerKey.slice(0, 8)}…` : "sin llaves",
    );

    // 5 ── Suscripción pendiente ────────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[4]!);
    await e.clic("#left-menu-subscriptions");
    await e.clic(
      u
        .locator("button, a")
        .filter({ hasText: /subscribe|suscribir/i })
        .first(),
    );
    const dialogo = u.getByRole("dialog");
    const fila = dialogo.locator("tr", { has: u.locator(`#policy-subscribe-btn-${conc.id}`) });
    await e.clic(fila.locator("#policy-select"));
    await e.clic(u.getByRole("option", { name: "OperadoresEstandar" }));
    await e.clic(fila.locator(`#policy-subscribe-btn-${conc.id}`));
    await c.esperar(1500);
    await e.tecla("Escape");
    await u.reload();
    await esperarCarga(u, u.locator("#left-menu-subscriptions"), { ms: 15_000 });
    await cambiarVista(c, "dividido");
    const token = await tokenAplicacion({
      consumerKey: llave!.consumerKey!,
      consumerSecret: llave!.consumerSecret!,
    });
    c.log(`→ token de Keycloak con la credencial de «${aplicacion}» (client_credentials) → emitido`, "cmd");
    const antes = await gateway(URL, { token });
    const rechazada = antes.status === 401 || antes.status === 403;
    c.log(
      `→ GET gateway/concesiones/1.0.0/concesiones   # suscripción pendiente → HTTP ${antes.status}`,
      rechazada ? "ok" : "mal",
    );
    // La respuesta del gateway tal cual (su código y mensaje de error explican el rechazo).
    c.log(
      `  ${(typeof antes.data === "string" ? antes.data : JSON.stringify(antes.data)).slice(0, 160)}`,
      "tenue",
    );
    e.comprueba("con la suscripción pendiente el gateway la rechaza", rechazada, `HTTP ${antes.status}`);
    const filaS = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await adm.goto("https://apim:9443/admin/tasks/subscription-creation");
    await esperarCarga(adm, filaS, { ms: 30_000 });
    await mostrarLista(c, adm);
    await cambiarVista(c, "app");
    await verPagina(c, filaS);
    await e.zoom(filaS, { factor: 1.5 });
    await e.clic(filaS.getByText("Approve"));
    await esperarHasta(
      async () => pendientes("AM_SUBSCRIPTION_CREATION", (p) => p.applicationName === aplicacion),
      (l) => l.length === 0,
      20,
    );

    // 6 ── Consumo con todo aprobado ────────────────────────────────────────────────────────────────
    await e.paso(NARRACION_D08[5]!);
    // La persona vuelve a su página ya recargada (fuera de pantalla), con la suscripción al día.
    await u.reload();
    await esperarCarga(u, u.locator("#left-menu-subscriptions"), { ms: 15_000 });
    await mostrarLista(c, u);
    await cambiarVista(c, "dividido");
    await verPagina(c);
    let despues = await gateway(URL, { token });
    for (let i = 0; i < 15 && despues.status !== 200; i++) {
      await c.esperar(1000);
      despues = await gateway(URL, { token });
    }
    c.log(
      `→ GET gateway/concesiones/1.0.0/concesiones   # suscripción aprobada → HTTP ${despues.status}`,
      despues.status === 200 ? "ok" : "mal",
    );
    c.log(`  total vigentes: ${(despues.data as { total?: number }).total ?? "?"}`);
    e.indicadores({
      "suscripción pendiente": `HTTP ${antes.status}`,
      "suscripción aprobada": `HTTP ${despues.status}`,
    });
    e.comprueba("suscripción aprobada: acceso a la API", despues.status === 200, `HTTP ${despues.status}`);
    const quedan = [
      ...(await pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario)),
      ...(await pendientes("AM_APPLICATION_CREATION", (p) => p.applicationName === aplicacion)),
      ...(await pendientes(
        "AM_APPLICATION_REGISTRATION_PRODUCTION",
        (p) => p.applicationName === aplicacion,
      )),
      ...(await pendientes("AM_SUBSCRIPTION_CREATION", (p) => p.applicationName === aplicacion)),
    ];
    e.comprueba(
      "cuatro aprobaciones resueltas: registro, aplicación, credenciales y suscripción",
      quedan.length === 0,
      `${quedan.length} pendientes`,
    );
    await e.esperar(2000);

    return {
      medido: `registro, aplicación, credenciales en Keycloak y suscripción: cada paso esperó la aprobación institucional; sin ella, sin acceso al portal (403) ni a la API (${antes.status}); con ella, ${despues.status}`,
      datos: { usuario, aplicacion, antes: antes.status, despues: despues.status },
    };
  },

  async limpiar() {
    if (usuario) {
      try {
        const cu = clienteDe(usuario);
        for (const a of (await cu.devportal.listApplications()).list.filter((x) => x.name === aplicacion))
          await cu.devportal.deleteApplication(a.applicationId);
      } catch {
        /* la cuenta pudo no llegar a aprobarse */
      }
      try {
        for (const p of await pendientes("AM_USER_SIGNUP", (x) => x.tenantAwareUserName === usuario))
          await wso2().admin.resolveWorkflow(p.referenceId, "REJECTED", "Fin de la demostración");
      } catch {
        /* sin pendientes */
      }
      await borrarUsuario(usuario);
    }
    admin = undefined;
  },
};
