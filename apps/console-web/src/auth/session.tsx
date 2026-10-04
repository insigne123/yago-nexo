import { permissionsFor, type Permission } from "@nexo/shared/browser";
import { createContext, useContext } from "react";
import type { Me } from "../api/types";
import { isPermission } from "./permissions";
import type { AuthUser } from "./types";

/** Sesión efectiva: identidad, roles y permisos (de GET /me o, si falla, calculados de los roles). */
export interface Session {
  user: AuthUser;
  roles: readonly string[];
  permissions: ReadonlySet<Permission>;
  source: "api" | "token";
  can(permission: Permission): boolean;
  canAny(permissions: readonly Permission[]): boolean;
  /** ¿La identidad registrada (createdBy, initiatedBy…) corresponde al usuario actual? */
  isSelf(identity: string | null | undefined): boolean;
}

export function createSession(user: AuthUser, me?: Me | null): Session {
  const roles = me && me.roles.length > 0 ? me.roles : user.roles;
  const permissions: ReadonlySet<Permission> = me
    ? new Set(me.permissions.filter(isPermission))
    : permissionsFor(roles);
  const identities = new Set(
    [user.id, user.username, user.email, me?.sub, me?.email]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase()),
  );
  return {
    user: { ...user, name: me?.name ?? user.name, email: me?.email ?? user.email, roles: [...roles] },
    roles,
    permissions,
    source: me ? "api" : "token",
    can: (permission) => permissions.has(permission),
    canAny: (list) => list.some((p) => permissions.has(p)),
    isSelf: (identity) => Boolean(identity) && identities.has(String(identity).toLowerCase()),
  };
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession requiere una sesión iniciada.");
  return session;
}
