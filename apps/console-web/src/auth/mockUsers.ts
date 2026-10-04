import type { Role } from "@nexo/shared/browser";
import { base64UrlEncode } from "./jwt";

/**
 * Usuarios de demostración. Replican los del realm `nexo` del laboratorio (un usuario por rol)
 * y agregan un caso de prueba con dos roles para demostrar la regla de cuatro ojos.
 */
export interface MockUser {
  username: string;
  name: string;
  email: string;
  roles: Role[];
  organization?: string;
  sourceIp: string;
  /** Usuario de prueba (no corresponde a un rol estándar). */
  testCase?: string;
}

export const MOCK_USERS: readonly MockUser[] = [
  {
    username: "admin.nexo",
    name: "Admin Nexo",
    email: "admin.nexo@ejemplo.invalid",
    roles: ["administrador"],
    sourceIp: "10.20.1.10",
  },
  {
    username: "ana.desarrollo",
    name: "Ana Rojas",
    email: "ana.desarrollo@ejemplo.invalid",
    roles: ["desarrollador"],
    sourceIp: "10.20.1.21",
  },
  {
    username: "luis.aprobador",
    name: "Luis Soto",
    email: "luis.aprobador@ejemplo.invalid",
    roles: ["aprobador"],
    sourceIp: "10.20.1.32",
  },
  {
    username: "carla.operacion",
    name: "Carla Muñoz",
    email: "carla.operacion@ejemplo.invalid",
    roles: ["operador"],
    sourceIp: "10.20.1.43",
  },
  {
    username: "pedro.auditoria",
    name: "Pedro Vargas",
    email: "pedro.auditoria@ejemplo.invalid",
    roles: ["auditor"],
    sourceIp: "10.20.1.54",
  },
  {
    username: "consumidor.demo",
    name: "Operador Telecom",
    email: "consumidor.demo@ejemplo.invalid",
    roles: ["consumidor"],
    organization: "Telecom Andina",
    sourceIp: "200.27.14.8",
  },
  {
    username: "marta.dosroles",
    name: "Marta Fuentes",
    email: "marta.dosroles@ejemplo.invalid",
    roles: ["desarrollador", "aprobador"],
    sourceIp: "10.20.1.65",
    testCase:
      "Tiene dos roles (desarrollador y aprobador): sirve para comprobar que nadie aprueba lo que creó.",
  },
];

export function findMockUser(username: string): MockUser | undefined {
  return MOCK_USERS.find((u) => u.username === username);
}

/**
 * Token sin firma (alg "none") con la misma forma de claims que Keycloak y Supabase. Solo lo
 * acepta la API simulada; la API real lo rechaza porque no está firmado.
 */
export function mockAccessToken(user: MockUser, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: "nexo-mock",
      sub: `mock-${user.username}`,
      preferred_username: user.username,
      name: user.name,
      email: user.email,
      org: user.organization,
      src_ip: user.sourceIp,
      roles: user.roles,
      resource_access: { "nexo-console": { roles: user.roles } },
      app_metadata: { roles: user.roles },
      iat: nowSeconds,
      exp: nowSeconds + 8 * 3600,
    }),
  );
  return `${header}.${payload}.`;
}
