import { lazy, Suspense } from "react";
import { Skeleton } from "../ui/Skeleton";
import type { EChartProps } from "./EChart";

// ECharts se carga en un fragmento aparte, solo cuando una pantalla muestra un gráfico.
const EChart = lazy(() => import("./EChart"));

export function Chart(props: EChartProps) {
  const height = props.height ?? 220;
  return (
    <Suspense fallback={<Skeleton style={{ height }} />}>
      <EChart {...props} />
    </Suspense>
  );
}
