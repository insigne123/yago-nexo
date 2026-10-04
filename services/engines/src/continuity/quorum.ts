/**
 * Decisión de conmutación por quórum (D-05). Tres agentes (CPD, Google Cloud y un testigo) revisan la salud
 * del sitio primario y votan. Se conmuta solo si al menos 2 de 3 coinciden en que el primario está caído; así
 * una partición de red que aísle a un solo agente no provoca que los dos sitios queden activos a la vez
 * (split brain). El agente del sitio de respaldo es el único que ejecuta la conmutación, y solo cuando él
 * mismo está sano: si el que no ve al primario es el respaldo por estar aislado, no se promueve a sí mismo.
 */
export type Vote = "primario_sano" | "primario_caido" | "sin_voto";

export interface SiteVote {
  id: string;
  role: "primario" | "respaldo" | "testigo";
  vote: Vote;
  /** Antigüedad del voto en segundos; un voto viejo no cuenta. */
  ageSec: number;
}

export interface QuorumDecision {
  conmutar: boolean;
  votosCaido: number;
  votosSano: number;
  votosValidos: number;
  quorum: number;
  motivo: string;
}

export function decideFailover(votes: readonly SiteVote[], opts: { maxAgeSec: number; backupHealthy: boolean; backupId: string }): QuorumDecision {
  const total = votes.length;
  const quorum = Math.floor(total / 2) + 1;
  const fresh = votes.filter((v) => v.ageSec <= opts.maxAgeSec && v.vote !== "sin_voto");
  const votosCaido = fresh.filter((v) => v.vote === "primario_caido").length;
  const votosSano = fresh.filter((v) => v.vote === "primario_sano").length;
  const base = { votosCaido, votosSano, votosValidos: fresh.length, quorum };
  if (fresh.length < quorum) {
    return { ...base, conmutar: false, motivo: `sin quórum: solo ${fresh.length} de ${total} agentes votaron a tiempo (se requieren ${quorum})` };
  }
  if (votosCaido < quorum) {
    return { ...base, conmutar: false, motivo: `${votosCaido} de ${total} ven el primario caído; se requieren ${quorum}` };
  }
  // El respaldo debe estar sano y participar del quórum: no se promueve un sitio que está aislado.
  const backup = votes.find((v) => v.id === opts.backupId);
  if (!opts.backupHealthy) {
    return { ...base, conmutar: false, motivo: "el sitio de respaldo no está sano: no se conmuta hacia un sitio degradado" };
  }
  if (backup && (backup.ageSec > opts.maxAgeSec || backup.vote === "sin_voto")) {
    return { ...base, conmutar: false, motivo: "el sitio de respaldo no tiene voto vigente (posible aislamiento): no se autopromueve" };
  }
  return { ...base, conmutar: true, motivo: `quórum de conmutación: ${votosCaido} de ${total} agentes ven el primario caído y el respaldo está sano` };
}
