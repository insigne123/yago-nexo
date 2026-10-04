import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type {
  AriaComponentOption,
  GridComponentOption,
  LegendComponentOption,
  MarkLineComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import type { ComposeOption } from "echarts/core";

/** Opciones de ECharts limitadas a los módulos que se registran (tree shaking). */
export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | MarkLineComponentOption
  | AriaComponentOption
>;
