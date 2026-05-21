import { clearPortalSession, requirePortalProject } from "@/lib/portal";
import { formatDate, formatMoney } from "@/lib/format";
import { LockKeyhole } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  await clearPortalSession();
  redirect("/portal");
}

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const data = await requirePortalProject();

  if (!data) {
    return (
      <main className="min-h-screen bg-[var(--background)] px-5 py-10 text-[var(--foreground)]">
        <div className="mx-auto max-w-xl rounded-md border border-[var(--line)] bg-[var(--surface)] p-8 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#edf6f1] text-[var(--accent)]">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h1 className="brand-page-title mt-5 text-3xl">Client portal</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            Open a secure portal link from Tyler to view your project. Portal links are project-specific and can be revoked at any time.
          </p>
          {error && <p className="mt-4 rounded-md border border-[var(--danger)] bg-[#fff4f1] p-3 text-sm text-[var(--danger)]">That portal link is invalid or expired.</p>}
        </div>
      </main>
    );
  }

  const primaryClient = data.clients[0];

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-medium text-[var(--ink-muted)]">Reese Photography</p>
            <h1 className="brand-page-title mt-1 text-4xl">{data.project.name}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              Welcome, {primaryClient?.preferredName ?? primaryClient?.firstName}. This portal is scoped only to this project.
            </p>
          </div>
          <form action={logoutAction}>
            <button className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
              Log out
            </button>
          </form>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Event date</div>
            <div className="mt-2 text-xl font-semibold">{formatDate(data.project.eventDate)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Venue</div>
            <div className="mt-2 text-xl font-semibold">{data.project.venueName ?? "TBD"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Project value</div>
            <div className="mt-2 text-xl font-semibold">{formatMoney(data.project.budgetCents)}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-6">
          <h2 className="text-lg font-semibold">Project status</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {["Inquiry", "Proposal", "Planning", "Delivery"].map((label) => (
              <div key={label} className="rounded-md border border-[var(--line)] bg-[#fbf7f0] p-4">
                <div className="text-sm font-semibold">{label}</div>
                <div className="mt-1 text-xs text-[var(--ink-muted)]">Coming into focus</div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-sm leading-6 text-[var(--ink-muted)]">
            Contracts, invoices, questionnaires, and timelines will appear here as they are added to the CRM.
          </p>
        </section>
      </div>
    </main>
  );
}
