import { afterEach, describe, expect, it } from "vitest";
import { toastStore } from "../components/ui/toast-store";
import { ApiError } from "./errors";
import { createQueryClient } from "./queryClient";

const forbidden = (permission: string) =>
  new ApiError(403, "Su rol no tiene permiso para realizar esta acción.", permission);

afterEach(() => toastStore.clear());

describe("avisos de errores de la API", () => {
  it("una acción rechazada con 403 avisa qué permiso falta", async () => {
    const client = createQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () => {
        throw forbidden("rollout:approve");
      },
    });
    await expect(mutation.execute(undefined)).rejects.toBeInstanceOf(ApiError);
    const [item] = toastStore.getSnapshot();
    expect(item?.variant).toBe("error");
    expect(item?.title).toBe("Acción no permitida");
    expect(item?.description).toContain(
      "Requiere el permiso «Aprobar despliegues a producción» (rollout:approve).",
    );
  });

  it("una consulta con 403 también avisa, salvo las marcadas como silenciosas", async () => {
    const client = createQueryClient();
    await client
      .fetchQuery({ queryKey: ["auditoria"], queryFn: async () => Promise.reject(forbidden("audit:read")) })
      .catch(() => undefined);
    expect(toastStore.getSnapshot().some((t) => t.description?.includes("(audit:read)"))).toBe(true);

    toastStore.clear();
    await client
      .fetchQuery({
        queryKey: ["me"],
        queryFn: async () => Promise.reject(forbidden("audit:read")),
        meta: { silent: true },
      })
      .catch(() => undefined);
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  it("no reintenta errores 4xx", async () => {
    const client = createQueryClient();
    let calls = 0;
    await client
      .fetchQuery({
        queryKey: ["catalogo"],
        queryFn: async () => {
          calls++;
          throw new ApiError(404, "No existe.");
        },
      })
      .catch(() => undefined);
    expect(calls).toBe(1);
  });
});
