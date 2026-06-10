"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type ProjectStageOption = {
  value: string;
  label: string;
};

type ProjectRowActionsProps = {
  currentStage: string;
  projectId: string;
  projectName: string;
  stages: ProjectStageOption[];
};

export function ProjectRowActions({ currentStage, projectId, projectName, stages }: ProjectRowActionsProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingStage, setPendingStage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  async function moveStage(nextStage: string) {
    if (nextStage === currentStage || pendingStage) return;

    const formData = new FormData();
    formData.set("stage", nextStage);
    setPendingStage(nextStage);

    try {
      const response = await fetch(`/api/projects/${projectId}/stage`, {
        body: formData,
        method: "POST",
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Project stage update failed.");
      }

      setIsOpen(false);
      window.location.reload();
    } finally {
      setPendingStage(null);
    }
  }

  return (
    <div ref={menuRef} className="relative z-20">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={`Project actions for ${projectName}`}
        className="studio-secondary-button inline-flex h-9 w-9 items-center justify-center text-[var(--ink)]"
        onClick={() => setIsOpen((value) => !value)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-11 w-64 rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper)] p-2 text-sm shadow-[0_18px_45px_rgba(31,27,24,0.14)]"
        >
          <div className="studio-caps px-2 py-1.5 text-[0.55rem] text-[var(--ink-3)]">Project</div>
          <Link
            role="menuitem"
            href={`/projects/${projectId}`}
            prefetch={false}
            className="block rounded-md px-2 py-2 font-semibold transition hover:bg-[var(--paper-2)]"
            onClick={() => setIsOpen(false)}
          >
            Open project
          </Link>
          <Link
            role="menuitem"
            href={`/projects/${projectId}/edit`}
            prefetch={false}
            className="block rounded-md px-2 py-2 font-semibold transition hover:bg-[var(--paper-2)]"
            onClick={() => setIsOpen(false)}
          >
            Edit details
          </Link>

          <div className="my-2 border-t border-[var(--line-soft)]" />
          <div className="studio-caps px-2 py-1.5 text-[0.55rem] text-[var(--ink-3)]">Move stage</div>
          <div className="grid gap-1">
            {stages.map((stage) => {
              const isCurrent = stage.value === currentStage;
              const isPending = pendingStage === stage.value;

              return (
                <button
                  key={stage.value}
                  type="button"
                  role="menuitem"
                  disabled={isCurrent || Boolean(pendingStage)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left font-semibold transition hover:bg-[var(--paper-2)] disabled:cursor-default disabled:text-[var(--ink-3)] disabled:hover:bg-transparent"
                  onClick={() => moveStage(stage.value)}
                >
                  <span className={`studio-chip studio-stage-${stage.value}`}>{stage.label}</span>
                  {isCurrent && <span className="studio-caps text-[0.5rem] text-[var(--ink-3)]">Current</span>}
                  {isPending && <span className="studio-caps text-[0.5rem] text-[var(--accent)]">Saving</span>}
                </button>
              );
            })}
          </div>

          <div className="my-2 border-t border-[var(--line-soft)]" />
          <button
            type="button"
            role="menuitem"
            disabled
            title="Project deletion needs a safe archive/delete workflow before it is enabled."
            className="block w-full px-2 py-2 text-left font-semibold text-[var(--ink-3)]"
          >
            Delete...
          </button>
        </div>
      )}
    </div>
  );
}
