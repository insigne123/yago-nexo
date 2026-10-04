import type { Wso2Client } from "./client.js";
import type { ApiRevision } from "./types.js";

/** Máximo de revisiones por API que admite WSO2 API Manager por defecto. */
export const DEFAULT_MAX_REVISIONS = 5;

/**
 * Libera espacio para una revisión nueva borrando las más antiguas que no están desplegadas en ningún gateway.
 * Nunca borra una revisión desplegada: si todas lo están, falla con un mensaje claro.
 */
export async function pruneRevisions(wso2: Wso2Client, apiId: string, max = DEFAULT_MAX_REVISIONS, keep: readonly string[] = []): Promise<string[]> {
  const revs = (await wso2.publisher.listRevisions(apiId)).list;
  const deleted: string[] = [];
  if (revs.length < max) return deleted;
  const candidates = revs
    .filter((r: ApiRevision) => (r.deploymentInfo ?? []).length === 0 && !keep.includes(r.id))
    .sort((a, b) => (a.createdTime ?? 0) - (b.createdTime ?? 0));
  let count = revs.length;
  for (const r of candidates) {
    if (count < max) break;
    await wso2.publisher.deleteRevision(apiId, r.id);
    deleted.push(r.displayName ?? r.id);
    count--;
  }
  if (count >= max) {
    throw new Error(`La API tiene ${count} revisiones y todas están desplegadas o reservadas: no se puede crear otra sin retirar una.`);
  }
  return deleted;
}
