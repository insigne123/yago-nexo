import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { friendlyError } from "./supabase";

export interface ActionState {
  busy: boolean;
  error: string | null;
  ok: string | null;
}

/** Ejecuta una acción, muestra el resultado y refresca las consultas indicadas. */
export function useRunAction(invalidate: QueryKey[] = []) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ActionState>({ busy: false, error: null, ok: null });

  async function run(fn: () => Promise<unknown>, okMessage: string): Promise<boolean> {
    setState({ busy: true, error: null, ok: null });
    try {
      await fn();
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      setState({ busy: false, error: null, ok: okMessage });
      return true;
    } catch (err) {
      setState({ busy: false, error: friendlyError(err), ok: null });
      return false;
    }
  }

  return { ...state, run };
}
