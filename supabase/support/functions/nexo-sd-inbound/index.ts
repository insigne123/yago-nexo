// nexo-sd-inbound: webhook de entrada de la Mesa de soporte Nexo.
//
// Autenticación: verify_jwt = false (desplegar con --no-verify-jwt). Los webhooks no traen un
// JWT de Supabase; se autentican así:
//   * WhatsApp Cloud API: GET con hub.verify_token = WHATSAPP_VERIFY_TOKEN para suscribir el
//     webhook, y cada POST con X-Hub-Signature-256 (HMAC-SHA256 del cuerpo con
//     WHATSAPP_APP_SECRET).
//   * Correo (JSON genérico de la pasarela de correo entrante): cabecera
//     x-nexo-inbound-secret = NEXO_INBOUND_SECRET.
// Rutas: .../nexo-sd-inbound/whatsapp y .../nexo-sd-inbound/email (o cualquier otra con la
// cabecera de firma correspondiente).
import "@supabase/functions-js/edge-runtime.d.ts";
import type { RpcClient } from "../_shared/rpc.ts";
import { adminClient } from "../_shared/supabase.ts";
import { handleInbound } from "./handler.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  return await handleInbound(req, {
    client: adminClient() as unknown as RpcClient,
    env: (name) => Deno.env.get(name),
  });
});
