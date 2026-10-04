import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSession, SessionContext } from "../auth/session";
import type { AuthUser } from "../auth/types";
import type { Me } from "../api/types";
import { GuardedButton } from "./GuardedButton";
import { PermissionGate, RequirePermission } from "./PermissionGate";

const user = (roles: string[]): AuthUser => ({
  id: "mock-ana",
  username: "ana.desarrollo",
  name: "Ana Rojas",
  roles,
});

function renderAs(roles: string[], ui: ReactNode, me?: Me) {
  return render(
    <SessionContext.Provider value={createSession(user(roles), me)}>{ui}</SessionContext.Provider>,
  );
}

describe("control de acciones por permiso", () => {
  it("deshabilita la acción y explica qué permiso falta", async () => {
    const onClick = vi.fn();
    renderAs(
      ["desarrollador"],
      <GuardedButton permission="rollout:approve" onClick={onClick}>
        Aprobar inicio
      </GuardedButton>,
    );
    const button = screen.getByRole("button", { name: "Aprobar inicio" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("data-blocked", "permiso");
    expect(button).toHaveAccessibleDescription(/Aprobar despliegues a producción.*\(rollout:approve\)/);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("habilita la acción cuando el rol tiene el permiso", async () => {
    const onClick = vi.fn();
    renderAs(
      ["aprobador"],
      <GuardedButton permission="rollout:approve" onClick={onClick}>
        Aprobar inicio
      </GuardedButton>,
    );
    const button = screen.getByRole("button", { name: "Aprobar inicio" });
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("aplica la regla de cuatro ojos aunque el usuario tenga el permiso", async () => {
    const onClick = vi.fn();
    renderAs(
      ["desarrollador", "aprobador"],
      <GuardedButton
        permission="rollout:approve"
        blockedReason="Regla de cuatro ojos: usted creó este despliegue."
        onClick={onClick}
      >
        Aprobar inicio
      </GuardedButton>,
    );
    const button = screen.getByRole("button", { name: "Aprobar inicio" });
    expect(button).toHaveAttribute("data-blocked", "regla");
    expect(button).toHaveAccessibleDescription(/cuatro ojos/);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("acepta cualquiera de varios permisos y puede ocultarse", () => {
    renderAs(
      ["consumidor"],
      <>
        <GuardedButton anyOf={["usage:read:all", "usage:read:own"]}>Exportar CSV</GuardedButton>
        <GuardedButton permission="catalog:write" hideWhenDenied>
          Sincronizar con WSO2
        </GuardedButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Exportar CSV" })).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("button", { name: "Sincronizar con WSO2" })).not.toBeInTheDocument();
  });

  it("muestra el tooltip al enfocar y lo cierra con Escape", async () => {
    renderAs(["auditor"], <GuardedButton permission="continuity:drill">Iniciar simulacro</GuardedButton>);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveClass("sr-only");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Iniciar simulacro" })).toHaveFocus();
    expect(tooltip).not.toHaveClass("sr-only");
    await userEvent.keyboard("{Escape}");
    expect(tooltip).toHaveClass("sr-only");
  });

  it("usa los permisos informados por GET /me por sobre los roles del token", () => {
    const me: Me = { sub: "mock-ana", roles: ["consumidor"], permissions: ["catalog:read", "catalog:write"] };
    renderAs(["consumidor"], <GuardedButton permission="catalog:write">Editar metadatos</GuardedButton>, me);
    expect(screen.getByRole("button", { name: "Editar metadatos" })).not.toHaveAttribute("aria-disabled");
  });

  it("protege una sección completa y muestra el permiso requerido", () => {
    renderAs(
      ["consumidor"],
      <>
        <RequirePermission anyOf={["audit:read"]}>
          <p>Eventos de auditoría</p>
        </RequirePermission>
        <PermissionGate anyOf={["catalog:read"]}>
          <p>Catálogo visible</p>
        </PermissionGate>
      </>,
    );
    expect(screen.queryByText("Eventos de auditoría")).not.toBeInTheDocument();
    expect(screen.getByTestId("no-access")).toHaveTextContent("Su rol no tiene acceso a esta sección");
    expect(screen.getByTestId("no-access")).toHaveTextContent("(audit:read)");
    expect(screen.getByText("Catálogo visible")).toBeInTheDocument();
  });
});
