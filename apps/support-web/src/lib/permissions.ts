// Qué puede hacer cada persona en la interfaz. Refleja las reglas de RLS y de las RPC de la
// base de datos (supabase/support/migrations): la interfaz solo oculta lo que la base de
// datos igual rechazaría.
import type { MemberRole, SessionContextRaw } from "./types";

export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  isProvider: boolean;
  role: MemberRole;
  displayName: string;
}

export interface SessionContext {
  userId: string;
  email: string | null;
  mfaOk: boolean;
  isStaff: boolean;
  isSupervisor: boolean;
  memberships: Membership[];
}

export function toSessionContext(raw: SessionContextRaw): SessionContext | null {
  if (!raw.user_id) return null;
  return {
    userId: raw.user_id,
    email: raw.email,
    mfaOk: raw.mfa_ok,
    isStaff: raw.is_staff,
    isSupervisor: raw.is_supervisor,
    memberships: raw.memberships.map((m) => ({
      orgId: m.org_id,
      orgName: m.org_name,
      orgSlug: m.org_slug,
      isProvider: m.is_provider,
      role: m.role,
      displayName: m.display_name,
    })),
  };
}

export type Capability =
  | "ticket:create"
  | "ticket:comment"
  | "ticket:attach"
  | "ticket:view_internal"
  | "ticket:note_internal"
  | "ticket:change_status"
  | "ticket:assign"
  | "ticket:pause"
  | "ticket:escalate"
  | "ticket:reclassify"
  | "ticket:flag_security"
  | "quarantine:review"
  | "pause:acknowledge"
  | "remote:request"
  | "remote:decide"
  | "remote:revoke"
  | "queue:view"
  | "oncall:manage"
  | "incident:manage"
  | "patch:manage"
  | "patch:approve"
  | "report:view"
  | "report:generate"
  | "documents:view";

const STAFF_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "ticket:view_internal",
  "ticket:note_internal",
  "ticket:change_status",
  "ticket:assign",
  "ticket:pause",
  "ticket:escalate",
  "ticket:reclassify",
  "ticket:flag_security",
  "quarantine:review",
  "remote:request",
  "queue:view",
  "oncall:manage",
  "incident:manage",
  "patch:manage",
  "report:generate",
]);

export function hasRole(ctx: SessionContext, roles: MemberRole[], orgId?: string | null): boolean {
  return ctx.memberships.some((m) => roles.includes(m.role) && (orgId === undefined || m.orgId === orgId));
}

/**
 * ¿Puede la sesión realizar la acción? `orgId` es la organización del ticket o documento
 * (si se omite, basta con tener el rol en alguna organización).
 */
export function can(ctx: SessionContext | null, capability: Capability, orgId?: string | null): boolean {
  if (!ctx || !ctx.mfaOk) return false;
  if (STAFF_ONLY.has(capability)) return ctx.isStaff;
  switch (capability) {
    case "ticket:create":
      return ctx.isStaff || hasRole(ctx, ["reportante", "contraparte"], orgId);
    case "ticket:comment":
    case "ticket:attach":
      return ctx.isStaff || hasRole(ctx, ["reportante", "contraparte"], orgId);
    case "pause:acknowledge":
    case "remote:decide":
      return hasRole(ctx, ["contraparte"], orgId);
    case "remote:revoke":
      return ctx.isStaff || hasRole(ctx, ["contraparte"], orgId);
    case "patch:approve":
      return ctx.isSupervisor || hasRole(ctx, ["contraparte"], orgId);
    case "report:view":
    case "documents:view":
      return ctx.isStaff || ctx.memberships.length > 0;
    default:
      return false;
  }
}

/** Organizaciones donde la persona puede abrir tickets (clientes). */
export function ticketOrgs(ctx: SessionContext): Membership[] {
  return ctx.memberships.filter(
    (m) => !m.isProvider && (m.role === "reportante" || m.role === "contraparte"),
  );
}
