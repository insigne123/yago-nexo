import { connect as netConnect } from "node:net";
import { fetch } from "undici";

/**
 * Salud del sitio primario según cada agente (D-05): revisa el gateway, el control plane, la base de datos y
 * un recorrido sintético de extremo a extremo. El agente vota "primario_caido" solo si las comprobaciones
 * esenciales fallan de forma sostenida (varios ciclos seguidos), para no conmutar por una caída momentánea.
 */
export interface Check {
  name: string;
  essential: boolean;
  ok: boolean;
  detail?: string;
}

export async function httpOk(url: string, timeoutMs = 3000): Promise<Check> {
  const name = new URL(url).host;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return { name, essential: true, ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { name, essential: true, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function tcpOk(host: string, port: number, timeoutMs = 2500): Promise<Check> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    const done = (ok: boolean, detail?: string) => {
      sock.destroy();
      resolve({ name: `${host}:${port}`, essential: true, ok, detail });
    };
    sock.setTimeout(timeoutMs, () => done(false, "sin respuesta"));
    sock.once("connect", () => done(true));
    sock.once("error", (e) => done(false, e.message));
  });
}

export interface HealthState {
  ok: boolean;
  vote: "primario_sano" | "primario_caido";
  checks: Record<string, string>;
  failingCycles: number;
}

/**
 * Agrega las comprobaciones y aplica histéresis: hacen falta `downThreshold` ciclos seguidos con una esencial
 * caída para votar "caído", y basta un ciclo sano para volver a "sano". Evita el aleteo entre estados.
 */
export function aggregate(prev: HealthState | undefined, checks: readonly Check[], downThreshold: number): HealthState {
  const essentialDown = checks.filter((c) => c.essential && !c.ok);
  const healthy = essentialDown.length === 0;
  const failingCycles = healthy ? 0 : (prev?.failingCycles ?? 0) + 1;
  const vote = failingCycles >= downThreshold ? "primario_caido" : "primario_sano";
  return {
    ok: healthy,
    vote,
    failingCycles,
    checks: Object.fromEntries(checks.map((c) => [c.name, c.ok ? "ok" : (c.detail ?? "caído")])),
  };
}
