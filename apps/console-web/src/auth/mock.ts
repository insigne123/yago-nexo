import { findMockUser, MOCK_USERS, mockAccessToken, type MockUser } from "./mockUsers";
import { ObservableAuth, type AuthProvider, type AuthUser } from "./types";

const SESSION_KEY = "nexo-mock-user";

function toAuthUser(user: MockUser): AuthUser {
  return {
    id: `mock-${user.username}`,
    username: user.username,
    name: user.name,
    email: user.email,
    roles: [...user.roles],
    organization: user.organization,
  };
}

/** Proveedor de demostración: selector de usuario por rol, sin proveedor de identidad real. */
export class MockAuthProvider extends ObservableAuth implements AuthProvider {
  readonly kind = "mock" as const;
  readonly label = "Usuarios de demostración";
  readonly users = MOCK_USERS;

  constructor(private readonly storage: Storage | undefined = globalThis.sessionStorage) {
    super();
  }

  async init(): Promise<void> {
    const username = this.read();
    const user = username ? findMockUser(username) : undefined;
    this.setSnapshot(user ? { status: "authenticated", user: toAuthUser(user) } : { status: "anonymous" });
  }

  loginAs(username: string): void {
    const user = findMockUser(username);
    if (!user) throw new Error(`Usuario de demostración desconocido: ${username}`);
    try {
      this.storage?.setItem(SESSION_KEY, username);
    } catch {
      // Sin almacenamiento disponible la sesión dura lo que dure la página.
    }
    this.setSnapshot({ status: "authenticated", user: toAuthUser(user) });
  }

  async getAccessToken(): Promise<string | null> {
    const snapshot = this.getSnapshot();
    if (snapshot.status !== "authenticated") return null;
    const user = findMockUser(snapshot.user.username);
    return user ? mockAccessToken(user) : null;
  }

  async logout(): Promise<void> {
    try {
      this.storage?.removeItem(SESSION_KEY);
    } catch {
      // Nada que limpiar.
    }
    this.setSnapshot({ status: "anonymous" });
  }

  handleUnauthorized(): void {
    void this.logout();
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
  }
}
