import { ClientForm } from "@/components/ClientForm";
import { AppShell } from "@/components/AppShell";
import { getClientWithProjects } from "@/lib/crm";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function clientName(client: { firstName: string; lastName: string | null }) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClientWithProjects(id);
  if (!data) notFound();

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <Link href={`/clients/${data.client.id}`} className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">
            Back to client
          </Link>
          <h1 className="brand-page-title mt-3 text-4xl">Edit {clientName(data.client)}</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">Update contact fields and internal notes.</p>
        </header>

        <ClientForm client={data.client} />
      </div>
    </AppShell>
  );
}
