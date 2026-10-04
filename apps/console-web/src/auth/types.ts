import type { AuthProviderKind } from "../config/runtime";

export interface AuthUser {
  /** Identificador estable (claim `sub`). */
  id: string;
  /** Nombre de usuario o correo, tal como lo registra la auditoría. */
  username: string;
  name: string;
  email?: string;
  roles: string[];
  organization?: string;
}

export interface MfaFactor {
  id: string;
  friendlyName?: string;
}

export type AuthSnapshot =
  | { status: "loading" }
  | { status: "anonymous"; error?: string }
  | { status: "mfa_challenge"; factors: MfaFactor[]; email?: string; error?: string }
  | { status: "mfa_enroll"; email?: string; error?: string }
  | { status: "authenticated"; user: AuthUser };

/** Contrato común de los proveedores de identidad de la Consola (oidc, supabase y mock). */
export interface AuthProvider {
  readonly kind: AuthProviderKind;
  /** Nombre visible del mecanismo de inicio de sesión. */
  readonly label: string;
  /** Restaura la sesión o procesa el retorno del proveedor (por ejemplo el callback de OIDC). */
  init(): Promise<void>;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  /** Token de acceso vigente para `Authorization: Bearer`, o null sin sesión. */
  getAccessToken(): Promise<string | null>;
  logout(): Promise<void>;
  /** La API respondió 401: la sesión ya no sirve. */
  handleUnauthorized(): void;
}

/** Base con el estado observable que consumen los componentes vía useSyncExternalStore. */
export abstract class ObservableAuth {
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): AuthSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected setSnapshot(next: AuthSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function sanitizeReturnTo(value: unknown, base: string): string {
  if (typeof value !== "string") return base;
  // Solo rutas internas de la Consola: evita redirecciones abiertas.
  if (!value.startsWith(base) || value.startsWith("//") || value.includes("://")) return base;
  return value;
}
