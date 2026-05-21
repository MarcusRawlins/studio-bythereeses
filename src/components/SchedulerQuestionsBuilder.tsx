"use client";

import type { InviteeQuestion, InviteeQuestionType } from "@/lib/scheduler-types";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

const questionTypes: Array<{ value: InviteeQuestionType; label: string }> = [
  { value: "text", label: "Short answer" },
  { value: "textarea", label: "Long answer" },
  { value: "radio", label: "Multiple choice" },
  { value: "checkbox", label: "Checkboxes" },
  { value: "select", label: "Dropdown" },
];

function newQuestion(): InviteeQuestion {
  return {
    id: crypto.randomUUID(),
    label: "",
    type: "textarea",
    required: false,
    options: [],
  };
}

function optionValues(question: InviteeQuestion) {
  return question.options?.length ? question.options : [""];
}

export function SchedulerQuestionsBuilder({ questions }: { questions: InviteeQuestion[] }) {
  const [items, setItems] = useState<InviteeQuestion[]>(questions.length ? questions : [newQuestion()]);

  function updateQuestion(index: number, patch: Partial<InviteeQuestion>) {
    setItems((current) => current.map((question, currentIndex) => (
      currentIndex === index ? { ...question, ...patch } : question
    )));
  }

  function removeQuestion(index: number) {
    setItems((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function updateOption(questionIndex: number, optionIndex: number, value: string) {
    setItems((current) => current.map((question, currentIndex) => {
      if (currentIndex !== questionIndex) return question;
      const options = optionValues(question);
      return {
        ...question,
        options: options.map((option, currentOptionIndex) => (
          currentOptionIndex === optionIndex ? value : option
        )),
      };
    }));
  }

  function addOption(questionIndex: number) {
    setItems((current) => current.map((question, currentIndex) => (
      currentIndex === questionIndex
        ? { ...question, options: [...optionValues(question), ""] }
        : question
    )));
  }

  function removeOption(questionIndex: number, optionIndex: number) {
    setItems((current) => current.map((question, currentIndex) => {
      if (currentIndex !== questionIndex) return question;
      const options = optionValues(question).filter((_, currentOptionIndex) => currentOptionIndex !== optionIndex);
      return { ...question, options: options.length ? options : [""] };
    }));
  }

  return (
    <section className="grid gap-3 rounded-md border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Optional invitee questions</h3>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">Name and email are always required first. Add any extra questions below.</p>
        </div>
        <button
          type="button"
          onClick={() => setItems((current) => [...current, newQuestion()])}
          className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]"
        >
          <Plus className="h-4 w-4" />
          Add question
        </button>
      </div>

      {items.map((question, index) => {
        const needsOptions = question.type === "radio" || question.type === "checkbox" || question.type === "select";

        return (
          <div key={question.id} className="grid gap-2 rounded-md border border-[var(--line)] bg-[#faf7f1] p-3">
            <input type="hidden" name="questionId" value={question.id} />
            <input type="hidden" name="questionRequired" value="" />
            <div className="grid gap-2 md:grid-cols-[1fr_180px]">
              <input
                name="questionLabel"
                value={question.label}
                onChange={(event) => updateQuestion(index, { label: event.target.value })}
                placeholder="Question"
                className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
              />
              <select
                name="questionType"
                value={question.type}
                onChange={(event) => {
                  const type = event.target.value as InviteeQuestionType;
                  const needsOptionInputs = type === "radio" || type === "checkbox" || type === "select";
                  updateQuestion(index, {
                    type,
                    options: needsOptionInputs ? optionValues(question) : question.options,
                  });
                }}
                className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
              >
                {questionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </div>
            {needsOptions && (
              <div className="grid gap-2 rounded-sm border border-[var(--line)] bg-white p-3">
                <input
                  type="hidden"
                  name="questionOptions"
                  value={optionValues(question).map((option) => option.trim()).filter(Boolean).join("\n")}
                />
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Answer options</div>
                {optionValues(question).map((option, optionIndex) => (
                  <div key={`${question.id}-option-${optionIndex}`} className="grid gap-2 sm:grid-cols-[1fr_auto]">
                    <input
                      value={option}
                      onChange={(event) => updateOption(index, optionIndex, event.target.value)}
                      placeholder={`Option ${optionIndex + 1}`}
                      className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => removeOption(index, optionIndex)}
                      className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--danger)] transition hover:border-[var(--danger)]"
                    >
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addOption(index)}
                  className="inline-flex w-fit items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]"
                >
                  <Plus className="h-4 w-4" />
                  Add option
                </button>
              </div>
            )}
            {!needsOptions && <input type="hidden" name="questionOptions" value="" />}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-[var(--ink-muted)]">Optional</span>
              <button
                type="button"
                onClick={() => removeQuestion(index)}
                className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--danger)] transition hover:border-[var(--danger)]"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
