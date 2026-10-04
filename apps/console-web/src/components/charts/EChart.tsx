import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { init, use as registerModules, type ECharts } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type { ChartOption } from "./types";

registerModules([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  AriaComponent,
  SVGRenderer,
]);

export interface EChartProps {
  option: ChartOption;
  /** Resumen accesible del gráfico (los datos completos están en la tabla asociada). */
  label: string;
  height?: number;
  testId?: string;
}

/**
 * Envoltorio mínimo de ECharts 6 (sin librerías intermedias): crea la instancia, la ajusta al
 * tamaño del contenedor y aplica las opciones cuando cambian.
 */
export default function EChart({ option, label, height = 220, testId }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = init(element, null, { renderer: "svg" });
    chartRef.current = chart;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={label}
      data-testid={testId}
      className="w-full"
      style={{ height }}
    />
  );
}
