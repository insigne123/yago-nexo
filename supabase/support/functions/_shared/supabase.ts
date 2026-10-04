// Clientes de Supabase para las funciones. SUPABASE_URL, SUPABASE_ANON_KEY y
// SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase en cada función; no se configuran a mano.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** Cliente con la clave de servicio: omite la RLS. Úsese solo en el backend. */
export function adminClient(): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cliente que actúa como el usuario del JWT recibido (aplica su RLS y su nivel de MFA). */
export function userClient(authorization: string): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
}

export type { SupabaseClient };
