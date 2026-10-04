import { permissionsFor, type Permission } from "@nexo/shared/browser";
import { decodeJwtPayload, getClaim, rolesFromClaims, stringClaim } from "../auth/jwt";

/** Identidad de quien llama a la API simulada, leída del token (sin verificar firma: es un simulador). */
export interface Actor {
  sub: string;
  username: string;
  name: string;
  email?: string;
  roles: string[];
  permissions: ReadonlySet<Permission>;
  sourceIp: string;
  organization?: string;
}

const DEFAULT_PATHS = [
  "resource_access.nexo-console.roles",
  "app_metadata.roles",
  "realm_access.roles",
  "roles",
];

const fullName = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

export function resolveActor(
  request: Request,
  extraRolePaths: readonly string[] = [],
  now = Date.now(),
): Actor | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) return null;
  const claims = decodeJwtPayload(match[1]);
  if (!claims) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) return null;
  const roles = rolesFromClaims(claims, [...extraRolePaths, ...DEFAULT_PATHS]);
  const username = stringClaim(claims, "preferred_username", "email", "sub") ?? "desconocido";
  return {
    sub: stringClaim(claims, "sub") ?? username,
    username,
    // Keycloak usa "name"; Supabase guarda el nombre en user_metadata.full_name.
    name: stringClaim(claims, "name") ?? fullName(getClaim(claims, "user_metadata.full_name")) ?? username,
    email: stringClaim(claims, "email"),
    roles,
    permissions: permissionsFor(roles),
    sourceIp: stringClaim(claims, "src_ip") ?? "10.20.1.99",
    organization: stringClaim(claims, "org"),
  };
}

export function isSameActor(actor: Actor, identity: string | undefined | null): boolean {
  if (!identity) return false;
  const id = identity.toLowerCase();
  return [actor.username, actor.email, actor.sub].some((v) => v?.toLowerCase() === id);
}
