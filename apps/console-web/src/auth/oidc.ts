import { UserManager, WebStorageStateStore, type User, type UserManagerSettings } from "oidc-client-ts";
import type { OidcConfig } from "../config/runtime";
import { decodeJwtPayload, rolesFromClaims, stringClaim, type Claims } from "./jwt";
import { ObservableAuth, sanitizeReturnTo, type AuthProvider, type AuthUser } from "./types";

/** Rutas propias del flujo OIDC (relativas a la base de la Consola). */
export const OIDC_CALLBACK_PATH = "auth/callback";
export const OIDC_SILENT_CALLBACK_PATH = "auth/silent-callback";

function appBase(): string {
  return import.meta.env.BASE_URL;
}

function absolute(path: string): string {
  return new URL(`${appBase()}${path}`, window.location.origin).href;
}

function settingsFor(config: OidcConfig): UserManagerSettings {
  return {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: absolute(OIDC_CALLBACK_PATH),
    silent_redirect_uri: absolute(OIDC_SILENT_CALLBACK_PATH),
    post_logout_redirect_uri: absolute(""),
    response_type: "code",
    scope: config.scope,
    // Renovación silenciosa: usa el refresh token de Keycloak y, si no hay, un iframe oculto.
    automaticSilentRenew: true,
    monitorSession: false,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  };
}

/** Atiende el iframe de renovación silenciosa sin montar la aplicación. */
export async function completeSilentRenew(config: OidcConfig): Promise<void> {
  await new UserManager(settingsFor(config)).signinSilentCallback();
}

export function isSilentCallback(pathname: string): boolean {
  return pathname === `${appBase()}${OIDC_SILENT_CALLBACK_PATH}`;
}

/** Inicio de sesión con el Keycloak institucional: Authorization Code + PKCE (oidc-client-ts). */
export class OidcAuthProvider extends ObservableAuth implements AuthProvider {
  readonly kind = "oidc" as const;
  readonly label = "Cuenta institucional (Keycloak)";
  private readonly manager: UserManager;

  constructor(private readonly config: OidcConfig) {
    super();
    this.manager = new UserManager(settingsFor(config));
    this.manager.events.addUserLoaded((user) => this.applyUser(user));
    this.manager.events.addUserUnloaded(() => this.setSnapshot({ status: "anonymous" }));
    this.manager.events.addAccessTokenExpired(() => {
      this.setSnapshot({ status: "anonymous", error: "La sesión expiró. Inicie sesión nuevamente." });
    });
    this.manager.events.addSilentRenewError((error) => {
      console.warn("No se pudo renovar la sesión en segundo plano", error);
    });
  }

  async init(): Promise<void> {
    const url = new URL(window.location.href);
    const isCallback =
      url.pathname === `${appBase()}${OIDC_CALLBACK_PATH}` &&
      (url.searchParams.has("code") || url.searchParams.has("error"));
    if (isCallback) {
      try {
        const user = await this.manager.signinRedirectCallback();
        window.history.replaceState(null, "", sanitizeReturnTo(user.state, appBase()));
        this.applyUser(user);
      } catch (error) {
        window.history.replaceState(null, "", appBase());
        const detail = error instanceof Error ? error.message : String(error);
        this.setSnapshot({
          status: "anonymous",
          error: `No se pudo completar el inicio de sesión: ${detail}`,
        });
      }
      return;
    }
    const user = await this.manager.getUser().catch(() => null);
    if (user && !user.expired) this.applyUser(user);
    else this.setSnapshot({ status: "anonymous" });
  }

  /** Redirige al formulario de Keycloak y vuelve a la misma ruta de la Consola. */
  async login(returnTo: string = window.location.pathname + window.location.search): Promise<void> {
    await this.manager.signinRedirect({ state: sanitizeReturnTo(returnTo, appBase()) });
  }

  async getAccessToken(): Promise<string | null> {
    const user = await this.manager.getUser();
    return user && !user.expired ? user.access_token : null;
  }

  async logout(): Promise<void> {
    const user = await this.manager.getUser().catch(() => null);
    await this.manager.removeUser();
    this.setSnapshot({ status: "anonymous" });
    // Cierra también la sesión en Keycloak (end_session_endpoint).
    await this.manager.signoutRedirect(user?.id_token ? { id_token_hint: user.id_token } : undefined);
  }

  handleUnauthorized(): void {
    void this.manager.removeUser();
    this.setSnapshot({ status: "anonymous", error: "La sesión ya no es válida. Inicie sesión nuevamente." });
  }

  private applyUser(user: User): void {
    const access: Claims | null = decodeJwtPayload(user.access_token);
    const profile = user.profile as unknown as Claims;
    const paths = [this.config.rolesClaimPath, "realm_access.roles", "roles"];
    const roles = rolesFromClaims(access, paths);
    const authUser: AuthUser = {
      id: user.profile.sub,
      username: stringClaim(profile, "preferred_username", "email") ?? user.profile.sub,
      name: stringClaim(profile, "name", "preferred_username") ?? user.profile.sub,
      email: stringClaim(profile, "email"),
      roles: roles.length > 0 ? roles : rolesFromClaims(profile, paths),
    };
    this.setSnapshot({ status: "authenticated", user: authUser });
  }
}
