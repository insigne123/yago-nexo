import { Suspense, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth, useSessionContext } from "../auth/session";
import { actions } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { can } from "../lib/permissions";
import { keys, useMyNotifications, useRealtimeRefresh } from "../lib/queries";
import { useRuntimeConfig, useSupabase } from "../lib/supabase";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Spinner } from "./ui";

interface NavItem {
  to: string;
  label: string;
}

function NotificationBell({ userId }: { userId: string }) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  const { data = [] } = useMyNotifications(userId);
  const [open, setOpen] = useState(false);
  const unread = data.filter((n) => !n.read_at);

  async function markAll() {
    await actions.markNotificationsRead(supabase, null);
    await queryClient.invalidateQueries({ queryKey: keys.notifications(userId) });
  }

  return (
    <div className="relative">
      <Button
        variant="secundario"
        aria-expanded={open}
        aria-controls="panel-avisos"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Avisos: ${unread.length} sin leer`}
      >
        Avisos
        {unread.length > 0 ? (
          <span className="rounded-full bg-red-700 px-1.5 text-xs font-bold text-white">{unread.length}</span>
        ) : null}
      </Button>
      {open ? (
        <div
          id="panel-avisos"
          className="absolute right-0 z-20 mt-2 w-80 rounded-md border border-slate-200 bg-white p-2 shadow-lg"
        >
          {data.length === 0 ? <p className="p-2 text-sm text-slate-600">No hay avisos.</p> : null}
          <ul className="max-h-80 divide-y divide-slate-100 overflow-auto">
            {data.map((n) => (
              <li key={n.id} className={`p-2 text-sm ${n.read_at ? "text-slate-500" : "text-slate-900"}`}>
                {n.ticket_id ? (
                  <Link
                    to={`/tickets/${n.ticket_id}`}
                    className="font-medium text-blue-800 underline"
                    onClick={() => setOpen(false)}
                  >
                    {String(n.payload["numero"] ?? "Ticket")}
                  </Link>
                ) : (
                  <span className="font-medium">Mesa de soporte</span>
                )}{" "}
                {String(n.payload["titulo"] ?? n.payload["periodo"] ?? n.template)}
                <div className="text-xs text-slate-500">{formatDateTime(n.created_at)}</div>
              </li>
            ))}
          </ul>
          {unread.length > 0 ? (
            <Button variant="fantasma" className="mt-1 w-full" onClick={() => void markAll()}>
              Marcar todos como leídos
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Layout() {
  const ctx = useSessionContext();
  const { signOut } = useAuth();
  const config = useRuntimeConfig();
  useRealtimeRefresh(true);

  const items: NavItem[] = [];
  if (can(ctx, "queue:view")) items.push({ to: "/bandeja", label: "Bandeja" });
  if (!ctx.isStaff) items.push({ to: "/tickets", label: "Mis tickets" });
  if (can(ctx, "ticket:create")) items.push({ to: "/tickets/nuevo", label: "Nuevo ticket" });
  if (can(ctx, "oncall:manage")) items.push({ to: "/turnos", label: "Turnos" });
  if (can(ctx, "incident:manage")) items.push({ to: "/incidentes", label: "Incidentes de seguridad" });
  if (can(ctx, "patch:manage")) items.push({ to: "/parches", label: "Paquetes de corrección" });
  if (can(ctx, "report:view")) items.push({ to: "/informes", label: "Informes mensuales" });
  if (can(ctx, "documents:view")) items.push({ to: "/documentos", label: "Documentos" });

  const me = ctx.memberships[0];
  return (
    <div className="min-h-screen">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Saltar al contenido
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-lg font-bold text-blue-900">
              Mesa de soporte Nexo
            </Link>
            <span
              className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
              title="Ambiente"
            >
              {config.environmentLabel}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell userId={ctx.userId} />
            <div className="hidden text-right text-xs text-slate-600 sm:block">
              <div className="font-semibold text-slate-800">{me?.displayName ?? ctx.email}</div>
              <div>
                {me?.orgName}
                {ctx.isStaff ? " · personal de Yago" : ""}
              </div>
            </div>
            <Button variant="secundario" onClick={() => void signOut()}>
              Cerrar sesión
            </Button>
          </div>
        </div>
        <nav aria-label="Secciones" className="mx-auto max-w-7xl px-4">
          <ul className="flex flex-wrap gap-1 pb-2">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === "/tickets"}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-blue-800 text-white" : "text-slate-700 hover:bg-slate-100"}`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="contenido" className="mx-auto max-w-7xl px-4 py-6">
        <Suspense fallback={<Spinner label="Cargando la sección" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
