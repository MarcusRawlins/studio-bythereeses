import type { QuestionnaireQuestion } from "@/db/schema";

export type QuestionnaireAnswerValue = string | string[];
export type QuestionnaireAnswerMap = Record<string, QuestionnaireAnswerValue>;

function typeLabel(type: string) {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function QuestionnaireQuestionList({
  questions,
  clientPreview = false,
  defaultAnswers = {},
}: {
  questions: QuestionnaireQuestion[];
  clientPreview?: boolean;
  defaultAnswers?: QuestionnaireAnswerMap;
}) {
  return (
    <div className={clientPreview ? "space-y-5" : "divide-y divide-[var(--line)] rounded-md border border-[var(--line)]"}>
      {questions.map((question) => {
        if (clientPreview) {
          return (
            <div key={question.id}>
              {question.type === "section" ? (
                <div className="border-t border-[var(--line)] pt-5">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.16em]">{question.title}</h3>
                  {question.description && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{question.description}</p>}
                </div>
              ) : (
                <label className="block text-sm font-semibold">
                  {question.title}
                  {question.required && <span className="ml-1 text-[var(--brand-brown)]">*</span>}
                  {question.description && <span className="mt-1 block text-sm font-normal leading-6 text-[var(--ink-muted)]">{question.description}</span>}
                  <ClientPreviewField question={question} defaultValue={defaultAnswers[question.id]} />
                </label>
              )}
            </div>
          );
        }

        return (
          <div key={question.id} className="grid gap-3 p-4 md:grid-cols-[72px_1fr_150px]">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              {question.type === "section" ? "Section" : `Q${question.sortOrder + 1}`}
            </div>
            <div>
              <div className={question.type === "section" ? "font-semibold uppercase tracking-[0.08em]" : "font-semibold"}>{question.title}</div>
              {question.description && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{question.description}</p>}
              {question.optionsJson && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(JSON.parse(question.optionsJson) as string[]).map((option) => (
                    <span key={option} className="rounded-full border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink-muted)]">{option}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="text-sm text-[var(--ink-muted)]">
              <div>{typeLabel(question.type)}</div>
              {question.required && <div className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--brand-brown)]">Required</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClientPreviewField({
  question,
  defaultValue,
}: {
  question: QuestionnaireQuestion;
  defaultValue?: QuestionnaireAnswerValue;
}) {
  const options = question.optionsJson ? (JSON.parse(question.optionsJson) as string[]) : [];
  const fieldClass = "mt-2 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--brand-brown)]";
  const textDefault = Array.isArray(defaultValue) ? "" : defaultValue;
  const selectedValues = Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : [];

  if (question.type === "paragraph") {
    return <textarea rows={4} name={question.id} defaultValue={textDefault} className={fieldClass} />;
  }

  if (question.type === "multiple_choice" || question.type === "checkboxes") {
    return (
      <div className="mt-3 space-y-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm font-normal text-[var(--ink-muted)]">
            <input
              type={question.type === "multiple_choice" ? "radio" : "checkbox"}
              name={question.id}
              value={option}
              defaultChecked={selectedValues.includes(option)}
            />
            {option}
          </label>
        ))}
      </div>
    );
  }

  if (question.type === "dropdown") {
    return (
      <select name={question.id} defaultValue={textDefault || ""} className={fieldClass}>
        <option>Select one</option>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    );
  }

  return <input name={question.id} defaultValue={textDefault} className={fieldClass} />;
}
