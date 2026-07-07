"use client";

import { ProjectRowActions } from "@/components/ProjectRowActions";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type ProjectStageOption = {
  value: string;
  label: string;
};

// Phase 22 (dark behind PROJECT_PROGRESS_TIMELINE). Optional — undefined when the flag is off, so
// the row renders byte-identically to before this phase.
type ProjectMilestoneBarSummary = {
  currentLabel: string | null;
  doneCount: number;
  hasOverdue: boolean;
  totalCount: number;
};

type ProjectBulkSelectionRow = {
  client: {
    email: string | null;
    firstName: string | null;
    id: string;
    lastName: string | null;
  } | null;
  project: {
    budgetLabel: string;
    dateLabel: string;
    id: string;
    milestoneSummary?: ProjectMilestoneBarSummary | null;
    name: string;
    stage: string;
  };
};

type ProjectBulkSelectionProps = {
  rows: ProjectBulkSelectionRow[];
  stages: ProjectStageOption[];
  totalCount: number;
};

function SelectAllCheckbox({
  checked,
  disabled = false,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label="Select all projects on this page"
      className="h-4 w-4 rounded border border-[var(--line)] accent-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
      onChange={onChange}
    />
  );
}

export function ProjectBulkSelection({ rows, stages, totalCount }: ProjectBulkSelectionProps) {
  const pageProjectIds = useMemo(() => rows.map(({ project }) => project.id), [rows]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkStage, setBulkStage] = useState(stages[0]?.value ?? "inquiry");
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedCount = selectedIds.size;
  const allPageSelected = pageProjectIds.length > 0 && pageProjectIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageProjectIds.some((id) => selectedIds.has(id));
  const selectAllLabel = selectedCount
    ? allPageSelected
      ? "All shown selected"
      : `${selectedCount} selected`
    : "Select all shown";

  function toggleProject(projectId: string) {
    setMessage(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function togglePageSelection() {
    setMessage(null);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const id of pageProjectIds) next.delete(id);
      } else {
        for (const id of pageProjectIds) next.add(id);
      }
      return next;
    });
  }

  async function moveSelectedStage() {
    if (!selectedCount || isSaving) return;

    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/projects/bulk/stage", {
        body: JSON.stringify({
          projectIds: Array.from(selectedIds),
          stage: bulkStage,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.error ?? "Bulk stage update failed.");
      }

      setMessage(`Moved ${payload.updatedCount} of ${payload.requestedCount} selected projects.`);
      setSelectedIds(new Set());
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk stage update failed.");
    } finally {
      setIsSaving(false);
    }
  }

  async function archiveSelectedProjects() {
    if (!selectedCount || isSaving) return;

    const confirmed = window.confirm(
      `Archive ${selectedCount} selected project${selectedCount === 1 ? "" : "s"}?\n\nThey will be hidden from the active Projects list, but linked clients, invoices, proposals, sources, tasks, and activity history will stay intact. You can restore a project by setting its status back to active from its edit page.`,
    );
    if (!confirmed) return;

    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/projects/bulk/archive", {
        body: JSON.stringify({
          projectIds: Array.from(selectedIds),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(payload?.error ?? "Bulk project archive failed.");
      }

      setMessage(`Archived ${payload.archivedCount} of ${payload.requestedCount} selected projects.`);
      setSelectedIds(new Set());
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Bulk project archive failed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section id="projects-list" className="rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper)] max-lg:border-0 max-lg:bg-transparent">
      <div className="mb-3 flex items-center justify-between gap-4 rounded-[var(--radius-panel)] border border-[var(--line-soft)] bg-[rgba(255,255,255,0.92)] px-3 py-3 shadow-[0_12px_35px_rgba(31,27,24,0.06)] backdrop-blur-sm lg:mb-0 lg:rounded-b-none lg:border-x-0 lg:border-t-0 lg:px-4 lg:shadow-none">
        <div className="flex min-h-9 items-center gap-3 text-sm font-semibold text-[var(--ink-2)]">
          <SelectAllCheckbox
            checked={allPageSelected}
            disabled={!pageProjectIds.length}
            indeterminate={somePageSelected && !allPageSelected}
            onChange={togglePageSelection}
          />
          <button
            type="button"
            disabled={!pageProjectIds.length}
            className="text-left font-semibold transition hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={togglePageSelection}
          >
            {selectAllLabel}
          </button>
        </div>
        <p className="studio-caps text-right text-[0.55rem] text-[var(--ink-3)]">{rows.length} shown</p>
        {message && <p className="text-sm font-semibold text-[var(--ink-2)]">{message}</p>}
      </div>

      {selectedCount > 0 && (
        <div className="sticky top-3 z-30 mx-3 mb-3 rounded-2xl border border-[rgba(216,210,197,0.9)] bg-[rgba(255,255,255,0.96)] p-2 shadow-[0_18px_45px_rgba(31,27,24,0.14)] backdrop-blur-xl sm:mx-4 lg:top-4 lg:mx-auto lg:max-w-2xl">
          <div className="grid gap-2 sm:grid-cols-[1fr_minmax(0,190px)_auto_auto] sm:items-center">
            <div className="flex items-center justify-between gap-3 px-2">
              <span className="text-sm font-semibold">{selectedCount} selected</span>
              <button
                type="button"
                className="text-xs font-semibold text-[var(--ink-3)] transition hover:text-[var(--ink)]"
                onClick={() => {
                  setMessage(null);
                  setSelectedIds(new Set());
                }}
              >
                Clear
              </button>
            </div>
            <select
              value={bulkStage}
              className="studio-input min-h-10 py-2 text-sm"
              aria-label="Bulk move stage"
              disabled={isSaving}
              onChange={(event) => setBulkStage(event.target.value)}
            >
              {stages.map((stage) => (
                <option key={stage.value} value={stage.value}>{stage.label}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={isSaving}
              className="brand-primary-button min-h-10 px-4 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              onClick={moveSelectedStage}
            >
              {isSaving ? "Moving..." : "Move"}
            </button>
            <button
              type="button"
              disabled={isSaving}
              title="Archive selected projects. Linked records are preserved."
              className="studio-secondary-button min-h-10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-3)] disabled:cursor-not-allowed disabled:opacity-55"
              onClick={archiveSelectedProjects}
            >
              Delete
            </button>
          </div>
          {message && <p className="px-2 pt-2 text-sm font-semibold text-[var(--ink-2)]">{message}</p>}
        </div>
      )}

      <div className="studio-caps grid grid-cols-[44px_1.2fr_1fr_140px_140px_120px_44px] border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[0.58rem] text-[var(--ink-3)] max-lg:hidden">
        <div />
        <div>Project</div>
        <div>Client</div>
        <div>Date</div>
        <div>Stage</div>
        <div>Value</div>
        <div className="text-right">Actions</div>
      </div>
      <div className="max-lg:space-y-2">
        {rows.map(({ project, client }) => {
          const isSelected = selectedIds.has(project.id);

          return (
            <div
              key={project.id}
              className={`relative grid gap-3 rounded-[var(--radius-panel)] border border-[var(--line-soft)] bg-[var(--paper)] px-3 py-4 pl-12 pr-14 transition hover:bg-[var(--paper-2)] sm:px-4 sm:pl-12 sm:pr-14 lg:rounded-none lg:grid-cols-[44px_1.2fr_1fr_140px_140px_120px_44px] lg:items-center lg:gap-2 lg:border-x-0 lg:border-t-0 lg:pl-4 lg:pr-4 lg:last:border-b-0 ${isSelected ? "outline outline-1 outline-[var(--ink)]" : ""}`}
            >
              <div className="absolute left-3 top-4 flex lg:static lg:items-center">
                <input
                  type="checkbox"
                  checked={isSelected}
                  aria-label={`Select ${project.name}`}
                  className="h-4 w-4 rounded border border-[var(--line)] accent-[var(--ink)]"
                  onChange={() => toggleProject(project.id)}
                />
              </div>
              <div className="min-w-0">
                <Link href={`/projects/${project.id}`} prefetch={false} className="block text-base font-semibold leading-snug transition hover:text-[var(--accent)] lg:text-[0.95rem]">
                  {project.name}
                </Link>
                <div className="mt-2 flex flex-wrap items-center gap-2 lg:hidden">
                  <span className={`studio-chip studio-stage-${project.stage}`}>{project.stage.replaceAll("_", " ")}</span>
                  <span className="text-xs text-[var(--ink-3)]">{project.dateLabel}</span>
                </div>
                {project.milestoneSummary && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${project.milestoneSummary.hasOverdue ? "text-[var(--warning)]" : "text-[var(--ink-3)]"}`}>
                    <span className="font-semibold tabular-nums">
                      {project.milestoneSummary.doneCount}/{project.milestoneSummary.totalCount}
                    </span>
                    {project.milestoneSummary.currentLabel && <span className="truncate">{project.milestoneSummary.currentLabel}</span>}
                    {project.milestoneSummary.hasOverdue && <span className="studio-caps text-[0.55rem] font-semibold">Overdue</span>}
                  </div>
                )}
              </div>
              {client ? (
                <div className="min-w-0 text-sm text-[var(--ink-3)]">
                  <Link href={`/clients/${client.id}`} prefetch={false} className="font-semibold text-[var(--ink)] transition hover:text-[var(--accent)]">
                    {client.firstName} {client.lastName}
                  </Link>
                  <span className="mx-1 hidden sm:inline">·</span>
                  <span className="mt-0.5 block break-all sm:mt-0 sm:inline">{client.email}</span>
                </div>
              ) : (
                <div className="text-sm font-semibold text-[var(--warning)]">Needs primary client</div>
              )}
              <div className="hidden text-sm text-[var(--ink-3)] lg:block">{project.dateLabel}</div>
              <div className="max-lg:hidden"><span className={`studio-chip studio-stage-${project.stage}`}>{project.stage.replaceAll("_", " ")}</span></div>
              <div className="flex items-center justify-between gap-3 text-sm font-semibold tabular-nums lg:block">
                <span className="studio-caps text-[0.55rem] text-[var(--ink-3)] lg:hidden">Value</span>
                <span>{project.budgetLabel}</span>
              </div>
              <div className="absolute right-3 top-3 flex justify-end sm:right-4 lg:static">
                <ProjectRowActions
                  currentStage={project.stage}
                  projectId={project.id}
                  projectName={project.name}
                  stages={stages}
                />
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <div className="rounded-[var(--radius-panel)] border border-[var(--line-soft)] bg-[var(--paper)] p-8 text-sm text-[var(--ink-3)]">
            {totalCount ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>No projects match the current search or stage filters.</span>
                <Link href="/projects" prefetch={false} className="font-semibold text-[var(--accent-strong)] underline">
                  Clear filters
                </Link>
              </div>
            ) : (
              "No projects yet."
            )}
          </div>
        )}
      </div>
    </section>
  );
}
