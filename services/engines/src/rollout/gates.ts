/** Umbrales de un despliegue progresivo (los define quien lo solicita). */
export interface Thresholds {
  maxErrorRate: number;
  maxP99Ms: number;
  minRequests: number;
}

export interface VersionMetrics {
  requests: number;
  errors: number;
  p99Ms?: number;
}

export interface StepMetrics {
  candidate: VersionMetrics;
  stable: VersionMetrics;
}

export type Decision = { action: "esperar" | "avanzar" | "revertir"; reason: string };

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
export const errorRate = (m: VersionMetrics) => (m.requests > 0 ? m.errors / m.requests : 0);

/**
 * Compuerta de cada paso: con tráfico suficiente, revierte en cuanto el candidato supera un umbral y es peor
 * que la versión estable (si ambas fallan, el problema está fuera del candidato y se espera). Avanza solo
 * cuando se cumplió la duración del paso con tráfico suficiente y dentro de los umbrales.
 */
export function decide(m: StepMetrics, t: Thresholds, elapsedSec: number, durationSec: number): Decision {
  const cErr = errorRate(m.candidate);
  const sErr = errorRate(m.stable);
  if (m.candidate.requests >= t.minRequests) {
    const errorsBad = cErr > t.maxErrorRate;
    const latencyBad = m.candidate.p99Ms !== undefined && m.candidate.p99Ms > t.maxP99Ms;
    const stableErrorsBad = m.stable.requests >= t.minRequests && sErr > t.maxErrorRate;
    const stableLatencyBad = m.stable.requests >= t.minRequests && m.stable.p99Ms !== undefined && m.stable.p99Ms > t.maxP99Ms;
    if (errorsBad && !(stableErrorsBad && sErr >= cErr)) {
      return { action: "revertir", reason: `tasa de error del candidato ${pct(cErr)} supera el umbral de ${pct(t.maxErrorRate)} (estable: ${pct(sErr)})` };
    }
    if (latencyBad && !(stableLatencyBad && (m.stable.p99Ms ?? 0) >= (m.candidate.p99Ms ?? 0))) {
      return { action: "revertir", reason: `latencia p99 del candidato ${Math.round(m.candidate.p99Ms!)} ms supera el umbral de ${t.maxP99Ms} ms` };
    }
    if (errorsBad || latencyBad) {
      return { action: "esperar", reason: "ambas versiones superan los umbrales: la falla parece externa al candidato" };
    }
  }
  if (elapsedSec < durationSec) return { action: "esperar", reason: `paso en observación (${Math.floor(elapsedSec)} de ${durationSec} s)` };
  if (m.candidate.requests < t.minRequests) {
    return { action: "esperar", reason: `tráfico insuficiente para decidir: ${m.candidate.requests} de ${t.minRequests} llamadas al candidato` };
  }
  return {
    action: "avanzar",
    reason: `paso aprobado: ${m.candidate.requests} llamadas, error ${pct(cErr)}, p99 ${m.candidate.p99Ms === undefined ? "s/d" : `${Math.round(m.candidate.p99Ms)} ms`}`,
  };
}
