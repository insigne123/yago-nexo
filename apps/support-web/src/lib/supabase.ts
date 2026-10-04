import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext } from "react";
import type { RuntimeConfig } from "../config/runtime-config";

export const BUCKET = "nexo-sd-adjuntos";

export function createSupabase(config: RuntimeConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // Clave propia: el proyecto de Supabase es compartido con otro producto.
      storageKey: "nexo-sd-auth",
    },
  });
}

export const SupabaseContext = createContext<SupabaseClient | null>(null);
export const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export function useSupabase(): SupabaseClient {
  const client = useContext(SupabaseContext);
  if (!client) throw new Error("SupabaseContext no está disponible");
  return client;
}

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error("RuntimeConfigContext no está disponible");
  return config;
}

/** Convierte el error de Supabase en un mensaje para la persona. */
export function friendlyError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  // Los errores de la mesa vienen como "nexo_sd: <mensaje en español>".
  const match = /nexo_sd:\s*(.+)$/s.exec(message);
  if (match?.[1]) return match[1];
  if (/row-level security|permission denied/i.test(message))
    return "No tiene permiso para realizar esta acción.";
  if (/Failed to fetch|NetworkError/i.test(message))
    return "No hay conexión con el servidor. Intente nuevamente.";
  return message;
}
