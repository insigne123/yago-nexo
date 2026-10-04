import { createContext, useContext, useSyncExternalStore } from "react";
import type { AnyAuthProvider } from "./create";
import type { AuthSnapshot } from "./types";

export const AuthContext = createContext<AnyAuthProvider | null>(null);

export function useAuthProvider(): AnyAuthProvider {
  const provider = useContext(AuthContext);
  if (!provider) throw new Error("Falta el proveedor de identidad en el árbol de componentes.");
  return provider;
}

export function useAuthSnapshot(): AuthSnapshot {
  const provider = useAuthProvider();
  return useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot);
}
