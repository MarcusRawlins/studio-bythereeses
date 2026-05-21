"use client";

import type { Questionnaire, QuestionnaireQuestion } from "@/db/schema";
import { ClipboardList, GripVertical, Save, Send } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

const inputClass = "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--brand-brown)] focus:ring-2 focus:ring-[rgba(122,102,92,0.14)]";
const subtleButtonClass = "inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]";

const questionTypes = [
  ["section", "Section"],
  ["short_text", "Short text"],
  ["paragraph", "Paragraph"],
  ["multiple_choice", "Multiple choice"],
  ["checkboxes", "Checkboxes"],
  ["dropdown", "Dropdown"],
  ["linear_scale", "Linear scale"],
] as const;

function optionsText(question: QuestionnaireQuestion) {
  if (!question.optionsJson) return "";
  try {
    return (JSON.parse(question.optionsJson) as string[]).join("\n");
  } catch {
    return "";
  }
}

function previewField(question: QuestionnaireQuestion) {
  const fieldClass = "mt-2 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--brand-brown)]";
  const options = question.optionsJson ? (JSON.parse(question.optionsJson) as string[]) : [];

  if (question.type === "paragraph") {
    return <textarea rows={3} className={fieldClass} aria-label={question.title} />;
  }

  if (question.type === "multiple_choice" || question.type === "checkboxes") {
    return (
      <div className="mt-3 space-y-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm font-normal text-[var(--ink-muted)]">
            <input type={question.type === "multiple_choice" ? "radio" : "checkbox"} name={`preview-${question.id}`} />
            {option}
          </label>
        ))}
      </div>
    );
  }

  if (question.type === "dropdown") {
    return (
      <select className={fieldClass} aria-label={question.title}>
        <option>Select one</option>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    );
  }

  return <input className={fieldClass} aria-label={question.title} />;
}

type QuestionnaireTemplateEditorProps = {
  questionnaire: Questionnaire;
  questions: QuestionnaireQuestion[];
  updateQuestionnaire: (formData: FormData) => void | Promise<void>;
  updateQuestion: (formData: FormData) => void | Promise<void>;
  reorderQuestions: (formData: FormData) => void | Promise<void>;
};

export function QuestionnaireTemplateEditor({ questionnaire, questions, updateQuestionnaire, updateQuestion, reorderQuestions }: QuestionnaireTemplateEditorProps) {
  const [orderedQuestions, setOrderedQuestions] = useState(questions);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const orderedQuestionIds = useMemo(() => orderedQuestions.map((question) => question.id).join(","), [orderedQuestions]);

  function dropOn(targetId: string, position: "before" | "after") {
    if (!draggedId || draggedId === targetId) return;
    setOrderedQuestions((current) => {
      const dragged = current.find((question) => question.id === draggedId);
      if (!dragged) return current;
      const withoutDragged = current.filter((question) => question.id !== draggedId);
      const targetIndex = withoutDragged.findIndex((question) => question.id === targetId);
      if (targetIndex < 0) return current;
      const insertAt = position === "after" ? targetIndex + 1 : targetIndex;
      return [
        ...withoutDragged.slice(0, insertAt),
        dragged,
        ...withoutDragged.slice(insertAt),
      ];
    });
    setDraggedId(null);
    setDropTarget(null);
  }

  function updateDropTarget(questionId: string, element: HTMLElement, clientY: number) {
    const bounds = element.getBoundingClientRect();
    const position = clientY > bounds.top + bounds.height / 2 ? "after" : "before";
    setDropTarget({ id: questionId, position });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-center">
        <div>
          <Link href="/questionnaires" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
            Back to questionnaire templates
          </Link>
          <h1 className="mt-3 text-3xl font-semibold">Questionnaire template</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center px-2 text-sm italic text-[var(--ink-muted)]">Saved changes update the live template</span>
          <Link href={`/questionnaires/${questionnaire.id}/preview`} className={subtleButtonClass}>
            Client preview
          </Link>
          <Link href={`/questionnaires/${questionnaire.id}/responses`} className={subtleButtonClass}>
            <ClipboardList className="h-4 w-4" />
            Responses
          </Link>
          <Link href={`/questionnaires/${questionnaire.id}/send`} className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-4 py-2 text-xs">
            <Send className="h-4 w-4" />
            Send
          </Link>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,0.78fr)_minmax(420px,1.22fr)]">
        <form action={updateQuestionnaire} className="h-fit rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <input type="hidden" name="questionnaireId" value={questionnaire.id} />
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm font-semibold">
              Form title
              <input name="title" defaultValue={questionnaire.title} className={inputClass} required />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Form description
              <textarea name="description" defaultValue={questionnaire.description ?? ""} rows={8} className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Status
              <select name="status" defaultValue={questionnaire.status} className={inputClass}>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <button className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-3">
              <Save className="h-4 w-4" />
              Save details
            </button>
          </div>
        </form>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--line)] p-6">
            <h2 className="font-['Times_Now',Georgia,serif] text-4xl leading-tight">{questionnaire.title}</h2>
            {questionnaire.description && <p className="mt-4 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{questionnaire.description}</p>}
          </div>

          <div className="space-y-4 p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-lg font-semibold">Questions</h3>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Drag from the handle, then save the order.</p>
              </div>
              <form action={reorderQuestions}>
                <input type="hidden" name="questionnaireId" value={questionnaire.id} />
                <input type="hidden" name="orderedQuestionIds" value={orderedQuestionIds} />
                <button className={subtleButtonClass}>Save order</button>
              </form>
            </div>

            <div className="space-y-3">
              {orderedQuestions.map((question, index) => (
                <details
                  key={question.id}
                  className={[
                    "group rounded-md border bg-[#fbf9f5] transition",
                    dropTarget?.id === question.id ? "border-[var(--brand-brown)]" : "border-[var(--line)]",
                    dropTarget?.id === question.id && dropTarget.position === "before" ? "shadow-[0_-4px_0_var(--brand-brown)]" : "",
                    dropTarget?.id === question.id && dropTarget.position === "after" ? "shadow-[0_4px_0_var(--brand-brown)]" : "",
                  ].filter(Boolean).join(" ")}
                  onDragOver={(event) => {
                    if (!draggedId) return;
                    event.preventDefault();
                    updateDropTarget(question.id, event.currentTarget, event.clientY);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOn(question.id, dropTarget?.position ?? "before");
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    setDropTarget(null);
                  }}
                >
                  <summary className="grid cursor-pointer list-none gap-3 p-4 md:grid-cols-[44px_1fr] md:items-center">
                    <span
                      role="button"
                      tabIndex={0}
                      draggable
                      onClick={(event) => event.preventDefault()}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", question.id);
                        setDraggedId(question.id);
                      }}
                      className="flex cursor-grab items-center gap-1 text-[var(--ink-muted)] active:cursor-grabbing"
                      aria-label="Drag question to reorder"
                    >
                      <GripVertical className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase tracking-[0.12em]">{question.type === "section" ? "S" : `Q${index + 1}`}</span>
                    </span>
                    <div>
                      <div className={question.type === "section" ? "font-semibold uppercase tracking-[0.08em]" : "font-semibold"}>{question.title}</div>
                      {question.description && <p className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--ink-muted)]">{question.description}</p>}
                    </div>
                  </summary>

                  <div className="border-t border-[var(--line)] p-4">
                    <form action={updateQuestion} className="grid gap-4">
                      <input type="hidden" name="questionnaireId" value={questionnaire.id} />
                      <input type="hidden" name="questionId" value={question.id} />
                      <div className="grid gap-3 md:grid-cols-[1fr_180px]">
                        <label className="grid gap-1.5 text-sm font-semibold">
                          Question text
                          <input name="title" defaultValue={question.title} className={inputClass} required />
                        </label>
                        <label className="grid gap-1.5 text-sm font-semibold">
                          Type
                          <select name="type" defaultValue={question.type} className={inputClass}>
                            {questionTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </label>
                      </div>
                      <label className="grid gap-1.5 text-sm font-semibold">
                        Helper text
                        <textarea name="description" defaultValue={question.description ?? ""} rows={2} className={inputClass} />
                      </label>
                      <label className="grid gap-1.5 text-sm font-semibold">
                        Options
                        <textarea name="options" defaultValue={optionsText(question)} rows={3} className={inputClass} placeholder="One option per line for multiple choice, checkbox, or dropdown questions." />
                      </label>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2 text-sm font-semibold">
                          <input type="checkbox" name="required" defaultChecked={question.required} />
                          Required
                        </label>
                        <button className={subtleButtonClass}>Save question</button>
                      </div>
                    </form>

                    <div className="mt-5 rounded-md border border-dashed border-[var(--line)] bg-white p-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Client preview</div>
                      {question.type === "section" ? (
                        <div className="mt-3 border-t border-[var(--line)] pt-4">
                          <h4 className="text-sm font-semibold uppercase tracking-[0.16em]">{question.title}</h4>
                          {question.description && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{question.description}</p>}
                        </div>
                      ) : (
                        <label className="mt-3 block text-sm font-semibold">
                          {question.title}
                          {question.required && <span className="ml-1 text-[var(--brand-brown)]">*</span>}
                          {question.description && <span className="mt-1 block text-sm font-normal leading-6 text-[var(--ink-muted)]">{question.description}</span>}
                          {previewField(question)}
                        </label>
                      )}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}
