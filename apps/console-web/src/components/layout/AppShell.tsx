import type { Permission } from "@nexo/shared/browser";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useMatches, useNavigation } from "react-router";
import { cx } from "../../lib/cx";
import { RequirePermission } from "../PermissionGate";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

export interface RouteHandle {
  /** Permisos que habilitan la página (basta con uno). */
  anyOf?: readonly Permission[];
}

function GuardedOutlet() {
  const matches = useMatches();
  const handle = [...matches].reverse().find((m) => (m.handle as RouteHandle | undefined)?.anyOf)?.handle as
    RouteHandle | undefined;
  const anyOf = handle?.anyOf ?? [];
  return anyOf.length > 0 ? (
    <RequirePermission anyOf={anyOf}>
      <Outlet />
    </RequirePermission>
  ) : (
    <Outlet />
  );
}

/** Estructura de la Consola: menú lateral, encabezado y contenido de la página. */
export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigation = useNavigation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // Al cambiar de página, el foco va al contenido (lectores de pantalla y teclado).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const loading = navigation.state === "loading";

  return (
    <div className="flex min-h-0 flex-1">
      <a
        href="#contenido"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Saltar al contenido
      </a>
      <aside
        id="menu-lateral"
        className={cx(
          "w-64 shrink-0 border-r border-line bg-surface print:hidden",
          "fixed inset-y-0 left-0 z-40 overflow-y-auto shadow-xl lg:static lg:z-auto lg:block lg:shadow-none",
          menuOpen ? "block" : "hidden",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-7" />
          <div className="leading-tight">
            <p className="text-sm font-semibold text-fg">Consola Nexo</p>
            <p className="text-[11px] text-fg-muted">Yago Nexo · Gestión de APIs</p>
          </div>
        </div>
        <Sidebar onNavigate={() => setMenuOpen(false)} />
      </aside>
      {menuOpen && (
        <button
          type="button"
          aria-label="Cerrar menú"
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header menuOpen={menuOpen} onToggleMenu={() => setMenuOpen((v) => !v)} />
        <div
          aria-hidden="true"
          className={cx(
            "h-0.5 bg-accent transition-opacity print:hidden",
            loading ? "opacity-100" : "opacity-0",
          )}
        />
        <main
          id="contenido"
          ref={mainRef}
          tabIndex={-1}
          aria-busy={loading || undefined}
          className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 focus:outline-none sm:px-6 print:max-w-none print:p-0"
        >
          <GuardedOutlet />
        </main>
      </div>
    </div>
  );
}
