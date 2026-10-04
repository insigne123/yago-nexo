import { createContext, useContext } from "react";
import type { RuntimeConfig } from "./runtime";

export interface RuntimeInfo {
  config: RuntimeConfig;
  /** Datos simulados activos (MSW). */
  mock: boolean;
}

export const RuntimeContext = createContext<RuntimeInfo | null>(null);

export function useRuntime(): RuntimeInfo {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("Falta la configuración de la Consola en el árbol de componentes.");
  return value;
}
