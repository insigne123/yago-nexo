// nexo-sd-notify: procesa la bandeja de salida de la Mesa de soporte Nexo.
//
// Autenticación: verify_jwt = false (desplegar con --no-verify-jwt). La invoca pg_cron cada
// minuto mediante pg_net (nexo_private.sd_dispatch_notifications) con la cabecera
// x-nexo-cron-secret, que se compara en tiempo constante con NEXO_CRON_SECRET.
import "@supabase/functions-js/edge-runtime.d.ts";
import { errorMessage, json, log } from "../_shared/http.ts";
import { checkSharedSecret } from "../_shared/security.ts";
import { adminClient } from "../_shared/supabase.ts";
import type { RpcClient } from "../_shared/rpc.ts";
import { DEFAULT_OPTIONS, processPending } from "./handler.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const check = checkSharedSecret(req, Deno.env.get("NEXO_CRON_SECRET"));
  if (check === "sin_configurar") {
    log("error", "NEXO_CRON_SECRET no está configurado; se rechaza la invocación");
    return json({ error: "Función sin configurar" }, 500);
  }
  if (check !== "ok") return json({ error: "No autorizado" }, 401);

  try {
    const batch = Number(Deno.env.get("NEXO_NOTIFY_BATCH") ?? DEFAULT_OPTIONS.batch);
    const summary = await processPending(
      adminClient() as unknown as RpcClient,
      {
        env: (name) => Deno.env.get(name),
        fetch,
      },
      { ...DEFAULT_OPTIONS, batch: Number.isFinite(batch) && batch > 0 ? batch : DEFAULT_OPTIONS.batch },
    );
    log("info", "Bandeja de salida procesada", { ...summary });
    return json(summary);
  } catch (err) {
    log("error", "Error al procesar la bandeja de salida", { error: errorMessage(err) });
    return json({ error: "Error interno" }, 500);
  }
});
