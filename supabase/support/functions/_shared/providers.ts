// Envío por canal. Si falta la configuración de un proveedor, el aviso se da por enviado en
// modo simulado (simulado: true) y se registra en el log: la función nunca se cae por un
// proveedor ausente.
import { readSecret } from "./env.ts";
import type { RenderedMessage } from "./templates.ts";

export interface SendResult {
  ok: boolean;
  simulated: boolean;
  /** Rechazo definitivo (no conviene reintentar), por ejemplo un destinatario inválido. */
  permanent?: boolean;
  providerId?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ProviderDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function simulated(provider: string, reason: string): SendResult {
  return { ok: true, simulated: true, detail: { proveedor: provider, motivo: reason } };
}

/** 4xx (salvo 408, 409, 425 y 429) es definitivo; 5xx y errores de red se reintentan. */
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

async function post(deps: ProviderDeps, url: string, init: RequestInit): Promise<Response> {
  return await deps.fetch(url, {
    ...init,
    method: "POST",
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

async function failure(provider: string, res: Response): Promise<SendResult> {
  const body = (await res.text().catch(() => "")).slice(0, 500);
  return {
    ok: false,
    simulated: false,
    permanent: isPermanentStatus(res.status),
    error: `${provider}: HTTP ${res.status} ${body}`.trim(),
    detail: { proveedor: provider, http: res.status },
  };
}

/** Correo con la API HTTP de Resend (https://resend.com/docs/api-reference/emails/send-email). */
export async function sendEmail(to: string, msg: RenderedMessage, deps: ProviderDeps): Promise<SendResult> {
  const key = readSecret(deps.env, "RESEND_API_KEY");
  if (!key) return simulated("resend", "falta RESEND_API_KEY");
  const res = await post(deps, "https://api.resend.com/emails", {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: readSecret(deps.env, "RESEND_FROM") ?? "Mesa de soporte Nexo <soporte@yago.cl>",
      to: [to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) return await failure("resend", res);
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, simulated: false, providerId: data.id, detail: { proveedor: "resend" } };
}

/**
 * WhatsApp Cloud API con mensaje de plantilla (requerido fuera de la ventana de 24 horas).
 * La plantilla (WHATSAPP_TEMPLATE, por omisión nexo_sd_aviso) debe estar aprobada en Meta con
 * dos variables en el cuerpo: {{1}} el aviso y {{2}} el enlace.
 */
export async function sendWhatsApp(
  to: string,
  msg: RenderedMessage,
  deps: ProviderDeps,
): Promise<SendResult> {
  const token = readSecret(deps.env, "WHATSAPP_TOKEN");
  const phoneId = readSecret(deps.env, "WHATSAPP_PHONE_ID");
  if (!token || !phoneId) return simulated("whatsapp", "faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_ID");
  const version = readSecret(deps.env, "WHATSAPP_API_VERSION") ?? "v23.0";
  const res = await post(deps, `https://graph.facebook.com/${version}/${phoneId}/messages`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\D/g, ""),
      type: "template",
      template: {
        name: readSecret(deps.env, "WHATSAPP_TEMPLATE") ?? "nexo_sd_aviso",
        language: { code: readSecret(deps.env, "WHATSAPP_TEMPLATE_LANG") ?? "es" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: msg.short },
              { type: "text", text: msg.url ?? "https://soporte.yago.cl" },
            ],
          },
        ],
      },
    }),
  });
  if (!res.ok) return await failure("whatsapp", res);
  const data = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
  return {
    ok: true,
    simulated: false,
    providerId: data.messages?.[0]?.id,
    detail: { proveedor: "whatsapp" },
  };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Llamada de voz con la API REST de Twilio (TwiML en línea, se repite el mensaje dos veces). */
export async function sendVoice(to: string, msg: RenderedMessage, deps: ProviderDeps): Promise<SendResult> {
  const sid = readSecret(deps.env, "TWILIO_ACCOUNT_SID");
  const token = readSecret(deps.env, "TWILIO_AUTH_TOKEN");
  const from = readSecret(deps.env, "TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) {
    return simulated("twilio", "faltan TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o TWILIO_FROM_NUMBER");
  }
  const voice = readSecret(deps.env, "TWILIO_VOICE") ?? "Polly.Mia";
  const say = `<Say language="es-MX" voice="${escapeXml(voice)}">${escapeXml(msg.voice)}</Say>`;
  const twiml = `<Response>${say}<Pause length="1"/>${say}</Response>`;
  const res = await post(
    deps,
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`,
    {
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Twiml: twiml }).toString(),
    },
  );
  if (!res.ok) return await failure("twilio", res);
  const data = (await res.json().catch(() => ({}))) as { sid?: string };
  return { ok: true, simulated: false, providerId: data.sid, detail: { proveedor: "twilio" } };
}

/**
 * push = aviso dentro de la aplicación: la fila de nexo_sd_notifications llega por Realtime al
 * usuario (la RLS le deja ver solo las suyas). No hay proveedor externo que llamar.
 */
export function sendPush(): SendResult {
  return { ok: true, simulated: false, providerId: "en_aplicacion", detail: { canal: "en_aplicacion" } };
}
