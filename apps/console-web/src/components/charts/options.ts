import type { VizPalette } from "./palette";

/**
 * Piezas comunes de los gráficos: grilla y ejes recesivos (líneas finas y sólidas), tooltip
 * con valores primero y tipografía del sistema. Ningún texto usa el color de la serie.
 */

export function chartGrid(top = 28) {
  return {
    left: 8,
    right: 16,
    top,
    bottom: 8,
    outerBoundsMode: "same" as const,
    outerBoundsContain: "axisLabel" as const,
  };
}

export function categoryAxis(palette: VizPalette, data: string[]) {
  return {
    type: "category" as const,
    data,
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { color: palette.label, fontSize: 11, hideOverlap: true },
  };
}

export function valueAxis(palette: VizPalette, formatter?: (value: number) => string) {
  return {
    type: "value" as const,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.label, fontSize: 11, ...(formatter ? { formatter } : {}) },
    splitLine: { lineStyle: { color: palette.grid, width: 1, type: "solid" as const } },
  };
}

export function axisTooltip(palette: VizPalette) {
  return {
    trigger: "axis" as const,
    backgroundColor: palette.surface,
    borderColor: palette.grid,
    borderWidth: 1,
    textStyle: { color: palette.text, fontSize: 12 },
    axisPointer: { type: "line" as const, lineStyle: { color: palette.axis, width: 1 } },
    confine: true,
  };
}

export function legend(palette: VizPalette) {
  return {
    top: 0,
    left: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    textStyle: { color: palette.label, fontSize: 12 },
  };
}

/** Barras finas (máx. 24 px) con extremo redondeado de 4 px y base recta. */
export const BAR_MAX_WIDTH = 24;

export function barItemStyle(color: string | undefined, horizontal = false) {
  return { color, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] };
}

export const CHART_TEXT = { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" } as const;
