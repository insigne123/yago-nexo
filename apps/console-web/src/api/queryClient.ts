import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui/toast-store";
import { ApiError, describeError } from "./errors";

function notify(error: unknown): void {
  const { title, description } = describeError(error);
  toast.error(title, description);
}

/**
 * Cliente de TanStack Query. Un 403 de la API siempre muestra un aviso con el permiso que
 * faltó; las mutaciones fallidas también avisan. Los 4xx no se reintentan.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.silent) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 0 || error.status >= 500))
          notify(error);
      },
    }),
    mutationCache: new MutationCache({ onError: (error) => notify(error) }),
  });
}
