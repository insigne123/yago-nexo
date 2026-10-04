// Lógica de nexo-sd-inbound: crea tickets (o comentarios) desde correo y WhatsApp.
// La asociación remitente -> miembro, la cuarentena de remitentes desconocidos y la
// idempotencia viven en la base de datos (public.nexo_sd_inbound_message).
import { readSecret } from "../_shared/env.ts";
import { errorMessage, json, log, text } from "../_shared/http.ts";
import { callRpc, type RpcClient } from "../_shared/rpc.ts";
import { checkSharedSecret, sha256Hex, verifyMetaSignature } from "../_shared/security.ts";

export interface InboundDeps {
  client: RpcClient;
  env: (name: string) => string | undefined;
}

export interface InboundResult {
  resultado: "ticket" | "comentario" | "cuarentena" | "duplicado";
  ticket_id?: string;
  numero?: string;
}

export interface WhatsAppInbound {
  from: string;
  name: string | null;
  id: string;
  receivedAt: string | null;
  body: string;
}

const decoder = new TextDecoder();

/** "Nombre Apellido <correo@dominio>" o "correo@dominio". */
export function parseAddress(value: string): { email: string; name: string | null } {
  const match = /^\s*"?([^"<]*?)"?\s*<\s*([^>\s]+@[^>\s]+)\s*>\s*$/.exec(value);
  if (match) return { email: match[2]!.toLowerCase(), name: match[1]!.trim() || null };
  return { email: value.trim().toLowerCase(), name: null };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(obj: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** Extrae los mensajes entrantes de un webhook de WhatsApp Cloud (ignora estados de entrega). */
export function extractWhatsAppMessages(payload: unknown): WhatsAppInbound[] {
  const out: WhatsAppInbound[] = [];
  for (const entry of asArray(asObject(payload)?.["entry"])) {
    for (const change of asArray(asObject(entry)?.["changes"])) {
      const value = asObject(asObject(change)?.["value"]);
      if (!value) continue;
      const names = new Map<string, string>();
      for (const contact of asArray(value["contacts"])) {
        const c = asObject(contact);
        const waId = c && typeof c["wa_id"] === "string" ? (c["wa_id"] as string) : null;
        const name = asObject(c?.["profile"])?.["name"];
        if (waId && typeof name === "string") names.set(waId, name);
      }
      for (const raw of asArray(value["messages"])) {
        const message = asObject(raw);
        if (!message) continue;
        const from = typeof message["from"] === "string" ? (message["from"] as string) : "";
        const id = typeof message["id"] === "string" ? (message["id"] as string) : "";
        const type = typeof message["type"] === "string" ? (message["type"] as string) : "desconocido";
        if (!from || !id || type === "reaction") continue;
        let body = "";
        if (type === "text") body = String(asObject(message["text"])?.["body"] ?? "");
        else if (type === "button") body = String(asObject(message["button"])?.["text"] ?? "");
        else if (type === "interactive") {
          const interactive = asObject(message["interactive"]);
          body = String(
            asObject(interactive?.["button_reply"])?.["title"] ??
              asObject(interactive?.["list_reply"])?.["title"] ??
              "",
          );
        } else {
          const media = asObject(message[type]);
          const caption = typeof media?.["caption"] === "string" ? ` ${media["caption"] as string}` : "";
          body = `[Mensaje de tipo ${type}; el archivo queda en WhatsApp]${caption}`;
        }
        const ts = Number(message["timestamp"]);
        out.push({
          from,
          name: names.get(from) ?? null,
          id,
          receivedAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
          body: body.trim(),
        });
      }
    }
  }
  return out;
}

function handleWhatsAppVerification(url: URL, deps: InboundDeps): Response {
  const expected = readSecret(deps.env, "WHATSAPP_VERIFY_TOKEN");
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (!expected) return text("Verificación sin configurar", 500);
  if (mode === "subscribe" && token !== null && token === expected) return text(challenge, 200);
  return text("Token de verificación inválido", 403);
}

async function handleWhatsApp(req: Request, raw: Uint8Array, deps: InboundDeps): Promise<Response> {
  const secret = readSecret(deps.env, "WHATSAPP_APP_SECRET");
  if (!secret) {
    log("error", "WHATSAPP_APP_SECRET no está configurado; se rechaza el webhook");
    return json({ error: "Webhook sin configurar" }, 500);
  }
  if (!(await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), secret))) {
    return json({ error: "Firma inválida" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(raw));
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const messages = extractWhatsAppMessages(payload);
  const resultados: InboundResult[] = [];
  for (const m of messages) {
    resultados.push(
      await callRpc<InboundResult>(deps.client, "nexo_sd_inbound_message", {
        p_channel: "whatsapp",
        p_sender: m.from,
        p_sender_name: m.name,
        p_subject: null,
        p_body: m.body,
        p_external_id: m.id,
        p_received_at: m.receivedAt,
      }),
    );
  }
  return json({ procesados: messages.length, resultados });
}

async function handleEmail(req: Request, raw: Uint8Array, deps: InboundDeps): Promise<Response> {
  const check = checkSharedSecret(req, deps.env("NEXO_INBOUND_SECRET"), "x-nexo-inbound-secret");
  if (check === "sin_configurar") {
    log("error", "NEXO_INBOUND_SECRET no está configurado; se rechaza el correo entrante");
    return json({ error: "Webhook sin configurar" }, 500);
  }
  if (check !== "ok") return json({ error: "No autorizado" }, 401);

  let body: Json | null;
  try {
    body = asObject(JSON.parse(decoder.decode(raw)));
  } catch {
    body = null;
  }
  if (!body) return json({ error: "JSON inválido" }, 400);

  // Formato genérico (from, subject, text, html, message_id) y también el de Postmark.
  const fromRaw = pickString(body, "from", "From", "sender");
  if (!fromRaw) return json({ error: "Falta el remitente (from)" }, 400);
  const address = parseAddress(fromRaw);
  const subject = pickString(body, "subject", "Subject") ?? null;
  const plain = pickString(body, "text", "TextBody", "body");
  const html = pickString(body, "html", "HtmlBody");
  const messageText = plain ?? (html ? htmlToText(html) : "");
  const messageId =
    pickString(body, "message_id", "MessageID", "messageId") ?? `sha256:${await sha256Hex(raw)}`;
  const received = pickString(body, "date", "Date", "received_at");

  const result = await callRpc<InboundResult>(deps.client, "nexo_sd_inbound_message", {
    p_channel: "email",
    p_sender: address.email,
    p_sender_name: pickString(body, "from_name", "FromName") ?? address.name,
    p_subject: subject,
    p_body: messageText,
    p_external_id: messageId,
    p_received_at: received && !Number.isNaN(Date.parse(received)) ? new Date(received).toISOString() : null,
  });
  return json(result);
}

export async function handleInbound(req: Request, deps: InboundDeps): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method === "GET") return handleWhatsAppVerification(url, deps);
    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
    const raw = new Uint8Array(await req.arrayBuffer());
    const isWhatsApp = req.headers.has("x-hub-signature-256") || url.pathname.endsWith("/whatsapp");
    return isWhatsApp ? await handleWhatsApp(req, raw, deps) : await handleEmail(req, raw, deps);
  } catch (err) {
    log("error", "Error al procesar el mensaje entrante", { error: errorMessage(err) });
    // 500 para que el proveedor reintente; la RPC es idempotente por identificador del mensaje.
    return json({ error: "Error interno" }, 500);
  }
}
