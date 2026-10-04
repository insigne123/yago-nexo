import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchMyContext } from "../lib/api";
import { toSessionContext } from "../lib/permissions";
import { friendlyError, useSupabase } from "../lib/supabase";
import { AuthContext, type AuthState } from "./session";

type CoreState = Omit<AuthState, "refresh" | "signOut">;

const SIGNED_OUT: CoreState = { status: "sin_sesion", session: null, factorId: null, ctx: null, error: null };

/**
 * Estado de la sesión: correo y contraseña, luego MFA TOTP obligatorio (enrolamiento la
 * primera vez, desafío en los ingresos siguientes) y, con aal2, las pertenencias de la mesa.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = useSupabase();
  const [state, setState] = useState<CoreState>({ ...SIGNED_OUT, status: "cargando" });
  const evaluation = useRef(0);

  const evaluate = useCallback(
    async (session: Session | null) => {
      const run = ++evaluation.current;
      const commit = (next: CoreState) => {
        if (run === evaluation.current) setState(next);
      };
      if (!session) {
        commit(SIGNED_OUT);
        return;
      }
      try {
        const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalError) throw aalError;
        if (aal.currentLevel !== "aal2") {
          const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
          if (factorsError) throw factorsError;
          const verified = factors.totp[0];
          commit({
            status: verified ? "requiere_verificacion" : "requiere_enrolamiento",
            session,
            factorId: verified?.id ?? null,
            ctx: null,
            error: null,
          });
          return;
        }
        const ctx = toSessionContext(await fetchMyContext(supabase));
        commit({
          status: ctx && ctx.memberships.length > 0 ? "lista" : "sin_acceso",
          session,
          factorId: null,
          ctx,
          error: null,
        });
      } catch (err) {
        commit({ ...SIGNED_OUT, error: friendlyError(err) });
      }
    },
    [supabase],
  );

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // supabase-js recomienda no llamar a la API dentro del callback: se difiere.
      if (event === "SIGNED_OUT") {
        evaluation.current++;
        setState(SIGNED_OUT);
        return;
      }
      if (event === "TOKEN_REFRESHED") {
        setState((current) => ({ ...current, session }));
        return;
      }
      window.setTimeout(() => void evaluate(session), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [supabase, evaluate]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await evaluate(data.session);
  }, [supabase, evaluate]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, [supabase]);

  const value = useMemo<AuthState>(() => ({ ...state, refresh, signOut }), [state, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
