import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "../config/runtime";
import { decodeJwtPayload, rolesFromClaims, stringClaim } from "./jwt";
import { ObservableAuth, type AuthProvider, type AuthUser, type MfaFactor } from "./types";

export interface TotpEnrollment {
  factorId: string;
  /** Imagen del código QR lista para usar en <img src>. */
  qrCode: string;
  secret: string;
}

function friendlyError(message: string | undefined): string {
  if (!message) return "No se pudo completar la operación.";
  if (/invalid login credentials/i.test(message)) return "El correo o la contraseña no son correctos.";
  if (/email not confirmed/i.test(message)) return "El correo aún no está confirmado.";
  if (/invalid totp|invalid code|code.*(expired|invalid)/i.test(message))
    return "El código no es válido o expiró. Ingrese el código actual de su aplicación autenticadora.";
  if (/rate limit|too many/i.test(message))
    return "Demasiados intentos. Espere un momento y vuelva a intentar.";
  return message;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * supabase-js antepone `data:image/svg+xml;utf-8,` al SVG sin codificarlo; un `#` en el SVG
 * cortaría la URL, así que se vuelve a codificar el contenido.
 */
export function qrToDataUrl(qr: string): string {
  const prefix = /^data:image\/svg\+xml;(?:charset=)?utf-?8,/i;
  const raw = prefix.test(qr) ? qr.replace(prefix, "") : qr;
  if (raw.trimStart().startsWith("<")) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
  return qr.startsWith("data:") ? qr : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

/**
 * Inicio de sesión de la demo con Supabase Auth: correo y contraseña, más segundo factor TOTP.
 * Si el usuario tiene un factor verificado se exige el desafío (nivel aal2); si el proyecto exige
 * MFA y el usuario no tiene factor, se le muestra el enrolamiento antes de entrar.
 */
export class SupabaseAuthProvider extends ObservableAuth implements AuthProvider {
  readonly kind = "supabase" as const;
  readonly label = "Correo y contraseña con segundo factor";
  private readonly client: SupabaseClient;

  constructor(private readonly config: SupabaseConfig) {
    super();
    this.client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: "nexo-console-auth",
      },
    });
  }

  async init(): Promise<void> {
    this.client.auth.onAuthStateChange((event, session) => {
      // No se llaman otros métodos de Supabase dentro del callback (puede bloquearse): se difiere.
      if (event === "SIGNED_OUT") {
        this.setSnapshot({ status: "anonymous" });
        return;
      }
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        window.setTimeout(() => void this.evaluateSafely(session), 0);
      }
    });
    const { data } = await this.client.auth.getSession();
    await this.evaluateSafely(data.session);
  }

  async signIn(email: string, password: string): Promise<void> {
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) {
        this.setSnapshot({ status: "anonymous", error: friendlyError(error.message) });
        return;
      }
      await this.evaluateSafely(data.session);
    } catch (error) {
      this.setSnapshot({
        status: "anonymous",
        error: `No se pudo contactar al servicio de identidad. ${describe(error)}`,
      });
    }
  }

  async verifyTotp(factorId: string, code: string): Promise<void> {
    const { error } = await this.client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      const current = this.getSnapshot();
      if (current.status === "mfa_challenge")
        this.setSnapshot({ ...current, error: friendlyError(error.message) });
      return;
    }
    const { data } = await this.client.auth.getSession();
    await this.evaluateSafely(data.session);
  }

  /** Crea un factor TOTP sin verificar y devuelve el QR para la aplicación autenticadora. */
  async startEnrollment(): Promise<TotpEnrollment> {
    const factors = await this.client.auth.mfa.listFactors();
    for (const factor of factors.data?.all ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await this.client.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await this.client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Consola Nexo ${new Date().toISOString().slice(0, 10)}`,
      issuer: "Yago Nexo",
    });
    if (error || !data) throw new Error(friendlyError(error?.message));
    return { factorId: data.id, qrCode: qrToDataUrl(data.totp.qr_code), secret: data.totp.secret };
  }

  async confirmEnrollment(factorId: string, code: string): Promise<string | null> {
    const { error } = await this.client.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return friendlyError(error.message);
    const { data } = await this.client.auth.getSession();
    await this.evaluateSafely(data.session);
    return null;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.getSnapshot().status !== "authenticated") return null;
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async logout(): Promise<void> {
    await this.client.auth.signOut();
    this.setSnapshot({ status: "anonymous" });
  }

  handleUnauthorized(): void {
    void this.client.auth.signOut();
    this.setSnapshot({ status: "anonymous", error: "La sesión ya no es válida. Inicie sesión nuevamente." });
  }

  /** Como evaluate, pero un error (token ilegible, red) deja la sesión anónima con un mensaje claro. */
  private async evaluateSafely(session: Session | null): Promise<void> {
    try {
      await this.evaluate(session);
    } catch (error) {
      await this.client.auth.signOut({ scope: "local" }).catch(() => undefined);
      this.setSnapshot({ status: "anonymous", error: `No se pudo validar la sesión. ${describe(error)}` });
    }
  }

  private async evaluate(session: Session | null): Promise<void> {
    if (!session) {
      this.setSnapshot({ status: "anonymous" });
      return;
    }
    const email = session.user.email;
    const { data: aal, error: aalError } = await this.client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError || !aal) throw aalError ?? new Error("No se pudo determinar el nivel de autenticación.");
    if (aal?.currentLevel !== "aal2") {
      if (aal?.nextLevel === "aal2") {
        const { data } = await this.client.auth.mfa.listFactors();
        const factors: MfaFactor[] = (data?.totp ?? []).map((f) => ({
          id: f.id,
          friendlyName: f.friendly_name,
        }));
        if (factors.length > 0) {
          this.setSnapshot({ status: "mfa_challenge", factors, email });
          return;
        }
      }
      if (this.config.requireMfa) {
        this.setSnapshot({ status: "mfa_enroll", email });
        return;
      }
    }
    this.setSnapshot({ status: "authenticated", user: this.toUser(session) });
  }

  private toUser(session: Session): AuthUser {
    const claims = decodeJwtPayload(session.access_token);
    const paths = [this.config.rolesClaimPath, "app_metadata.roles", "user_metadata.roles"];
    const metadata = session.user.app_metadata as Record<string, unknown>;
    const fromMetadata = Array.isArray(metadata.roles)
      ? metadata.roles.filter((r): r is string => typeof r === "string")
      : [];
    const roles = rolesFromClaims(claims, paths);
    return {
      id: session.user.id,
      username: session.user.email ?? session.user.id,
      name:
        stringClaim(session.user.user_metadata as Record<string, unknown>, "full_name", "name") ??
        session.user.email ??
        session.user.id,
      email: session.user.email,
      roles: roles.length > 0 ? roles : fromMetadata,
    };
  }
}
