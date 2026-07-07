"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Command, FolderKanban, Loader2, Search, X } from "lucide-react";

type ProjectSearchResult = {
  id: string;
  name: string;
  type: string;
  stage: string;
  status: string;
  eventDate: string | null;
  venueName: string | null;
  location: string | null;
  primaryClient: {
    name: string;
    email: string;
  } | null;
  openBalanceCents: number;
};

export function formatProjectMeta(project: ProjectSearchResult) {
  return [
    project.primaryClient?.name ?? "Needs primary client",
    project.eventDate,
    project.venueName ?? project.location,
  ].filter(Boolean).join(" · ");
}

export function QuickFind({ mobile = false }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectSearchResult[]>([]);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // AppShell mounts QuickFind TWICE — once in the mobile header (`mobile`) and once in the
    // desktop sidebar — both always in the DOM, only CSS-hidden by viewport. A global ⌘K listener
    // on BOTH opened two overlays at once (now two body portals) + fired two /api/search per
    // keystroke (Fable CR-3 review F6). ⌘K is a keyboard affordance → bind it to the desktop
    // instance ONLY. The mobile instance opens via its tap button; Escape stays bound on both so
    // whichever overlay is open closes.
    function onKeyDown(event: KeyboardEvent) {
      if (!mobile && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobile]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Search failed.");
        const payload = await response.json() as { projects?: ProjectSearchResult[] };
        setProjects(payload.projects ?? []);
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setProjects([]);
          setError(searchError instanceof Error ? searchError.message : "Search failed.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 120);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [open, query]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={mobile
          ? "studio-secondary-button flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--ink-3)]"
          : "studio-secondary-button mt-8 flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--ink-3)]"}
      >
        <Search className="h-4 w-4" />
        <span>Quick find</span>
        <span className="studio-caps ml-auto hidden items-center gap-1 text-[0.55rem] text-[var(--ink-3)] sm:flex">
          <Command className="h-3 w-3" /> K
        </span>
      </button>

      {/* CR-3: portal the dialog to <body>. The trigger renders inside the sticky mobile header
          (z-30 + backdrop-blur → its OWN stacking context) / the fixed desktop aside, so an inline
          fixed z-50 overlay is TRAPPED in that ancestor context and the app nav paints over the
          search. At the root stacking context z-50 reliably covers the header (z-30) and the
          z-auto sidebar. `open` only becomes true from client interaction, so document exists. */}
      {open ? createPortal(
        <div className="fixed inset-0 z-50 bg-black/25 px-4 py-5 backdrop-blur-sm sm:py-16" role="presentation" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Quick find"
            className="mx-auto w-full max-w-2xl rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--paper)] shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3">
              <Search className="h-4 w-4 text-[var(--ink-3)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects, clients, venues, cities, or emails"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ink-3)]"
              />
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-3)]" /> : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="studio-secondary-button grid h-8 w-8 place-items-center text-[var(--ink-3)]"
                aria-label="Close quick find"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-2">
              {error ? (
                <div className="px-3 py-8 text-center text-sm text-[var(--danger)]">{error}</div>
              ) : null}
              {!error && !loading && projects.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-[var(--ink-3)]">No projects found.</div>
              ) : null}
              {!error && projects.length > 0 ? (
                <div className="space-y-1">
                  {projects.map((project) => (
                    <Link
                      key={project.id}
                      href={`/projects/${project.id}`}
                      prefetch={false}
                      onClick={() => setOpen(false)}
                      className="flex items-start gap-3 border border-transparent px-3 py-3 transition hover:border-[var(--line)] hover:bg-[var(--paper-2)]"
                    >
                      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-3)]">
                        <FolderKanban className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-[var(--ink)]">{project.name}</div>
                        <div className="mt-1 truncate text-xs text-[var(--ink-3)]">{formatProjectMeta(project) || project.stage}</div>
                      </div>
                      {project.eventDate ? (
                        <div className="hidden shrink-0 items-center gap-1 text-xs text-[var(--ink-3)] sm:flex">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {project.eventDate}
                        </div>
                      ) : null}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
