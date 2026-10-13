/** Argumentos de `pnpm --filter @nexo/evidencias grabar` (separado de grabar.ts para probarlo). */
import { ETIQUETA_POR_DEFECTO } from "./entorno.js";

export interface Argumentos {
  /** Modo ensayo: sin laboratorio, contra el servidor de ensayo; nunca se publica. */
  ensayo: boolean;
  etiqueta: string;
  /** Carpeta de salida (por defecto release/evidencias o release/evidencias/ensayo). */
  salida?: string;
  sinCompilar: boolean;
  /** Prueba de rendimiento de la captura (segundos por perfil). */
  rendimiento?: number;
  /** Factor de las pausas de lectura (0,5–2). */
  ritmo: number;
  /** Ids pedidos, normalizados (D-04, BT-005, MOTOR). */
  ids: string[];
  /** Captura alternativa si 1920×1080 a 30 cps no rinde: «1600x900», «1920x1080@25»… */
  perfil?: { ancho: number; alto: number; cps: number };
}

/** d04, D04, d-04 → D-04; bt5 → BT-005; motor → MOTOR. */
export function normalizarId(s: string): string {
  const t = s.trim().toUpperCase().replace(/_/g, "-");
  const m = /^(D|BT)-?0*(\d+)$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(m[1] === "D" ? 2 : 3, "0")}`;
  return t;
}

export function leerPerfil(s: string): { ancho: number; alto: number; cps: number } | undefined {
  const m = /^(\d{3,4})x(\d{3,4})(?:@(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  return { ancho: Number(m[1]), alto: Number(m[2]), cps: Number(m[3] ?? 30) };
}

export function leerArgumentos(argv: string[]): Argumentos {
  const a = argv.filter((x) => x !== "--");
  const valor = (nombre: string): string | undefined => {
    const i = a.findIndex((x) => x === nombre || x.startsWith(`${nombre}=`));
    if (i < 0) return undefined;
    const x = a[i]!;
    if (x.includes("=")) return x.slice(x.indexOf("=") + 1);
    const sig = a[i + 1];
    return sig && !sig.startsWith("--") ? sig : undefined;
  };
  const conValor = new Set(["--etiqueta", "--salida", "--ritmo", "--perfil", "--rendimiento"]);
  const ids: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x.startsWith("--")) {
      if (conValor.has(x) && a[i + 1] && !a[i + 1]!.startsWith("--") && (x !== "--rendimiento" || /^\d+$/.test(a[i + 1]!))) i++;
      continue;
    }
    ids.push(normalizarId(x));
  }
  const rend = a.some((x) => x === "--rendimiento" || x.startsWith("--rendimiento=")) ? Number(valor("--rendimiento") ?? 20) : undefined;
  const ritmo = Number(valor("--ritmo") ?? 1);
  const perfilTexto = valor("--perfil");
  const perfil = perfilTexto ? leerPerfil(perfilTexto) : undefined;
  if (perfilTexto && !perfil) throw new Error(`--perfil ${perfilTexto}: use ANCHOxALTO[@cps], p. ej. 1600x900 o 1920x1080@25`);
  return {
    ensayo: a.includes("--ensayo"),
    etiqueta: valor("--etiqueta") ?? ETIQUETA_POR_DEFECTO,
    ...(valor("--salida") ? { salida: valor("--salida") } : {}),
    sinCompilar: a.includes("--sin-compilar"),
    ...(rend !== undefined ? { rendimiento: Number.isFinite(rend) && rend > 0 ? rend : 20 } : {}),
    ritmo: Number.isFinite(ritmo) ? ritmo : 1,
    ids,
    ...(perfil ? { perfil } : {}),
  };
}

/** Las demostraciones pedidas, en el orden en que se pidieron y sin repetir (los ids ya vienen normalizados). */
export function elegirEnOrden<T extends { id: string }>(disponibles: readonly T[], ids: readonly string[]): T[] {
  const elegidas: T[] = [];
  for (const id of ids) {
    const d = disponibles.find((x) => x.id === id);
    if (d && !elegidas.includes(d)) elegidas.push(d);
  }
  return elegidas;
}
