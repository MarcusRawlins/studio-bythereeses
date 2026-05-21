import { AppShell } from "@/components/AppShell";
import { listClients } from "@/lib/crm";
import { formatDate } from "@/lib/format";
import { Mail, Phone } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function clientName(client: { firstName: string; lastName: string | null }) {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

type ClientSort = "name" | "latestProject" | "projectCount" | "createdAt";

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function clientMatchesSearch(row: Awaited<ReturnType<typeof listClients>>[number], search: string) {
  if (!search) return true;
  const haystack = [
    row.client.firstName,
    row.client.lastName,
    row.client.preferredName,
    row.client.email,
    row.client.phone,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const rawSearch = firstQueryValue(params.q) ?? "";
  const rawSort = firstQueryValue(params.sort);
  const sort: ClientSort = rawSort === "latestProject" || rawSort === "projectCount" || rawSort === "createdAt" ? rawSort : "name";
  const rows = (await listClients()).filter((row) => clientMatchesSearch(row, rawSearch)).toSorted((a, b) => {
    if (sort === "projectCount") return b.projectCount - a.projectCount;
    if (sort === "latestProject") return String(b.latestProjectDate ?? "").localeCompare(String(a.latestProjectDate ?? ""));
    if (sort === "createdAt") return String(b.client.createdAt).localeCompare(String(a.client.createdAt));
    return clientName(a.client).localeCompare(clientName(b.client));
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="border-b border-[var(--line)] pb-5">
          <div>
            <h1 className="brand-page-title text-4xl">Clients</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Contact records and linked photography projects.</p>
          </div>
        </header>

        <section className="border-b border-[var(--line)] pb-5">
          <form action="/clients" className="grid gap-3 md:grid-cols-[1fr_210px_auto]">
            <label className="space-y-1.5 text-sm font-medium">
              Search clients
              <input name="q" defaultValue={rawSearch} placeholder="Name, email, phone" className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]" />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Sort
              <select name="sort" defaultValue={sort} className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]">
                <option value="name">Client name</option>
                <option value="latestProject">Latest project</option>
                <option value="projectCount">Most projects</option>
                <option value="createdAt">Recently added</option>
              </select>
            </label>
            <button className="brand-primary-button self-end rounded-sm px-4 py-2.5 transition">Apply</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]">
          <div className="grid grid-cols-[1.2fr_1fr_150px_150px] border-b border-[var(--line)] bg-[#eee8de] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)] max-lg:hidden">
            <div>Client</div>
            <div>Contact</div>
            <div>Projects</div>
            <div>Latest project</div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {rows.map(({ client, projectCount, latestProjectDate }) => (
              <Link key={client.id} href={`/clients/${client.id}`} prefetch={false} className="grid gap-3 px-4 py-4 transition hover:bg-[#f6efe5] lg:grid-cols-[1.2fr_1fr_150px_150px] lg:items-center">
                <div>
                  <div className="font-semibold">{clientName(client)}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{client.preferredName ? `Prefers ${client.preferredName}` : "No preferred name set"}</div>
                </div>
                <div className="space-y-1 text-sm text-[var(--ink-muted)]">
                  <div className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5" />
                    {client.email}
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5" />
                    {client.phone || "No phone"}
                  </div>
                </div>
                <div className="text-sm font-semibold">{projectCount}</div>
                <div className="text-sm text-[var(--ink-muted)]">{latestProjectDate ? formatDate(latestProjectDate.slice(0, 10)) : "None yet"}</div>
              </Link>
            ))}
            {!rows.length && <div className="p-8 text-sm text-[var(--ink-muted)]">No clients yet.</div>}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
