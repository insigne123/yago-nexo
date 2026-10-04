// Lógica de nexo-sd-notify: toma avisos pendientes, los envía por su canal y registra el
// resultado. Los reintentos (espera 1, 2, 4, 8 minutos; máximo 5 intentos) los decide la
// base de datos en nexo_sd_complete_notification.
import { errorMessage, log } from "../_shared/http.ts";
import {
  type ProviderDeps,
  type SendResult,
  sendEmail,
  sendPush,
  sendVoice,
  sendWhatsApp,
} from "../_shared/providers.ts";
import { callRpc, type RpcClient } from "../_shared/rpc.ts";
import { renderNotification } from "../_shared/templates.ts";

export interface NotificationRow {
  id: string;
  channel: "email" | "whatsapp" | "push" | "voz";
  recipient: string;
  template: string;
  payload: Record<string, unknown> | null;
  attempts: number;
}

interface CompletedRow {
  id: string;
  status: "pendiente" | "enviada" | "fallida";
}

export interface NotifySummary {
  procesadas: number;
  enviadas: number;
  simuladas: number;
  reintentos: number;
  fallidas: number;
}

export interface NotifyOptions {
  /** Avisos por lote (nexo_sd_claim_notifications). */
  batch: number;
  /** Envíos simultáneos. */
  concurrency: number;
  /** Lotes como máximo por invocación (el cron vuelve a llamar al minuto siguiente). */
  maxBatches: number;
  /** Presupuesto de tiempo en milisegundos. */
  budgetMs: number;
}

export const DEFAULT_OPTIONS: NotifyOptions = { batch: 25, concurrency: 4, maxBatches: 4, budgetMs: 45_000 };

export async function dispatchOne(row: NotificationRow, deps: ProviderDeps): Promise<SendResult> {
  const message = renderNotification(row.template, row.payload ?? {});
  switch (row.channel) {
    case "email":
      return await sendEmail(row.recipient, message, deps);
    case "whatsapp":
      return await sendWhatsApp(row.recipient, message, deps);
    case "voz":
      return await sendVoice(row.recipient, message, deps);
    case "push":
      return sendPush();
    default:
      return {
        ok: false,
        simulated: false,
        permanent: true,
        error: `Canal desconocido: ${String(row.channel)}`,
      };
  }
}

async function handleRow(
  client: RpcClient,
  row: NotificationRow,
  deps: ProviderDeps,
  summary: NotifySummary,
): Promise<void> {
  let result: SendResult;
  try {
    result = await dispatchOne(row, deps);
  } catch (err) {
    // Error de red o tiempo de espera agotado: se reintenta.
    result = { ok: false, simulated: false, error: errorMessage(err) };
  }
  if (result.simulated) {
    log("info", "Aviso simulado: proveedor no configurado", {
      notificacion: row.id,
      canal: row.channel,
      plantilla: row.template,
    });
  }
  const completed = await callRpc<CompletedRow>(client, "nexo_sd_complete_notification", {
    p_id: row.id,
    p_ok: result.ok,
    p_result: {
      simulado: result.simulated,
      proveedor_id: result.providerId ?? null,
      ...(result.detail ?? {}),
    },
    p_error: result.error ?? null,
    p_permanent: result.permanent ?? false,
  });
  summary.procesadas += 1;
  if (completed?.status === "enviada") {
    summary.enviadas += 1;
    if (result.simulated) summary.simuladas += 1;
  } else if (completed?.status === "fallida") {
    summary.fallidas += 1;
    log("warn", "Aviso fallido definitivamente", {
      notificacion: row.id,
      canal: row.channel,
      error: result.error,
    });
  } else {
    summary.reintentos += 1;
  }
}

/** Procesa lotes hasta vaciar la cola, agotar los lotes o el presupuesto de tiempo. */
export async function processPending(
  client: RpcClient,
  deps: ProviderDeps,
  options: NotifyOptions = DEFAULT_OPTIONS,
  now: () => number = Date.now,
): Promise<NotifySummary> {
  const summary: NotifySummary = { procesadas: 0, enviadas: 0, simuladas: 0, reintentos: 0, fallidas: 0 };
  const deadline = now() + options.budgetMs;
  for (let i = 0; i < options.maxBatches && now() < deadline; i++) {
    const rows =
      (await callRpc<NotificationRow[]>(client, "nexo_sd_claim_notifications", {
        p_limit: options.batch,
        p_lock_seconds: 120,
      })) ?? [];
    if (rows.length === 0) break;
    const queue = [...rows];
    const workers = Array.from(
      { length: Math.max(1, Math.min(options.concurrency, queue.length)) },
      async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          await handleRow(client, row, deps, summary);
        }
      },
    );
    await Promise.all(workers);
    if (rows.length < options.batch) break;
  }
  return summary;
}
