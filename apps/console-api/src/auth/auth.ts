import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { permissionsFor, type Permission } from "@nexo/shared";
import type { Request } from "express";
import { config } from "../config.js";

export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  username: string;
  roles: string[];
  permissions: Permission[];
  ip?: string;
}

export type AuthedRequest = Request & { user?: AuthUser; correlationId?: string };

const PERMISSION_KEY = "nexo:permission";
const PUBLIC_KEY = "nexo:public";

/** Exige un permiso de la matriz rol-permiso (BT-026). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
/** Ruta sin autenticación (salud, métricas, webhook interno). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

const jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });

export async function verifyToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.auth.issuer,
    ...(config.auth.audience ? { audience: config.auth.audience } : {}),
    clockTolerance: 30,
  });
  return payload;
}

export function userFromClaims(payload: JWTPayload, ip?: string): AuthUser {
  const rolesRaw = readPath(payload, config.auth.rolesClaimPath);
  const roles = Array.isArray(rolesRaw) ? rolesRaw.map(String) : [];
  const p = payload as JWTPayload & { name?: string; email?: string; preferred_username?: string };
  return {
    sub: String(payload.sub ?? ""),
    name: p.name,
    email: p.email,
    username: p.preferred_username ?? p.email ?? String(payload.sub ?? "desconocido"),
    roles,
    permissions: [...permissionsFor(roles)],
    ip,
  };
}

/**
 * Valida el JWT contra el JWKS configurado (Keycloak o Supabase) y aplica la matriz rol-permiso.
 * Las rutas sin @RequirePermission solo exigen un usuario autenticado.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const klass = ctx.getClass();
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, klass])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new UnauthorizedException("Falta el token de acceso");
    let payload: JWTPayload;
    try {
      payload = await verifyToken(token);
    } catch (e) {
      throw new UnauthorizedException(`Token inválido: ${e instanceof Error ? e.message : "error"}`);
    }
    req.user = userFromClaims(payload, req.ip);
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [handler, klass]);
    if (required && !req.user.permissions.includes(required)) {
      throw new ForbiddenException({ statusCode: 403, message: `Se requiere el permiso ${required}`, permission: required });
    }
    return true;
  }
}

/** Regla de cuatro ojos: quien inició la acción no puede aprobarla. */
export function assertFourEyes(user: AuthUser, initiatedBy: string | null | undefined, what: string): void {
  if (initiatedBy && (initiatedBy === user.username || initiatedBy === user.sub)) {
    throw new ForbiddenException({
      statusCode: 403,
      message: `Regla de cuatro ojos: quien inició ${what} no puede aprobarlo`,
      permission: "cuatro-ojos",
    });
  }
}
