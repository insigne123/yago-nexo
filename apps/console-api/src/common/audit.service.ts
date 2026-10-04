import { Inject, Injectable } from "@nestjs/common";
import { AuditStore, type Db } from "@nexo/console-db";
import type { AuditResult } from "@nexo/shared";
import type { AuthUser } from "../auth/auth.js";
import { DB } from "./tokens.js";

/** Registra cada acción de la Consola en la cadena de auditoría (BT-031). */
@Injectable()
export class AuditService {
  readonly store: AuditStore;

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
}
