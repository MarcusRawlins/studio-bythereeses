import { AppShell } from "@/components/AppShell";

export function PlannedAdminPage({
  title,
  description,
  phase = "Phase 2",
}: {
  title: string;
  description: string;
  phase?: string;
}) {
  return (
    <AppShell>
      <div className="space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <h1 className="brand-page-title text-4xl">{title}</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">{description}</p>
        </header>
        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{phase} admin workspace</div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
            This section is intentionally visible in the navigation so the CRM has the full shape of the business. The current build order is Scheduler and Templates first, then Proposals and Invoices, then Questionnaires and client-facing automation.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
