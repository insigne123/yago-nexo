import { classifySeverity, type SeverityAnswers } from "@nexo/shared/browser";
import { describe, expect, it } from "vitest";
import matrix from "../../../../supabase/support/tests/fixtures/severity_matrix.json";
import {
  answerQuestion,
  classify,
  isComplete,
  toAnswers,
  visibleQuestions,
  type PartialAnswers,
} from "./severity";

const KEYS = matrix.claves as Array<keyof SeverityAnswers>;

describe("matriz de severidad compartida con la base de datos", () => {
  it("classifySeverity coincide con la matriz en las 32 combinaciones (la misma que verifica sd_classify en SQL)", () => {
    expect(matrix.casos).toHaveLength(32);
    const distinct = new Set(matrix.casos.map((c) => JSON.stringify(c.answers)));
    expect(distinct.size).toBe(32);
    for (const caso of matrix.casos) {
      expect(classifySeverity(caso.answers as SeverityAnswers)).toEqual({
        severity: caso.severity,
        rule: caso.rule,
      });
    }
  });

  it("el asistente progresivo llega a la misma severidad que la regla completa en las 32 combinaciones", () => {
    for (const caso of matrix.casos) {
      const full = caso.answers as SeverityAnswers;
      // Se responde solo lo que el asistente muestra, en orden, con los valores de la combinación.
      let partial: PartialAnswers = {};
      for (let guard = 0; guard < 10 && !isComplete(partial); guard++) {
        const pending = visibleQuestions(partial).find((q) => partial[q.key] === undefined);
        if (!pending) break;
        partial = answerQuestion(partial, pending.key, full[pending.key]);
      }
      expect(isComplete(partial)).toBe(true);
      expect(classify(partial)).toEqual({ severity: caso.severity, rule: caso.rule });
      for (const key of KEYS) expect(typeof toAnswers(partial)[key]).toBe("boolean");
    }
  });
});

describe("preguntas visibles", () => {
  it("una consulta termina en la primera pregunta (S4)", () => {
    const answers = answerQuestion({}, "esConsultaOCambio", true);
    expect(visibleQuestions(answers).map((q) => q.key)).toEqual(["esConsultaOCambio"]);
    expect(classify(answers)?.severity).toBe("S4");
  });

  it("servicio caído pregunta por la alternativa y no por la degradación", () => {
    let answers = answerQuestion({}, "esConsultaOCambio", false);
    answers = answerQuestion(answers, "servicioProductivoCaido", true);
    expect(visibleQuestions(answers).map((q) => q.key)).toEqual([
      "esConsultaOCambio",
      "servicioProductivoCaido",
      "existeAlternativa",
    ]);
    expect(classify(answers)).toBeNull();
    expect(classify(answerQuestion(answers, "existeAlternativa", false))?.severity).toBe("S1");
  });

  it("cambiar una respuesta borra las que dejaron de aplicar", () => {
    let answers = answerQuestion({}, "esConsultaOCambio", false);
    answers = answerQuestion(answers, "servicioProductivoCaido", true);
    answers = answerQuestion(answers, "existeAlternativa", true);
    answers = answerQuestion(answers, "servicioProductivoCaido", false);
    expect(answers.existeAlternativa).toBeUndefined();
    expect(classify(answers)).toBeNull();
  });
});
