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
          <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">The Reeses Studio</div>
          <h1 className="brand-page-title mt-2 text-5xl">{title}</h1>
          <p className="mt-2 font-[var(--serif)] text-xl italic text-[var(--ink-2)]">{description}</p>
        </header>
        <section className="studio-card">
          <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{phase} admin workspace</div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ink-3)]">
            This section is intentionally visible in the navigation so the CRM has the full shape of the business. The current build order is Scheduler and Templates first, then Proposals and Invoices, then Questionnaires and client-facing automation.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
