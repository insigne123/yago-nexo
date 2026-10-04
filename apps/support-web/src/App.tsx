import { lazy, type ReactNode } from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import { LoadingScreen, LoginPage, MfaChallengePage, MfaEnrollPage, NoAccessPage } from "./auth/AuthScreens";
import { useAuth, useSessionContext } from "./auth/session";
import { Layout } from "./components/Layout";
import { Alert, PageTitle } from "./components/ui";
import { can, type Capability } from "./lib/permissions";

// Cada sección se carga al visitarla (el paquete inicial queda con lo necesario para ingresar).
const DocumentsPage = lazy(() =>
  import("./features/documents/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
const IncidentsPage = lazy(() =>
  import("./features/incidents/IncidentsPage").then((m) => ({ default: m.IncidentsPage })),
);
const OnCallPage = lazy(() =>
  import("./features/oncall/OnCallPage").then((m) => ({ default: m.OnCallPage })),
);
const PatchesPage = lazy(() =>
  import("./features/patches/PatchesPage").then((m) => ({ default: m.PatchesPage })),
);
const QueuePage = lazy(() => import("./features/queue/QueuePage").then((m) => ({ default: m.QueuePage })));
const ReportsPage = lazy(() =>
  import("./features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })),
);
const NewTicketPage = lazy(() =>
  import("./features/tickets/NewTicketPage").then((m) => ({ default: m.NewTicketPage })),
);
const TicketDetailPage = lazy(() =>
  import("./features/tickets/TicketDetailPage").then((m) => ({ default: m.TicketDetailPage })),
);
const TicketsListPage = lazy(() =>
  import("./features/tickets/TicketsListPage").then((m) => ({ default: m.TicketsListPage })),
);

function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const ctx = useSessionContext();
  if (!can(ctx, capability)) {
    return <Alert tone="alerta">Su perfil no tiene acceso a esta sección.</Alert>;
  }
  return <>{children}</>;
}

function NotFoundPage() {
  return (
    <div>
      <PageTitle>Página no encontrada</PageTitle>
      <Link to="/" className="text-blue-800 underline">
        Volver al inicio
      </Link>
    </div>
  );
}

function AppRoutes() {
  const ctx = useSessionContext();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to={ctx.isStaff ? "/bandeja" : "/tickets"} replace />} />
        <Route path="tickets" element={<TicketsListPage />} />
        <Route
          path="tickets/nuevo"
          element={
            <RequireCapability capability="ticket:create">
              <NewTicketPage />
            </RequireCapability>
          }
        />
        <Route path="tickets/:id" element={<TicketDetailPage />} />
        <Route
          path="bandeja"
          element={
            <RequireCapability capability="queue:view">
              <QueuePage />
            </RequireCapability>
          }
        />
        <Route
          path="turnos"
          element={
            <RequireCapability capability="oncall:manage">
              <OnCallPage />
            </RequireCapability>
          }
        />
        <Route
          path="incidentes"
          element={
            <RequireCapability capability="incident:manage">
              <IncidentsPage />
            </RequireCapability>
          }
        />
        <Route
          path="parches"
          element={
            <RequireCapability capability="patch:manage">
              <PatchesPage />
            </RequireCapability>
          }
        />
        <Route
          path="informes"
          element={
            <RequireCapability capability="report:view">
              <ReportsPage />
            </RequireCapability>
          }
        />
        <Route
          path="documentos"
          element={
            <RequireCapability capability="documents:view">
              <DocumentsPage />
            </RequireCapability>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** Puerta de entrada: sin sesión -> ingreso; sin MFA -> enrolamiento o desafío; luego la mesa. */
export function App() {
  const auth = useAuth();
  switch (auth.status) {
    case "cargando":
      return <LoadingScreen />;
    case "sin_sesion":
      return <LoginPage />;
    case "requiere_enrolamiento":
      return <MfaEnrollPage />;
    case "requiere_verificacion":
      return <MfaChallengePage />;
    case "sin_acceso":
      return <NoAccessPage />;
    case "lista":
      return <AppRoutes />;
  }
}
