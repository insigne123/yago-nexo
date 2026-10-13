import { Inject, Injectable, Logger } from "@nestjs/common";
import { AuditStore, type Db } from "@nexo/console-db";
import type { AuditEventInput, AuditResult } from "@nexo/shared";
import type { AuthUser } from "../auth/auth.js";
import { DB } from "./tokens.js";

/** Registra cada acción de la Consola en la cadena de auditoría (BT-031). */
@Injectable()
export class AuditService {
  readonly store: AuditStore;
  private readonly log = new Logger("auditoria");

  constructor(@Inject(DB) db: Db) {
    this.store = new AuditStore(db);
  }

  record(user: AuthUser | { username: string; ip?: string }, action: string, resource: string, result: AuditResult, details?: Record<string, unknown>, correlationId?: string) {
    const isTech = !("roles" in user);
    return this.store.append({
      source: "consola",
      actor: user.username,
      actorType: isTech ? "tecnico" : "usuario",
      action,
      resource,
      result,
      sourceIp: user.ip,
      correlationId,
      details,
    });
  }

  /**
   * Registra un evento sin interrumpir la respuesta en curso (rechazos y fallos). Si la escritura en la
   * cadena falla, queda en el log de la API con el evento completo, para no perderlo en silencio.
   */
  async append(input: Omit<AuditEventInput, "source">): Promise<boolean> {
    try {
      await this.store.append({ source: "consola", ...input });
      return true;
    } catch (e) {
      this.log.error(`no se pudo registrar en la auditoría: ${e instanceof Error ? e.message : String(e)} · evento ${JSON.stringify(input)}`);
      return false;
    }
  }
}
