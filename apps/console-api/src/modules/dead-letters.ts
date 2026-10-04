import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { Db } from "@nexo/console-db";
import { CurrentUser, RequirePermission, type AuthUser } from "../auth/auth.js";
import { AuditService } from "../common/audit.service.js";
import { DB } from "../common/tokens.js";
import { parse } from "../common/validation.js";
import { config } from "../config.js";
import { RabbitService, type RabbitMessage } from "../integrations/integrations.js";

/** Mensajes no procesados y reproceso autorizado y auditado (BT-051). */
const ReprocessSchema = z.object({ reason: z.string().min(5).max(1000) });

function maskPreview(payload: string): string {
  // Minimización (BT-029): se enmascaran RUT, correos y teléfonos en la vista previa.
  return payload
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, (m) => `${m.slice(0, 2)}*.***.***-*`)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "***@***")
    .replace(/\+?56\s?9\s?\d{4}\s?\d{4}/g, "+56 9 **** ****")
    .slice(0, 500);
}

function idOf(m: RabbitMessage): string {
  const h = m.properties.headers ?? {};
  return String(h["x-correlacion"] ?? m.properties.message_id ?? Buffer.from(m.payload).toString("base64url").slice(0, 32));
}

@Controller("dead-letters")
export class DeadLettersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mq: RabbitService,
    private readonly audit: AuditService,
  ) {}

  /** Sincroniza la vista con la cola real de fallidos y devuelve el registro. */
  @Get()
  @RequirePermission("dlq:read")
  async list() {
    const messages = await this.mq.peek(config.rabbitmq.dlq, 200).catch(() => [] as RabbitMessage[]);
    for (const m of messages) {
      const h = m.properties.headers ?? {};
      await this.db.query(
        `INSERT INTO nexo.dead_letter (id, queue, flow, error, attempts, payload_preview)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts,
           status = CASE WHEN nexo.dead_letter.status = 'reprocesado' THEN 'pendiente' ELSE nexo.dead_letter.status END`,
        [idOf(m), config.rabbitmq.dlq, "SolicitudesConcesion", String(h["x-motivo"] ?? "desconocido"), Number(h["x-intentos"] ?? 0), maskPreview(m.payload)],
      );
    }
    const res = await this.db.query("SELECT * FROM nexo.dead_letter ORDER BY first_failed_at DESC LIMIT 200");
    return res.rows.map((r) => ({
      id: r.id,
      queue: r.queue,
      flow: r.flow,
      error: r.error,
      attempts: r.attempts,
      firstFailedAt: r.first_failed_at,
      status: r.status,
      reprocessedBy: r.reprocessed_by ?? undefined,
      payloadPreview: r.payload_preview,
    }));
  }

  /** Mueve el mensaje de la cola de fallidos a la principal con los intentos en cero. Requiere motivo. */
  @Post(":id/reprocess")
  @HttpCode(200)
  @RequirePermission("dlq:reprocess:approve")
  async reprocess(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { reason } = parse(ReprocessSchema, body);
    const batch = await this.mq.take(config.rabbitmq.dlq, 200);
    let found: RabbitMessage | undefined;
    for (const m of batch) {
      if (!found && idOf(m) === id) {
        found = m;
        continue;
      }
      // Lo que no se reprocesa vuelve a la cola de fallidos sin cambios.
      await this.mq.publish("nexo.dlq", "fallido", m.payload, m.properties.headers ?? {});
    }
    if (!found) throw new NotFoundException({ statusCode: 404, message: "El mensaje ya no está en la cola de fallidos" });
    const headers = { ...(found.properties.headers ?? {}), "x-intentos": "0", "x-reprocesado-por": user.username, "x-motivo-reproceso": reason };
    await this.mq.publish(config.rabbitmq.reprocessExchange, config.rabbitmq.reprocessRoutingKey, found.payload, headers);
    const res = await this.db.query(
      "UPDATE nexo.dead_letter SET status = 'reprocesado', reprocessed_by = $1, reprocessed_at = now(), reason = $2 WHERE id = $3 RETURNING *",
      [user.username, reason, id],
    );
    await this.audit.record(user, "mensajes.reprocesar", `mensaje/${id}`, "exito", { reason, cola: config.rabbitmq.dlq });
    const r = res.rows[0] ?? { id, queue: config.rabbitmq.dlq, status: "reprocesado" };
    return { id: r.id, queue: r.queue, status: r.status, reprocessedBy: user.username };
  }
}
