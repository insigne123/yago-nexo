import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { PartialAnswers } from "../../lib/severity";
import { SeverityWizard } from "./SeverityWizard";

function Harness() {
  const [answers, setAnswers] = useState<PartialAnswers>({});
  return <SeverityWizard value={answers} onChange={setAnswers} />;
}

function answer(questionStart: RegExp, option: "Sí" | "No") {
  const group = screen.getByRole("group", { name: questionStart });
  return userEvent.click(within(group).getByRole("radio", { name: option }));
}

describe("asistente de severidad", () => {
  it("clasifica S1 cuando el servicio productivo está caído sin alternativa y muestra la regla", async () => {
    render(<Harness />);
    expect(screen.getByText(/Responda las preguntas para ver la severidad/)).toBeInTheDocument();
    await answer(/^1\. ¿Es una consulta/, "No");
    await answer(/^2\. ¿Hay APIs o integraciones productivas/, "Sí");
    await answer(/^3\. ¿Existe una alternativa operativa/, "No");
    const result = screen.getByText(/Severidad resultante/).closest("div") as HTMLElement;
    expect(within(result).getByText("S1 · Crítica")).toBeInTheDocument();
    expect(
      within(result).getByText("Servicio productivo caído y sin alternativa operativa"),
    ).toBeInTheDocument();
    expect(within(result).getByText("4 horas corridas")).toBeInTheDocument();
  });

  it("clasifica S4 con la primera respuesta y no muestra las demás preguntas", async () => {
    render(<Harness />);
    await answer(/^1\. ¿Es una consulta/, "Sí");
    expect(screen.queryByRole("group", { name: /^2\./ })).not.toBeInTheDocument();
    expect(screen.getByText("S4 · Baja")).toBeInTheDocument();
    expect(screen.getByText("Consulta o solicitud de cambio sin falla")).toBeInTheDocument();
  });

  it("clasifica S3 para una falla en no productivo y ofrece los ejemplos de la matriz", async () => {
    render(<Harness />);
    await answer(/^1\./, "No");
    await answer(/^2\./, "No");
    await answer(/^4\. ¿Hay degradación medible/, "No");
    await answer(/^5\. ¿La falla afecta solo a ambientes no productivos/, "Sí");
    expect(screen.getByText("S3 · Media")).toBeInTheDocument();
    expect(screen.getByText("Falla en no productivo o funcionalidad no crítica")).toBeInTheDocument();
    expect(
      screen.getAllByText("Falla un pipeline de promoción en el ambiente de QA.").length,
    ).toBeGreaterThan(0);
  });
});
