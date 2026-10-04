import { PERMISSIONS, ROLES, type Permission, type Role } from "@nexo/shared/browser";

/** Nombres legibles de cada permiso de la matriz (BT-026), para tooltips y documentos. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "catalog:read": "Consultar el catálogo",
  "catalog:write": "Editar metadatos del catálogo",
  "impact:simulate": "Simular el impacto de un cambio",
  "discovery:read": "Consultar el descubrimiento",
  "discovery:scan": "Iniciar escaneos de descubrimiento",
  "discovery:triage": "Clasificar hallazgos",
  "anomaly:read": "Consultar anomalías",
  "anomaly:rules:write": "Crear y modificar reglas de anomalías",
  "anomaly:block:approve": "Aprobar o descartar bloqueos",
  "anomaly:block:release": "Liberar bloqueos",
  "rollout:read": "Consultar despliegues",
  "rollout:create": "Crear despliegues",
  "rollout:approve": "Aprobar despliegues a producción",
  "rollout:abort": "Detener y revertir despliegues",
  "continuity:read": "Consultar la continuidad",
  "continuity:drill": "Iniciar simulacros de conmutación",
  "continuity:failback:approve": "Aprobar el retorno al sitio principal",
  "usage:read:all": "Consultar el consumo de todos",
  "usage:read:own": "Consultar el consumo propio",
  "dlq:read": "Consultar mensajes fallidos",
  "dlq:reprocess:approve": "Aprobar el reproceso de mensajes",
  "audit:read": "Consultar la auditoría",
  "audit:verify": "Verificar la integridad de la auditoría",
  "compliance:read": "Consultar las matrices de cumplimiento",
  "export:create": "Generar paquetes de exportación",
  "admin:connectors:write": "Configurar conectores",
  "admin:settings:write": "Modificar parámetros de la plataforma",
};

export const ROLE_LABELS: Record<Role, string> = {
  administrador: "Administrador",
  desarrollador: "Desarrollador",
  aprobador: "Aprobador",
  operador: "Operador",
  auditor: "Auditor",
  consumidor: "Consumidor",
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionLabel(permission: string): string {
  return isPermission(permission) ? PERMISSION_LABELS[permission] : permission;
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role;
}

/** Texto estándar cuando falta un permiso: nombre legible y clave técnica. */
export function requiredPermissionText(permissions: readonly string[]): string {
  if (permissions.length === 0) return "";
  const list = permissions.map((p) => `«${permissionLabel(p)}» (${p})`);
  return permissions.length === 1
    ? `Requiere el permiso ${list[0]}.`
    : `Requiere alguno de estos permisos: ${list.join(", ")}.`;
}
