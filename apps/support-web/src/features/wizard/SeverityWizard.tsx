import { SEVERITY_EXAMPLES, type Severity } from "@nexo/shared/browser";
import { useId } from "react";
import { SeverityBadge } from "../../components/badges";
import { SEVERITY_NAME, SLA_POLICY_TEXT } from "../../lib/labels";
import {
  answerQuestion,
  classify,
  QUESTIONS,
  visibleQuestions,
  type PartialAnswers,
  type WizardQuestion,
} from "../../lib/severity";

function Question({
  index,
  question,
  value,
  onAnswer,
}: {
  index: number;
  question: WizardQuestion;
  value: boolean | undefined;
  onAnswer: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <fieldset className="rounded-md border border-slate-200 p-3" aria-describedby={`${id}-ayuda`}>
      <legend className="px-1 text-sm font-semibold text-slate-900">
        {index}. {question.question}
      </legend>
      <p id={`${id}-ayuda`} className="mb-2 text-xs text-slate-600">
        {question.help}
      </p>
      <div className="flex gap-4">
        {[
          { label: "Sí", v: true },
          { label: "No", v: false },
        ].map((option) => (
          <label key={option.label} className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-respuesta`}
              checked={value === option.v}
              onChange={() => onAnswer(option.v)}
              className="h-4 w-4 accent-blue-800"
            />
            {option.label}
          </label>
        ))}
      </div>
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer text-blue-800">Ejemplos de {question.examples.severity}</summary>
        <ul className="mt-1 list-disc pl-5">
          {question.examples.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </fieldset>
  );
}

/** Resultado del asistente: severidad, regla aplicada, plazos y ejemplos de esa severidad. */
export function SeverityResultPanel({ severity, rule }: { severity: Severity; rule: string }) {
  const policy = SLA_POLICY_TEXT[severity];
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3" aria-live="polite">
      <p className="text-sm text-slate-800">
        Severidad resultante: <SeverityBadge severity={severity} long />{" "}
        <span className="sr-only">{SEVERITY_NAME[severity]}</span>
      </p>
      <p className="mt-1 text-sm text-slate-800">
        Regla aplicada: <strong>{rule}</strong>
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-700 sm:grid-cols-3">
        <div>
          <dt className="font-semibold">Acuse</dt>
          <dd>{policy.acuse}</dd>
        </div>
        <div>
          <dt className="font-semibold">Diagnóstico</dt>
          <dd>{policy.diagnostico}</dd>
        </div>
        <div>
          <dt className="font-semibold">Solución o solución temporal</dt>
          <dd>{policy.solucion}</dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-slate-600">Cobertura: {policy.cobertura}</p>
      <details className="mt-2 text-xs text-slate-700">
        <summary className="cursor-pointer text-blue-800">Ejemplos de {severity}</summary>
        <ul className="mt-1 list-disc pl-5">
          {SEVERITY_EXAMPLES[severity].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Asistente de severidad (BT-061): preguntas de sí o no; la severidad se calcula de forma
 * determinista con classifySeverity (la base de datos aplica la misma regla al guardar).
 */
export function SeverityWizard({
  value,
  onChange,
}: {
  value: PartialAnswers;
  onChange: (next: PartialAnswers) => void;
}) {
  const visible = visibleQuestions(value);
  const result = classify(value);
  return (
    <div className="flex flex-col gap-3">
      {visible.map((question) => (
        <Question
          key={question.key}
          index={QUESTIONS.indexOf(question) + 1}
          question={question}
          value={value[question.key]}
          onAnswer={(answer) => onChange(answerQuestion(value, question.key, answer))}
        />
      ))}
      {result ? (
        <SeverityResultPanel severity={result.severity} rule={result.rule} />
      ) : (
        <p className="text-xs text-slate-600">
          Responda las preguntas para ver la severidad que corresponde.
        </p>
      )}
    </div>
  );
}
