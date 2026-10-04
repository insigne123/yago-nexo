import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChainVerificationBanner } from "./ChainVerificationBanner";

describe("banner de verificación de la cadena de auditoría", () => {
  it("destaca una cadena íntegra como estado", () => {
    render(<ChainVerificationBanner result={{ ok: true, count: 42, lastSeq: 42 }} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("data-testid", "audit-verification");
    expect(banner).toHaveAttribute("data-ok", "true");
    expect(banner).toHaveTextContent("Cadena de auditoría íntegra");
    expect(banner).toHaveTextContent("Se verificaron 42 eventos; el último es el número 42.");
  });

  it("alerta una cadena rota e indica el evento y el motivo", () => {
    render(
      <ChainVerificationBanner
        result={{ ok: false, count: 16, brokenAt: 17, reason: "hash" }}
        verifiedAt="2026-10-04T12:00:00Z"
      />,
    );
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-ok", "false");
    expect(banner).toHaveAttribute("data-broken-at", "17");
    expect(banner).toHaveTextContent("Cadena rota en el evento número 17");
    expect(banner).toHaveTextContent("fue modificado después de registrarse");
    expect(banner).toHaveTextContent("16 eventos verificados correctamente antes de la falla.");
    expect(banner).toHaveTextContent("Verificado el");
  });

  it("explica una secuencia incompleta", () => {
    render(<ChainVerificationBanner result={{ ok: false, count: 3, brokenAt: 5, reason: "secuencia" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Falta un evento o la secuencia está fuera de orden");
  });

  it("muestra el motivo informado aunque no sea uno conocido", () => {
    render(<ChainVerificationBanner result={{ ok: false, count: 0, brokenAt: 1, reason: "firma" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Motivo informado: firma.");
  });
});
