import type { Session } from "@supabase/supabase-js";
import { createContext, useContext } from "react";
import type { SessionContext } from "../lib/permissions";

export type AuthStatus =
  "cargando" | "sin_sesion" | "requiere_enrolamiento" | "requiere_verificacion" | "sin_acceso" | "lista";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** Factor TOTP verificado (para el desafío de MFA). */
  factorId: string | null;
  /** Pertenencias y permisos (disponible cuando status = "lista"). */
  ctx: SessionContext | null;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthContext no está disponible");
  return value;
}

/** Contexto de permisos de una sesión lista (las pantallas internas solo existen en ese caso). */
export function useSessionContext(): SessionContext {
  const { ctx } = useAuth();
  if (!ctx) throw new Error("La sesión no está lista");
  return ctx;
}
