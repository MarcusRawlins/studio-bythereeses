"use client";

// Phase 17 — kanban pipeline board (dark behind PROJECTS_BOARD_VIEW), spec rev 2
// (docs/specs/phase-17-kanban-pipeline-board.md). Mirrors `ProjectBulkSelection.tsx` as the
// closest existing pattern: client state + `fetch` to an existing route, no new dependency. Drag
// uses the native HTML5 Drag and Drop API (the repo has no dnd library); every card also ships the
// keyboard/no-drag `<select>` fallback as the primary (not degraded) mobile/PWA path.
//
// All non-network logic (grouping, optimistic move/revert, show-more slicing, the invalid-stage
// guard, and the success/login-bounce/failure predicate) lives in the pure `@/lib/project-board`
// module so it's unit-testable without a DOM — see `project-board.test.ts`.

import {
  BOARD_MOVE_TIMEOUT_MS,
  COLUMN_CARD_CAP,
  groupProjectsByStage,
  isValidProjectStage,
  loginBounceRedirectUrl,
  moveProjectLocalStage,
  performBoardMove,
  visibleColumnCards,
  type ProjectBoardCard,
  type ProjectStageOption,
} from "@/lib/project-board";
import Link from "next/link";
import { useMemo, useState } from "react";

export type ProjectBoardProps = {
  activeStages: string[];
  projects: ProjectBoardCard[];
  stages: ProjectStageOption[];
};

function stageLabel(stages: ProjectStageOption[], value: string) {
  return stages.find((stage) => stage.value === value)?.label ?? value;
}

export function ProjectBoard({ activeStages, projects: initialProjects, stages }: ProjectBoardProps) {
  const [projects, setProjects] = useState<ProjectBoardCard[]>(initialProjects);
  const [expandedByStage, setExpandedByStage] = useState<Record<string, number>>({});
  const [pendingProjectIds, setPendingProjectIds] = useState<Set<string>>(() => new Set());
  const [cardErrors, setCardErrors] = useState<Map<string, string>>(() => new Map());

  const grouped = useMemo(() => groupProjectsByStage(projects, activeStages), [projects, activeStages]);

  async function moveCard(projectId: string, nextStage: string) {
    if (!isValidProjectStage(nextStage, stages)) return;

    const current = projects.find((project) => project.id === projectId);
    if (!current || current.stage === nextStage || pendingProjectIds.has(projectId)) return;
    const previousStage = current.stage;

    setProjects((rows) => moveProjectLocalStage(rows, projectId, nextStage));
    setPendingProjectIds((ids) => new Set(ids).add(projectId));
    setCardErrors((errors) => {
      if (!errors.has(projectId)) return errors;
      const next = new Map(errors);
      next.delete(projectId);
      return next;
    });

    try {
      const result = await performBoardMove({
        fetchImpl: fetch,
        projectId,
        nextStage,
        timeoutMs: BOARD_MOVE_TIMEOUT_MS,
      });

      if (result.outcome === "success") {
        // Local state already matches the new canonical stage — unlike ProjectRowActions /
        // ProjectBulkSelection, do NOT reload; a full reload would defeat optimistic UI (lost
        // scroll position, columns re-collapse).
        return;
      }

      if (result.outcome === "login-bounce") {
        setProjects((rows) => moveProjectLocalStage(rows, projectId, previousStage));
        window.location.assign(loginBounceRedirectUrl(`${window.location.pathname}${window.location.search}`));
        return;
      }

      setProjects((rows) => moveProjectLocalStage(rows, projectId, previousStage));
      setCardErrors((errors) => {
        const next = new Map(errors);
        next.set(projectId, result.timedOut ? "Couldn't confirm — refresh" : "Move failed — refresh");
        return next;
      });
    } finally {
      setPendingProjectIds((ids) => {
        const next = new Set(ids);
        next.delete(projectId);
        return next;
      });
    }
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-4" data-testid="project-board">
      {activeStages.map((stage) => {
        const columnRows = grouped.get(stage) ?? [];
        const { visible, showMore } = visibleColumnCards(columnRows, expandedByStage[stage] ?? 0, COLUMN_CARD_CAP);

        return (
          <div
            key={stage}
            className={`studio-stage-${stage} flex min-h-[12rem] w-72 shrink-0 flex-col gap-3 rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper-2)] p-3`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const projectId = event.dataTransfer.getData("text/plain");
              if (projectId) void moveCard(projectId, stage);
            }}
          >
            <div className="flex items-center justify-between px-1">
              <span className="studio-caps text-[0.6rem] text-[var(--ink-3)]">{stageLabel(stages, stage)}</span>
              <span className="studio-caps text-[0.6rem] text-[var(--ink-3)]">{columnRows.length}</span>
            </div>

            <div className="flex flex-col gap-2">
              {visible.map((card) => {
                const isPending = pendingProjectIds.has(card.id);
                const error = cardErrors.get(card.id);

                return (
                  <div
                    key={card.id}
                    draggable={!isPending}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", card.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    className="rounded-[var(--radius-panel)] border border-[var(--line-soft)] bg-[var(--paper)] p-3 shadow-[0_8px_20px_rgba(31,27,24,0.05)]"
                  >
                    <Link href={`/projects/${card.id}`} prefetch={false} className="block text-sm font-semibold leading-snug transition hover:text-[var(--accent)]">
                      {card.name}
                    </Link>
                    <div className="mt-1 text-xs text-[var(--ink-3)]">
                      {card.client ? `${card.client.firstName ?? ""} ${card.client.lastName ?? ""}`.trim() || card.client.email : "Needs primary client"}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-[var(--ink-3)]">
                      <span>{card.dateLabel}</span>
                      <span className="font-semibold tabular-nums">{card.budgetLabel}</span>
                    </div>
                    {card.milestoneSummary && (
                      <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${card.milestoneSummary.hasOverdue ? "text-[var(--warning)]" : "text-[var(--ink-3)]"}`}>
                        <span className="font-semibold tabular-nums">
                          {card.milestoneSummary.doneCount}/{card.milestoneSummary.totalCount}
                        </span>
                        {card.milestoneSummary.currentLabel && <span className="truncate">{card.milestoneSummary.currentLabel}</span>}
                        {card.milestoneSummary.hasOverdue && <span className="studio-caps text-[0.55rem] font-semibold">Overdue</span>}
                      </div>
                    )}
                    <label className="mt-2 block">
                      <span className="sr-only">Move {card.name} to a different stage</span>
                      <select
                        value={card.stage}
                        disabled={isPending}
                        className="studio-input min-h-9 w-full text-xs"
                        onChange={(event) => void moveCard(card.id, event.target.value)}
                      >
                        {stages.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    {isPending && <p className="mt-1 text-[0.65rem] font-semibold text-[var(--accent)]">Saving...</p>}
                    {error && <p className="mt-1 text-[0.65rem] font-semibold text-[var(--warning)]">{error}</p>}
                  </div>
                );
              })}
              {showMore && (
                <button
                  type="button"
                  className="studio-secondary-button min-h-9 px-3 py-2 text-xs font-semibold"
                  onClick={() => setExpandedByStage((current) => ({ ...current, [stage]: columnRows.length }))}
                >
                  Show {columnRows.length - visible.length} more
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
