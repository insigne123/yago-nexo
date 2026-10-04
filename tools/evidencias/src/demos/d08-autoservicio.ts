/**
 * D-08 · Portal de desarrolladores con autoservicio de registro, solicitud y aprovisionamiento de credenciales
 * sujeto a flujo de aprobación institucional. Una persona de un operador se registra en el Dev Portal de WSO2,
 * pide una aplicación, credenciales en Keycloak y la suscripción a una API; cada paso queda pendiente hasta que
 * la institución lo aprueba en el Admin Portal. Al final consume la API por el gateway con su credencial.
 */
import type { Page } from "playwright-core";
import { Wso2Client } from "@nexo/wso2-client";
import type { Demo } from "../lib/grabador.js";
import { gateway, tokenAplicacion, wso2 } from "../lib/lab.js";
import { esperarHasta } from "./comun.js";

const CLAVE = "Operador-2026!x";
const URL = "/concesiones/1.0.0/concesiones?estado=vigente";
let usuario = "";
let aplicacion = "";
let admin: Page | undefined;

const clienteDe = (u: string) =>
  new Wso2Client({ baseUrl: "https://apim:9443", auth: { type: "basic", username: u, password: CLAVE }, tls: { rejectUnauthorized: false } });

/** Elimina la cuenta de laboratorio creada por la demostración (servicio de administración de usuarios de WSO2). */
async function borrarUsuario(u: string) {
  const sobre = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.ws.um.carbon.wso2.org"><soapenv:Body><ser:deleteUser><ser:userName>${u}</ser:userName></ser:deleteUser></soapenv:Body></soapenv:Envelope>`;
  const { fetch, Agent } = await import("undici");
  await fetch("https://apim:9443/services/RemoteUserStoreManagerService", {
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
  return (await wso2().admin.listWorkflows(tipo)).list.filter((w) => filtro((w.properties ?? {}) as Record<string, unknown>));
}

export const d08: Demo = {
  id: "D-08",
  archivo: "D-08_autoservicio_aprobacion",
  nombre: "Autoservicio en el portal de desarrolladores con aprobación institucional",
  afirmacion:
    "Una persona externa se registra sola en el portal de desarrolladores, solicita una aplicación, sus credenciales y la suscripción a una API; cada paso queda pendiente hasta que la institución lo aprueba, y solo entonces puede consumir la API.",
  pasos: 6,

  async preparar(c) {
    const sufijo = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    usuario = `operador.${sufijo}`;
    aplicacion = `Reportes ${sufijo}`;
    admin = await c.nuevaSesion();
    await c.ingresarWso2("admin", "admin", undefined, admin);
    await c.app.goto("https://apim:9443/devportal/apis");
    await c.app.getByText("Concesiones").first().waitFor({ timeout: 60_000 });
    return [`cuenta nueva para la demostración: ${usuario} (se elimina al terminar)`, "sesión de la institución abierta en el Admin Portal de WSO2 (usuario admin)"];
  },

  async ejecutar(c) {
    const u = c.app;
    const adm = admin!;
    const w = wso2();
    const conc = (await w.devportal.listApis()).list.find((a) => a.name === "Concesiones")!;

    c.paso("Autorregistro: una persona de un operador crea su cuenta en el portal de desarrolladores");
    await c.vista("app");
    await c.clic(u.getByText(/registrarse/i).first());
    await c.clic(u.getByText("Create Account"));
    await c.escribir("#username", usuario, 30);
    await c.clic("#registrationSubmit");
    await u.locator("#firstname").waitFor();
    await c.escribir("#firstname", "Paula", 30);
    await c.escribir("#lastname", "Rojas", 30);
    await c.escribir("#password", CLAVE, 15);
    await c.escribir("#password2", CLAVE, 15);
    await c.escribir("#email", `${usuario}@operador.invalid`, 15);
    await c.escribir("input[name='http://wso2.org/claims/organization']", "Operador Ejemplo SpA", 20);
    await u.locator("#termsCheckbox").scrollIntoViewIfNeeded();
    await c.clic("#termsCheckbox");
    await c.clic("#registrationSubmit");
    await u.getByText(/registration completed/i).waitFor();
    await c.esperar(2500);

    c.paso("Sin aprobación no hay acceso: la cuenta queda pendiente de la institución");
    await u.goto("https://apim:9443/devportal/apis");
    await c.clic(u.getByText(/registrarse/i).first());
    await c.escribir("#username", usuario, 15);
    await c.escribir("#password", CLAVE, 10);
    await c.clic("button[type=submit]");
    await u.getByText(/403|privilegios/i).first().waitFor({ timeout: 30_000 });
    await c.esperar(1500);
    await c.vista("dividido");
    const reg = await pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario);
    c.log(`$ GET /api/am/admin/v4/workflows?workflowType=AM_USER_SIGNUP`, "cmd");
    for (const r of reg) c.log(`  ${r.workflowType} · ${r.workflowStatus} · ${String(r.description ?? "").slice(0, 90)}`, "aviso");
    c.verificar("registro pendiente: la persona no entra al portal", reg.length === 1, "Error 403 en el Dev Portal");
    await c.esperar(2500);

    c.paso("La institución aprueba el registro en el Admin Portal (Tareas · creación de usuarios)");
    await c.mostrar(adm);
    await c.vista("app");
    await adm.goto("https://apim:9443/admin/tasks/user-creation");
    const filaU = adm.getByRole("row", { name: new RegExp(usuario.replace(".", "\\.")) });
    await filaU.waitFor();
    await c.esperar(1500);
    await c.clic(filaU.getByText("Approve"));
    const aprobadoU = await esperarHasta(async () => pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario), (l) => l.length === 0, 20);
    c.verificar("registro aprobado por la institución", !!aprobadoU, usuario);
    await c.esperar(1500);

    c.paso("La persona pide una aplicación y credenciales en Keycloak: ambas pasan por aprobación");
    await c.mostrar(u);
    await c.clic(u.getByText(/cerrar sesión/i).first());
    await u.waitForTimeout(2500);
    await u.goto("https://apim:9443/devportal/apis");
    await c.clic(u.getByText(/registrarse/i).first());
    if (await u.locator("#username").isVisible({ timeout: 5000 }).catch(() => false)) {
      await c.escribir("#username", usuario, 15);
      await c.escribir("#password", CLAVE, 10);
      await c.clic("button[type=submit]");
    }
    await u.waitForURL(/devportal\/apis/);
    await u.goto("https://apim:9443/devportal/applications/create");
    await c.escribir("#application-name", aplicacion, 30);
    await c.escribir("#application-description", "Sistema de reportes del operador", 15);
    await c.clic("#itest-application-create-save");
    await u.getByText(/espera de la aprobación|pending/i).first().waitFor({ timeout: 20_000 });
    await c.esperar(2500);
    await c.mostrar(adm);
    await adm.goto("https://apim:9443/admin/tasks/application-creation");
    const filaA = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await filaA.waitFor();
    await c.esperar(1200);
    await c.clic(filaA.getByText("Approve"));
    await c.esperar(2000);
    c.verificar("creación de la aplicación aprobada", (await pendientes("AM_APPLICATION_CREATION", (p) => p.applicationName === aplicacion)).length === 0, aplicacion);
    await c.mostrar(u);
    await u.goto("https://apim:9443/devportal/applications");
    await c.clic(u.getByRole("link", { name: aplicacion, exact: true }).first());
    await c.clic("#production-keys");
    await c.clic("button#Keycloak");
    await c.esperar(1500);
    await c.clic("#generate-keys");
    await u.getByText(/pending approval|pendiente de aprobación/i).first().waitFor({ timeout: 20_000 });
    await c.esperar(2500);
    await c.mostrar(adm);
    await adm.goto("https://apim:9443/admin/tasks/application-registration");
    const filaK = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await filaK.waitFor();
    await c.esperar(1200);
    await c.clic(filaK.getByText("Approve"));
    await c.esperar(2000);
    await c.mostrar(u);
    await u.reload();
    await c.clic("button#Keycloak");
    await u.getByText(/clave del consumidor|consumer key/i).first().waitFor({ timeout: 20_000 });
    await c.esperar(3000);
    const cu = clienteDe(usuario);
    const app = (await cu.devportal.listApplications()).list.find((a) => a.name === aplicacion)!;
    const llave = (await cu.devportal.listKeys(app.applicationId)).list.find((k) => k.keyManager === "Keycloak" && k.keyType === "PRODUCTION");
    c.verificar("credenciales de producción emitidas en Keycloak tras la aprobación", !!llave?.consumerKey, llave?.consumerKey ? `${llave.consumerKey.slice(0, 8)}…` : "sin llaves");

    c.paso("Solicita la suscripción a Concesiones con el plan OperadoresEstandar: queda pendiente");
    await c.clic("#left-menu-subscriptions");
    await c.clic(u.locator("button, a").filter({ hasText: /subscribe|suscribir/i }).first());
    const dialogo = u.getByRole("dialog");
    const fila = dialogo.locator("tr", { has: u.locator(`#policy-subscribe-btn-${conc.id}`) });
    await c.clic(fila.locator("#policy-select"));
    await c.clic(u.getByRole("option", { name: "OperadoresEstandar" }));
    await c.clic(fila.locator(`#policy-subscribe-btn-${conc.id}`));
    await c.esperar(2000);
    await u.keyboard.press("Escape");
    await u.reload();
    await c.esperar(2500);
    await c.vista("dividido");
    const token = await tokenAplicacion({ consumerKey: llave!.consumerKey!, consumerSecret: llave!.consumerSecret! });
    c.log(`$ token de Keycloak con la credencial de «${aplicacion}» (client_credentials) → emitido`, "cmd");
    const antes = await gateway(URL, { token });
    const rechazada = antes.status === 401 || antes.status === 403;
    c.log(`$ GET gateway/concesiones/1.0.0/concesiones   # suscripción pendiente → ${antes.status}`, rechazada ? "ok" : "mal");
    c.verificar("con la suscripción pendiente el gateway la rechaza", rechazada, `HTTP ${antes.status}`);
    await c.mostrar(adm);
    await c.vista("app");
    await adm.goto("https://apim:9443/admin/tasks/subscription-creation");
    const filaS = adm.getByRole("row", { name: new RegExp(aplicacion) });
    await filaS.waitFor();
    await c.esperar(1500);
    await c.clic(filaS.getByText("Approve"));
    await c.esperar(2000);

    c.paso("Con todo aprobado, la persona consume la API por el gateway con su credencial");
    await c.mostrar(u);
    await u.reload();
    await c.vista("dividido");
    let despues = await gateway(URL, { token });
    for (let i = 0; i < 15 && despues.status !== 200; i++) {
      await c.esperar(1000);
      despues = await gateway(URL, { token });
    }
    c.log(`$ GET gateway/concesiones/1.0.0/concesiones   # suscripción aprobada → ${despues.status}`, despues.status === 200 ? "ok" : "mal");
    c.log(`  total vigentes: ${(despues.data as { total?: number }).total ?? "?"}`);
    c.verificar("suscripción aprobada: acceso a la API", despues.status === 200, `HTTP ${despues.status}`);
    const quedan = [
      ...(await pendientes("AM_USER_SIGNUP", (p) => p.tenantAwareUserName === usuario)),
      ...(await pendientes("AM_APPLICATION_CREATION", (p) => p.applicationName === aplicacion)),
      ...(await pendientes("AM_APPLICATION_REGISTRATION_PRODUCTION", (p) => p.applicationName === aplicacion)),
      ...(await pendientes("AM_SUBSCRIPTION_CREATION", (p) => p.applicationName === aplicacion)),
    ];
    c.verificar("cuatro aprobaciones institucionales resueltas: registro, aplicación, credenciales y suscripción", quedan.length === 0, `${quedan.length} pendientes`);
    await c.esperar(3000);

    return {
      medido: `registro, aplicación, credenciales en Keycloak y suscripción: cada paso esperó la aprobación institucional; sin ella, sin acceso al portal (403) ni a la API (${antes.status}); con ella, 200`,
      datos: { usuario, aplicacion, antes: antes.status, despues: despues.status },
    };
  },

  async limpiar() {
    if (usuario) {
      try {
        const cu = clienteDe(usuario);
        for (const a of (await cu.devportal.listApplications()).list.filter((x) => x.name === aplicacion)) await cu.devportal.deleteApplication(a.applicationId);
      } catch {
        /* la cuenta pudo no llegar a aprobarse */
      }
      for (const t of ["AM_USER_SIGNUP"])
        for (const p of await pendientes(t, (x) => x.tenantAwareUserName === usuario)) await wso2().admin.resolveWorkflow(p.referenceId, "REJECTED", "Fin de la demostración");
      await borrarUsuario(usuario);
    }
    admin = undefined;
  },
};
