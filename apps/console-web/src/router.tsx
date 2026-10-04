import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";
import { AppShell, type RouteHandle } from "./components/layout/AppShell";
import { RouteError } from "./components/layout/RouteError";
import { FullPageMessage } from "./components/layout/FullPageMessage";

/** Carga diferida de cada pantalla (un fragmento por ruta). */
const page = (loader: () => Promise<{ default: ComponentType }>) => async () => ({
  Component: (await loader()).default,
});

const guard = (...anyOf: NonNullable<RouteHandle["anyOf"]>): RouteHandle => ({ anyOf });

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <FullPageMessage message="Cargando la Consola Nexo…" />,
    children: [
      { index: true, lazy: page(() => import("./pages/inicio/InicioPage")) },
      {
        path: "catalogo",
        handle: guard("catalog:read"),
        lazy: page(() => import("./pages/catalogo/CatalogoPage")),
      },
      {
        path: "catalogo/:id",
        handle: guard("catalog:read"),
        lazy: page(() => import("./pages/catalogo/CatalogoDetallePage")),
      },
      {
        path: "dependencias",
        handle: guard("catalog:read"),
        lazy: page(() => import("./pages/dependencias/DependenciasPage")),
      },
      {
        path: "descubrimiento",
        handle: guard("discovery:read"),
        lazy: page(() => import("./pages/descubrimiento/DescubrimientoPage")),
      },
      {
        path: "anomalias",
        handle: guard("anomaly:read"),
        lazy: page(() => import("./pages/anomalias/AnomaliasPage")),
      },
      {
        path: "despliegues",
        handle: guard("rollout:read"),
        lazy: page(() => import("./pages/despliegues/DesplieguesPage")),
      },
      {
        path: "despliegues/nuevo",
        handle: guard("rollout:create"),
        lazy: page(() => import("./pages/despliegues/NuevoDesplieguePage")),
      },
      {
        path: "despliegues/:id",
        handle: guard("rollout:read"),
        lazy: page(() => import("./pages/despliegues/DespliegueDetallePage")),
      },
      {
        path: "continuidad",
        handle: guard("continuity:read"),
        lazy: page(() => import("./pages/continuidad/ContinuidadPage")),
      },
      {
        path: "consumo",
        handle: guard("usage:read:all", "usage:read:own"),
        lazy: page(() => import("./pages/consumo/ConsumoPage")),
      },
      {
        path: "mensajes-fallidos",
        handle: guard("dlq:read"),
        lazy: page(() => import("./pages/mensajes/MensajesFallidosPage")),
      },
      {
        path: "auditoria",
        handle: guard("audit:read"),
        lazy: page(() => import("./pages/auditoria/AuditoriaPage")),
      },
      {
        path: "cumplimiento",
        handle: guard("compliance:read"),
        lazy: page(() => import("./pages/cumplimiento/CumplimientoPage")),
      },
      {
        path: "exportacion",
        handle: guard("export:create"),
        lazy: page(() => import("./pages/exportacion/ExportacionPage")),
      },
      { path: "acerca-de", lazy: page(() => import("./pages/acerca/AcercaDePage")) },
      { path: "*", lazy: page(() => import("./pages/NotFoundPage")) },
    ],
  },
];

let router: ReturnType<typeof createBrowserRouter> | null = null;

/** El enrutador se crea una sola vez y se reutiliza entre inicios de sesión. */
export function getRouter(): ReturnType<typeof createBrowserRouter> {
  router ??= createBrowserRouter(routes, { basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/" });
  return router;
}
