import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuditResult } from "@nexo/shared";
import { catchError, from, mergeMap, throwError, type Observable } from "rxjs";
import type { AuthedRequest } from "../auth/auth.js";
import { AuditService } from "./audit.service.js";

/**
 * Auditoría de rechazos y fallos (BT-031). El éxito de cada acción lo registra su controlador con el detalle
 * del negocio; este interceptor registra lo que no llegó a buen término:
 *   - 403 por la regla de cuatro ojos → «acceso.rechazado.cuatro_ojos» (rechazado);
 *   - una escritura que no se completa → la acción declarada con @AuditAction, «rechazado» si la API la
 *     rechazó (4xx) y «error» si falló (5xx o excepción inesperada).
 * Los 403 por permiso los registra el guardia de autenticación y los 401 se agrupan por IP (UnauthorizedAudit).
 */
export const AUDIT_ACTION_KEY = "nexo:audit-action";

export interface AuditActionMeta {
  action: string;
  /** Identidad técnica para rutas sin usuario (p. ej. el webhook de Alertmanager). */
  actor?: string;
}

/** Nombre de la acción en la auditoría; se usa también para registrar sus rechazos y fallos. */
export const AuditAction = (action: string, opts: { actor?: string } = {}) =>
  SetMetadata(AUDIT_ACTION_KEY, { action, ...opts } satisfies AuditActionMeta);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface FailureAudit {
  action: string;
  result: AuditResult;
  details: Record<string, unknown>;
}

function bodyOf(err: unknown): Record<string, unknown> {
  if (!(err instanceof HttpException)) return {};
  const r = err.getResponse();
  return typeof r === "string" ? { message: r } : (r as Record<string, unknown>);
}

function messageOf(err: unknown): string {
  const m = bodyOf(err).message ?? (err instanceof Error ? err.message : String(err));
  return (Array.isArray(m) ? m.join("; ") : String(m)).slice(0, 300);
}

/** Decide qué registrar ante una excepción (función pura, para probarla sin servidor). */
export function classifyFailure(
  err: unknown,
  method: string,
  meta?: AuditActionMeta,
): FailureAudit | undefined {
  const status = err instanceof HttpException ? err.getStatus() : 500;
  if (status === 401) return undefined; // se agrupan por IP
  const body = bodyOf(err);
  if (status === 403 && body.permission === "cuatro-ojos") {
    return {
      action: "acceso.rechazado.cuatro_ojos",
      result: "rechazado",
      details: { accion: meta?.action, motivo: messageOf(err), estado: 403 },
    };
  }
  if (!meta && !WRITE_METHODS.has(method.toUpperCase())) return undefined; // las consultas fallidas no se auditan
  const details: Record<string, unknown> = { estado: status, motivo: messageOf(err) };
  if (Array.isArray(body.issues))
    details.campos = (body.issues as Array<{ campo?: unknown }>)
      .map((i) => String(i.campo ?? ""))
      .slice(0, 20);
  if (typeof body.code === "string") details.codigo = body.code;
  return {
    action: meta?.action ?? "operacion.fallida",
    result: status >= 500 ? "error" : "rechazado",
    details,
  };
}

export function routeOf(req: { method: string; originalUrl?: string; url?: string }): string {
  return `${req.method} ${String(req.originalUrl ?? req.url ?? "").split("?")[0]}`.slice(0, 300);
}

@Injectable()
export class AuditFailuresInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const meta = this.reflector.get<AuditActionMeta | undefined>(AUDIT_ACTION_KEY, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return next
      .handle()
      .pipe(
        catchError((err: unknown) =>
          from(this.record(err, req, meta)).pipe(mergeMap(() => throwError(() => err))),
        ),
      );
  }

  private async record(err: unknown, req: AuthedRequest, meta: AuditActionMeta | undefined): Promise<void> {
    const f = classifyFailure(err, req.method, meta);
    if (!f) return;
    const user = req.user;
    await this.audit.append({
      actor: (user?.username ?? meta?.actor ?? "anonimo").slice(0, 256),
      actorType: user ? "usuario" : "tecnico",
      action: f.action,
      resource: routeOf(req),
      result: f.result,
      sourceIp: (user?.ip ?? req.ip)?.slice(0, 64),
      details: f.details,
    });
  }
}
