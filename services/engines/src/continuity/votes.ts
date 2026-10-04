import { fetch } from "undici";

/**
 * Votos de los agentes en etcd (API v3 por HTTP). etcd es el anclaje de quórum: vive fuera de los sitios que
 * se protegen y es tolerante a particiones, así que es el lugar correcto para coordinar la conmutación (no la
 * propia base que se está respaldando). Cada agente renueva su voto con un arrendamiento (lease) de corta
 * duración; si el agente se cae o queda aislado, su voto expira y deja de contar para el quórum.
 */
export interface StoredVote {
  id: string;
  role: "primario" | "respaldo" | "testigo";
  vote: "primario_sano" | "primario_caido" | "sin_voto";
  checks: Record<string, string>;
  ts: string;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export class EtcdVotes {
  private leaseId?: string;

  constructor(
    private readonly url: string,
    private readonly prefix = "/nexo/continuidad/voto",
    private readonly ttlSec = 15,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.url}/v3/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`etcd ${path} respondió ${res.status}`);
    return (await res.json()) as T;
  }

  /** Arrendamiento vigente (se crea uno nuevo si no hay o si expiró); mantiene vivo el voto del agente. */
  private async lease(): Promise<string> {
    if (this.leaseId) {
      const keep = await this.post<{ result?: { TTL?: string } }>("lease/keepalive", { ID: this.leaseId }).catch(() => undefined);
      if (keep?.result?.TTL && Number(keep.result.TTL) > 0) return this.leaseId;
      this.leaseId = undefined;
    }
    const granted = await this.post<{ ID: string }>("lease/grant", { TTL: this.ttlSec });
    this.leaseId = granted.ID;
    return this.leaseId;
  }

  async cast(vote: StoredVote): Promise<void> {
    const lease = await this.lease();
    await this.post("kv/put", { key: b64(`${this.prefix}/${vote.id}`), value: b64(JSON.stringify(vote)), lease });
  }

  /** Todos los votos vigentes (los expirados ya no están en etcd). */
  async all(): Promise<StoredVote[]> {
    const rangeEnd = b64(`${this.prefix}0`); // el byte siguiente a "/" delimita el prefijo
    const res = await this.post<{ kvs?: Array<{ value: string }> }>("kv/range", { key: b64(`${this.prefix}/`), range_end: rangeEnd });
    return (res.kvs ?? []).map((kv) => JSON.parse(unb64(kv.value)) as StoredVote);
  }

  async release(): Promise<void> {
    if (this.leaseId) await this.post("lease/revoke", { ID: this.leaseId }).catch(() => undefined);
  }
}
