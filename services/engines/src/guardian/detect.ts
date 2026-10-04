/**
 * Detección robusta de anomalías (D-02): por cada consumidor, el valor de la ventana actual se compara con
 * su línea base de ventanas anteriores usando mediana y MAD (desviación absoluta mediana), que no se dejan
 * arrastrar por picos aislados como lo harían la media y la desviación estándar.
 */
export type Metric = "volumen" | "errores" | "latencia" | "tamano" | "ips_distintas" | "fuera_de_horario";

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mad(xs: readonly number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

/** Sensibilidad 1 (poco sensible) a 10 (muy sensible) → umbral del puntaje robusto. */
export function zThreshold(sensitivity: number): number {
  const s = Math.min(10, Math.max(1, sensitivity));
  return 2 + (10 - s) * 0.75;
}

/**
 * Escala mínima por métrica: evita que una línea base plana (MAD = 0) convierta cualquier variación en anomalía.
 * Para el volumen depende del volumen mínimo de la regla: un consumidor nuevo que parte con tráfico moderado no
 * se marca, uno que irrumpe con un volumen muy superior sí.
 */
export function scaleFloor(metric: Metric, baselineMedian: number, minVolume: number): number {
  switch (metric) {
    case "volumen":
      return Math.max(minVolume / 2, 0.1 * baselineMedian, 1);
    case "errores":
      return Math.max(0.02, 0.1 * baselineMedian);
    case "latencia":
      return Math.max(50, 0.1 * baselineMedian);
    case "tamano":
      return Math.max(10_000, 0.1 * baselineMedian);
    case "ips_distintas":
      return Math.max(2, 0.1 * baselineMedian);
    case "fuera_de_horario":
      return Math.max(minVolume, 1);
  }
}

export interface WindowSample {
  /** Valor de la métrica en la ventana (llamadas, proporción de errores, p95 en ms, bytes, IPs). */
  value: number;
  /** Llamadas en la ventana (para el volumen mínimo). */
  calls: number;
  /** Llamadas con error (4xx y 5xx) en la ventana. */
  errors: number;
}

export interface Detection {
  anomalous: boolean;
  observed: number;
  baseline: number;
  score: number;
  reason: string;
}

/**
 * Evalúa la ventana actual frente a su historia. Solo se marcan subidas (no caídas), con volumen suficiente
 * y un puntaje sobre el umbral de la sensibilidad de la regla.
 */
export function detect(metric: Metric, current: WindowSample, history: readonly WindowSample[], sensitivity: number, minVolume: number, offHours = false): Detection {
  if (metric === "fuera_de_horario") {
    const score = current.calls / Math.max(minVolume, 1);
    return {
      anomalous: offHours && current.calls >= minVolume,
      observed: current.calls,
      baseline: minVolume,
      score,
      reason: offHours ? `${current.calls} llamadas fuera del horario hábil (mínimo para alertar: ${minVolume})` : "dentro del horario hábil",
    };
  }
  const values = history.map((h) => h.value);
  const med = median(values);
  const scale = Math.max(1.4826 * mad(values, med), scaleFloor(metric, med, minVolume));
  const score = (current.value - med) / scale;
  const threshold = zThreshold(sensitivity);
  const enoughVolume = metric === "volumen" ? current.value >= minVolume : current.calls >= minVolume;
  const enoughErrors = metric !== "errores" || current.errors >= 5;
  const anomalous = enoughVolume && enoughErrors && current.value > med && score >= threshold;
  return {
    anomalous,
    observed: current.value,
    baseline: med,
    score: Math.round(score * 100) / 100,
    reason: anomalous
      ? `${describe(metric, current.value)} frente a una línea base de ${describe(metric, med)} (puntaje ${score.toFixed(1)} ≥ ${threshold.toFixed(1)})`
      : !enoughVolume
        ? `volumen bajo el mínimo (${current.calls} de ${minVolume})`
        : `dentro de lo normal (puntaje ${score.toFixed(1)} < ${threshold.toFixed(1)})`,
  };
}

export function describe(metric: Metric, v: number): string {
  switch (metric) {
    case "volumen":
    case "fuera_de_horario":
      return `${Math.round(v)} llamadas`;
    case "errores":
      return `${(v * 100).toFixed(1)} % de errores`;
    case "latencia":
      return `p95 de ${Math.round(v)} ms`;
    case "tamano":
      return `${Math.round(v / 1024)} KB respondidos`;
    case "ips_distintas":
      return `${Math.round(v)} IP distintas`;
  }
}

/** ¿El instante cae dentro del horario hábil? Formato "1-5 08:00-20:00" (días ISO: 1 = lunes). */
export function isBusinessHours(date: Date, spec = "1-5 08:00-20:00", timeZone = "America/Santiago"): boolean {
  const m = /^(\d)-(\d)\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec.trim());
  if (!m) throw new Error(`Horario hábil inválido: ${spec}`);
  const [, d1, d2, h1, m1, h2, m2] = m.map(Number) as [number, number, number, number, number, number, number];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.find((p) => p.type === "weekday")!.value as "Mon"]!;
  const minutes = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  return wd >= d1 && wd <= d2 && minutes >= h1 * 60 + m1 && minutes < h2 * 60 + m2;
}
