// Pruebas de los módulos compartidos: seguridad, plantillas y proveedores.
// Ejecutar: deno test --config supabase/support/functions/tests/deno.json supabase/support/functions/tests/
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import {
  checkSharedSecret,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqual,
  verifyMetaSignature,
} from "../_shared/security.ts";
import { escapeHtml, formatDate, renderNotification } from "../_shared/templates.ts";
import { readSecret } from "../_shared/env.ts";
import {
  isPermanentStatus,
  type ProviderDeps,
  sendEmail,
  sendPush,
  sendVoice,
  sendWhatsApp,
} from "../_shared/providers.ts";

const encoder = new TextEncoder();

Deno.test("timingSafeEqual compara contenido y largo", () => {
  assert(timingSafeEqual("secreto", "secreto"));
  assertFalse(timingSafeEqual("secreto", "secretO"));
  assertFalse(timingSafeEqual("secreto", "secreto-largo"));
  assertFalse(timingSafeEqual("", "x"));
});

Deno.test("checkSharedSecret rechaza todo si no hay secreto configurado", () => {
  const req = (value?: string) =>
    new Request("http://localhost/fn", {
      method: "POST",
      headers: value ? { "x-nexo-cron-secret": value } : {},
    });
  assertEquals(checkSharedSecret(req("abc"), undefined), "sin_configurar");
  assertEquals(checkSharedSecret(req(), "abc"), "no_autorizado");
  assertEquals(checkSharedSecret(req("abd"), "abc"), "no_autorizado");
  assertEquals(checkSharedSecret(req("abc"), "abc"), "ok");
});

Deno.test("HMAC-SHA256 y SHA-256 coinciden con vectores calculados aparte", async () => {
  assertEquals(
    await hmacSha256Hex("secreto-de-app", '{"entry":[]}'),
    "086d7059eb40dcb47186df3c8356ebacbbda5619ae135755cebada54cfb862ae",
  );
  assertEquals(await sha256Hex("hola"), "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79");
});

Deno.test("verifyMetaSignature valida X-Hub-Signature-256", async () => {
  const body = encoder.encode('{"entry":[]}');
  const good = "sha256=086d7059eb40dcb47186df3c8356ebacbbda5619ae135755cebada54cfb862ae";
  assert(await verifyMetaSignature(body, good, "secreto-de-app"));
  assert(await verifyMetaSignature(body, good.toUpperCase().replace("SHA256=", "sha256="), "secreto-de-app"));
  assertFalse(await verifyMetaSignature(body, good, "otro-secreto"));
  assertFalse(await verifyMetaSignature(body, null, "secreto-de-app"));
  assertFalse(await verifyMetaSignature(body, "md5=abc", "secreto-de-app"));
  assertFalse(await verifyMetaSignature(body, good, undefined));
});

Deno.test("las plantillas están en español, sin emojis y escapan HTML", () => {
  const payload = {
    numero: "SD-2026-0007",
    severidad: "S1",
    titulo: "Gateways <caídos> & sin respuesta",
    metrica_texto: "acuse",
    umbral: 80,
    vence: "2026-10-05T21:00:00Z",
    url: "https://soporte.yago.cl/tickets/abc",
  };
  const msg = renderNotification("sd_sla_umbral", payload);
  assertStringIncludes(msg.subject, "SD-2026-0007 (S1) llegó al 80 % del plazo de acuse");
  assertStringIncludes(msg.text, "lun 05-10-2026, 18:00");
  assertStringIncludes(msg.html, "Gateways &lt;caídos&gt; &amp; sin respuesta");
  assertFalse(msg.html.includes("<caídos>"));
  assertFalse(msg.voice.includes("https://"));
  for (const template of [
    "sd_ticket_nuevo",
    "sd_sla_umbral",
    "sd_sla_vencido",
    "sd_escalamiento_acuse",
    "sd_escalamiento_manual",
    "sd_ticket_cuarentena",
    "sd_pausa_iniciada",
    "sd_pausa_objetada",
    "sd_acceso_remoto_solicitado",
    "sd_acceso_remoto_resuelto",
    "sd_ticket_acusado",
    "sd_ticket_resuelto",
    "sd_ticket_asignado",
    "sd_incidente_seguridad",
    "sd_incidente_plazo",
    "sd_informe_mensual",
    "plantilla_desconocida",
  ]) {
    const rendered = renderNotification(template, payload);
    assertFalse(/\p{Extended_Pictographic}/u.test(rendered.text), `sin emojis en ${template}`);
    assert(rendered.short.length <= 900);
    assertMatch(rendered.subject, /^\[Mesa de soporte Nexo\] /);
  }
  assertEquals(escapeHtml(`"a" & 'b'`), "&quot;a&quot; &amp; &#39;b&#39;");
  assertEquals(formatDate("no es fecha"), "");
});

function fakeFetch(status: number, response: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(response), { status }));
  };
  return { calls, impl: impl as typeof fetch };
}

const message = renderNotification("sd_ticket_nuevo", {
  numero: "SD-2026-0001",
  severidad: "S1",
  titulo: "Caída",
});

Deno.test("sin proveedores configurados todo queda simulado y no se llama a la red", async () => {
  const net = fakeFetch(500, {});
  const deps: ProviderDeps = { env: () => undefined, fetch: net.impl };
  for (const result of [
    await sendEmail("a@ejemplo.invalid", message, deps),
    await sendWhatsApp("+56900000001", message, deps),
    await sendVoice("+56900000001", message, deps),
  ]) {
    assert(result.ok);
    assert(result.simulated);
  }
  assertEquals(net.calls.length, 0);
  assertEquals(sendPush(), {
    ok: true,
    simulated: false,
    providerId: "en_aplicacion",
    detail: { canal: "en_aplicacion" },
  });
});

Deno.test("Resend recibe remitente, destinatario, asunto, texto y HTML", async () => {
  const net = fakeFetch(200, { id: "re_123" });
  const env: Record<string, string> = {
    RESEND_API_KEY: "re_clave",
    RESEND_FROM: "Soporte <soporte@yago.cl>",
  };
  const result = await sendEmail("a@ejemplo.invalid", message, { env: (k) => env[k], fetch: net.impl });
  assertEquals(result, { ok: true, simulated: false, providerId: "re_123", detail: { proveedor: "resend" } });
  assertEquals(net.calls[0]?.url, "https://api.resend.com/emails");
  const headers = new Headers(net.calls[0]?.init.headers);
  assertEquals(headers.get("authorization"), "Bearer re_clave");
  const body = JSON.parse(String(net.calls[0]?.init.body));
  assertEquals(body.to, ["a@ejemplo.invalid"]);
  assertEquals(body.from, "Soporte <soporte@yago.cl>");
  assertStringIncludes(body.subject, "Nuevo ticket SD-2026-0001");
});

Deno.test("WhatsApp usa un mensaje de plantilla con el número en dígitos", async () => {
  const net = fakeFetch(200, { messages: [{ id: "wamid.1" }] });
  const env: Record<string, string> = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "12345" };
  const result = await sendWhatsApp("+56 9 0000 0001", message, { env: (k) => env[k], fetch: net.impl });
  assertEquals(result.providerId, "wamid.1");
  assertEquals(net.calls[0]?.url, "https://graph.facebook.com/v23.0/12345/messages");
  const body = JSON.parse(String(net.calls[0]?.init.body));
  assertEquals(body.to, "56900000001");
  assertEquals(body.type, "template");
  assertEquals(body.template.name, "nexo_sd_aviso");
  assertEquals(body.template.language.code, "es");
  assertEquals(body.template.components[0].parameters.length, 2);
});

Deno.test("Twilio recibe TwiML en español con autenticación básica", async () => {
  const net = fakeFetch(201, { sid: "CA123" });
  const env: Record<string, string> = {
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "secreto",
    TWILIO_FROM_NUMBER: "+15550000000",
  };
  const result = await sendVoice("+56900000001", message, { env: (k) => env[k], fetch: net.impl });
  assertEquals(result.providerId, "CA123");
  assertEquals(net.calls[0]?.url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json");
  assertEquals(new Headers(net.calls[0]?.init.headers).get("authorization"), `Basic ${btoa("AC1:secreto")}`);
  const form = new URLSearchParams(String(net.calls[0]?.init.body));
  assertEquals(form.get("To"), "+56900000001");
  assertStringIncludes(form.get("Twiml") ?? "", '<Say language="es-MX"');
});

Deno.test("los errores 4xx son definitivos y los 5xx se reintentan", async () => {
  assert(isPermanentStatus(400));
  assert(isPermanentStatus(422));
  assertFalse(isPermanentStatus(429));
  assertFalse(isPermanentStatus(503));
  const env: Record<string, string> = { RESEND_API_KEY: "k" };
  const rejected = await sendEmail("x", message, {
    env: (k) => env[k],
    fetch: fakeFetch(422, { message: "invalid" }).impl,
  });
  assertEquals(rejected.ok, false);
  assertEquals(rejected.permanent, true);
  const unavailable = await sendEmail("x", message, { env: (k) => env[k], fetch: fakeFetch(503, {}).impl });
  assertEquals(unavailable.permanent, false);
});

Deno.test("los secretos con prefijo NEXO_SD_ tienen prioridad (proyecto compartido)", async () => {
  const env: Record<string, string> = {
    RESEND_API_KEY: "clave-de-otro-producto",
    NEXO_SD_RESEND_API_KEY: "clave-de-la-mesa",
  };
  assertEquals(
    readSecret((k) => env[k], "RESEND_API_KEY"),
    "clave-de-la-mesa",
  );
  assertEquals(
    readSecret((k) => ({ WHATSAPP_TOKEN: "generico" })[k], "WHATSAPP_TOKEN"),
    "generico",
  );
  assertEquals(
    readSecret(() => "  ", "TWILIO_AUTH_TOKEN"),
    undefined,
  );
  const net = fakeFetch(200, { id: "re_9" });
  await sendEmail("a@ejemplo.invalid", message, { env: (k) => env[k], fetch: net.impl });
  assertEquals(new Headers(net.calls[0]?.init.headers).get("authorization"), "Bearer clave-de-la-mesa");
});
