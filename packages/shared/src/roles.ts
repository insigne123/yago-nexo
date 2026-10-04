/**
 * Roles y matriz rol-permiso de Nexo (BT-026: mínimo privilegio y segregación de funciones).
 *
 * La matriz es la fuente única: la API la usa para autorizar cada acción y la Consola la
 * exporta como documento ("Cumplimiento → Matriz rol-permiso").
 */

export const ROLES = [
  "administrador",
  "desarrollador",
  "aprobador",
  "operador",
  "auditor",
  "consumidor",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  administrador: "Configura la plataforma, los conectores y los parámetros. No aprueba sus propios cambios.",
  desarrollador: "Diseña y publica APIs y flujos en ambientes no productivos. No promueve a producción.",
  aprobador: "Aprueba promociones a producción, bloqueos, reprocesos y conmutaciones. No desarrolla.",
  operador: "Opera la plataforma en régimen: monitorea, ejecuta despliegues aprobados y simulacros.",
  auditor: "Consulta auditoría, matrices y evidencias. Solo lectura.",
  consumidor: "Consulta el catálogo y su propio consumo.",
};

export const PERMISSIONS = [
  "catalog:read",
  "catalog:write",
  "impact:simulate",
  "discovery:read",
  "discovery:scan",
  "discovery:triage",
  "anomaly:read",
  "anomaly:rules:write",
  "anomaly:block:approve",
  "anomaly:block:release",
  "rollout:read",
  "rollout:create",
  "rollout:approve",
  "rollout:abort",
  "continuity:read",
  "continuity:drill",
  "continuity:failback:approve",
  "usage:read:all",
  "usage:read:own",
  "dlq:read",
  "dlq:reprocess:approve",
  "audit:read",
  "audit:verify",
  "compliance:read",
  "export:create",
  "admin:connectors:write",
  "admin:settings:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, readonly Permission[]> = {
  administrador: [
    "catalog:read",
    "catalog:write",
    "impact:simulate",
    "discovery:read",
    "discovery:scan",
    "anomaly:read",
    "anomaly:rules:write",
    "rollout:read",
    "continuity:read",
    "usage:read:all",
    "dlq:read",
    "compliance:read",
    "export:create",
    "admin:connectors:write",
    "admin:settings:write",
  ],
  desarrollador: [
    "catalog:read",
    "catalog:write",
    "impact:simulate",
    "discovery:read",
    "anomaly:read",
    "rollout:read",
    "rollout:create",
    "usage:read:all",
    "dlq:read",
  ],
  aprobador: [
    "catalog:read",
    "impact:simulate",
    "discovery:read",
    "discovery:triage",
    "anomaly:read",
    "anomaly:block:approve",
    "anomaly:block:release",
    "rollout:read",
    "rollout:approve",
    "rollout:abort",
    "continuity:read",
    "continuity:failback:approve",
    "usage:read:all",
    "dlq:read",
    "dlq:reprocess:approve",
    "compliance:read",
  ],
  operador: [
    "catalog:read",
    "discovery:read",
    "discovery:scan",
    "anomaly:read",
    "rollout:read",
    "rollout:abort",
    "continuity:read",
    "continuity:drill",
    "usage:read:all",
    "dlq:read",
  ],
  auditor: [
    "catalog:read",
    "discovery:read",
    "anomaly:read",
    "rollout:read",
    "continuity:read",
    "usage:read:all",
    "dlq:read",
    "audit:read",
    "audit:verify",
    "compliance:read",
    "export:create",
  ],
  consumidor: ["catalog:read", "usage:read:own"],
};

export function permissionsFor(roles: readonly string[]): Set<Permission> {
  const result = new Set<Permission>();
  for (const role of roles) {
    if ((ROLES as readonly string[]).includes(role)) {
      for (const p of MATRIX[role as Role]) result.add(p);
    }
  }
  return result;
}

export function can(roles: readonly string[], permission: Permission): boolean {
  return permissionsFor(roles).has(permission);
}

/** Matriz completa como filas, para exportarla como documento de cumplimiento. */
export function permissionMatrix(): Array<{ permission: Permission } & Record<Role, boolean>> {
  return PERMISSIONS.map((permission) => {
    const row = { permission } as { permission: Permission } & Record<Role, boolean>;
    for (const role of ROLES) row[role] = MATRIX[role].includes(permission);
    return row;
  });
}

/**
 * Acciones que exigen segregación: quien inicia no puede aprobar (cuatro ojos).
 * La API verifica que actor !== aprobador en estas operaciones.
 */
export const FOUR_EYES_ACTIONS = [
  "rollout:approve",
  "anomaly:block:approve",
  "dlq:reprocess:approve",
  "continuity:failback:approve",
] as const satisfies readonly Permission[];
