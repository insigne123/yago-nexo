import { useSyncExternalStore } from "react";

/**
 * Paleta de gráficos (misma que las variables --viz-* de styles.css). Orden categórico fijo
 * validado para daltonismo; los colores de estado se reservan para estados.
 */
export interface VizPalette {
  dark: boolean;
  series: readonly string[];
  surface: string;
  grid: string;
  axis: string;
  label: string;
  text: string;
  good: string;
  warning: string;
  critical: string;
}

const LIGHT: VizPalette = {
  dark: false,
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  surface: "#ffffff",
  grid: "#e3e6ea",
  axis: "#c3c8cf",
  label: "#5f6b7a",
  text: "#131a23",
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

const DARK: VizPalette = {
  dark: true,
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  surface: "#161b22",
  grid: "#262d36",
  axis: "#3a434e",
  label: "#97a2af",
  text: "#e7ebf0",
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};

const QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isDark(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.(QUERY).matches);
}

export function useVizPalette(): VizPalette {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  return dark ? DARK : LIGHT;
}

export function seriesColor(palette: VizPalette, index: number): string {
  return palette.series[index % palette.series.length] ?? palette.series[0] ?? "#2a78d6";
}
