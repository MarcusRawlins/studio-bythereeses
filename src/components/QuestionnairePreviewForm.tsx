"use client";

import {
  QuestionnaireQuestionList,
} from "@/components/QuestionnaireQuestionList";
import type { QuestionnaireAnswerMap } from "@/components/QuestionnaireQuestionList";
import type { QuestionnaireQuestion } from "@/db/schema";
import { Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

function readDraft(form: HTMLFormElement) {
  const data = new FormData(form);
  const draft: QuestionnaireAnswerMap = {};

  for (const [key, value] of data.entries()) {
    if (key === "context" || key === "intent") continue;
    const textValue = String(value);
    if (key in draft) {
      const existing = draft[key];
      draft[key] = Array.isArray(existing) ? [...existing, textValue] : [existing, textValue];
    } else {
      draft[key] = textValue;
    }
  }

  return draft;
}

function applyDraft(form: HTMLFormElement, draft: QuestionnaireAnswerMap) {
  for (const [name, value] of Object.entries(draft)) {
    const fields = Array.from(form.elements).filter(
      (element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        "name" in element && element.name === name,
    );

    for (const field of fields) {
      if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
        const selectedValues = Array.isArray(value) ? value : [value];
        field.checked = selectedValues.includes(field.value);
      } else {
        field.value = Array.isArray(value) ? value.join(", ") : value;
      }
    }
  }
}

export function QuestionnairePreviewForm({
  questionnaireId,
  context,
  questions,
  defaultAnswers,
  savedState,
}: {
  questionnaireId: string;
  context: string;
  questions: QuestionnaireQuestion[];
  defaultAnswers: QuestionnaireAnswerMap;
  savedState?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [savedMessage, setSavedMessage] = useState(savedState ? "Progress saved." : "");
  const storageKey = useMemo(
    () => `questionnaire-draft:${questionnaireId}:${context || "preview"}`,
    [questionnaireId, context],
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const savedDraft = window.localStorage.getItem(storageKey);
    if (savedDraft) {
      try {
        applyDraft(form, JSON.parse(savedDraft) as QuestionnaireAnswerMap);
      } catch {
        window.localStorage.removeItem(storageKey);
      }
    }
  }, [storageKey]);

  function saveDeviceDraft() {
    const form = formRef.current;
    if (!form) return;
    window.localStorage.setItem(storageKey, JSON.stringify(readDraft(form)));
    setSavedMessage("Draft saved on this device.");
  }

  function handleChange() {
    saveDeviceDraft();
  }

  function handleSubmit() {
    // Keep the local draft through submit in case validation or the network fails.
    saveDeviceDraft();
  }

  return (
    <form
      ref={formRef}
      action={`/api/questionnaires/${questionnaireId}/responses`}
      method="post"
      className="p-7"
      onChange={handleChange}
      onSubmit={handleSubmit}
    >
      {context && <input type="hidden" name="context" value={context} />}
      <QuestionnaireQuestionList questions={questions} clientPreview defaultAnswers={defaultAnswers} />
      <div className="mt-8 grid gap-3 sm:grid-cols-[1fr_1.5fr]">
        <button
          type="submit"
          name="intent"
          value="save"
          formNoValidate
          className="inline-flex items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-4 py-3 text-sm font-semibold transition hover:border-[var(--brand-brown)]"
        >
          <Save className="h-4 w-4" />
          Save progress
        </button>
        <button type="submit" name="intent" value="submit" className="brand-primary-button rounded-sm px-4 py-3">
          Submit questionnaire
        </button>
      </div>
      <p className="mt-3 min-h-5 text-xs text-[var(--ink-muted)]">
        {savedMessage || "Progress is saved on this device as you type."}
      </p>
    </form>
  );
}
