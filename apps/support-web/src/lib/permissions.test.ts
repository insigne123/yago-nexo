import { describe, expect, it } from "vitest";
import { ORG_CLIENTE, sessionFor } from "../test/render";
import { can, ticketOrgs, toSessionContext } from "./permissions";

const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

describe("permisos de la interfaz", () => {
  it("el reportante crea y comenta tickets de su organización, pero no opera", () => {
    const ctx = sessionFor("reportante");
    expect(can(ctx, "ticket:create", ORG_CLIENTE)).toBe(true);
    expect(can(ctx, "ticket:create", OTHER_ORG)).toBe(false);
    expect(can(ctx, "ticket:comment", ORG_CLIENTE)).toBe(true);
    for (const capability of [
      "ticket:change_status",
      "ticket:assign",
      "ticket:pause",
      "ticket:escalate",
      "queue:view",
      "oncall:manage",
    ] as const) {
      expect(can(ctx, capability, ORG_CLIENTE)).toBe(false);
    }
    expect(can(ctx, "pause:acknowledge", ORG_CLIENTE)).toBe(false);
    expect(can(ctx, "remote:decide", ORG_CLIENTE)).toBe(false);
  });

  it("la contraparte acusa pausas, habilita accesos y aprueba paquetes de su organización", () => {
    const ctx = sessionFor("contraparte");
    expect(can(ctx, "pause:acknowledge", ORG_CLIENTE)).toBe(true);
    expect(can(ctx, "remote:decide", ORG_CLIENTE)).toBe(true);
    expect(can(ctx, "patch:approve", ORG_CLIENTE)).toBe(true);
    expect(can(ctx, "pause:acknowledge", OTHER_ORG)).toBe(false);
    expect(can(ctx, "ticket:change_status", ORG_CLIENTE)).toBe(false);
  });

  it("el agente opera tickets de cualquier organización pero no acusa por el cliente", () => {
    const ctx = sessionFor("agente");
    for (const capability of [
      "ticket:change_status",
      "ticket:assign",
      "ticket:pause",
      "queue:view",
      "incident:manage",
      "report:generate",
    ] as const) {
      expect(can(ctx, capability, OTHER_ORG)).toBe(true);
    }
    expect(can(ctx, "pause:acknowledge", ORG_CLIENTE)).toBe(false);
    expect(can(ctx, "patch:approve", ORG_CLIENTE)).toBe(false);
    expect(can(sessionFor("supervisor"), "patch:approve", ORG_CLIENTE)).toBe(true);
  });

  it("sin MFA o sin sesión no hay permisos", () => {
    expect(can(null, "ticket:create")).toBe(false);
    expect(can({ ...sessionFor("agente"), mfaOk: false }, "ticket:change_status")).toBe(false);
  });

  it("convierte el contexto de la base de datos", () => {
    const ctx = toSessionContext({
      user_id: "u1",
      email: "a@b.cl",
      aal: "aal2",
      mfa_ok: true,
      is_staff: false,
      is_supervisor: false,
      memberships: [
        {
          org_id: ORG_CLIENTE,
          org_name: "Cliente",
          org_slug: "cliente",
          is_provider: false,
          role: "reportante",
          display_name: "Ana",
        },
      ],
    });
    expect(ctx?.memberships[0]?.orgName).toBe("Cliente");
    expect(ticketOrgs(ctx!)).toHaveLength(1);
    expect(
      toSessionContext({
        user_id: null,
        email: null,
        aal: "aal1",
        mfa_ok: false,
        is_staff: false,
        is_supervisor: false,
        memberships: [],
      }),
    ).toBeNull();
  });
});
