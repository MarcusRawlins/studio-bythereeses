import type { Client } from "@/db/schema";
import { updateClientAction } from "@/lib/crm";
import Link from "next/link";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

export function ClientForm({ client }: { client: Client }) {
  return (
    <form action={updateClientAction} className="grid gap-4 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
      <input type="hidden" name="clientId" value={client.id} />

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Client details</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">Keep contact information and private notes current.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">
          First name
          <input name="firstName" required defaultValue={client.firstName} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Last name
          <input name="lastName" defaultValue={client.lastName ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Preferred name
          <input name="preferredName" defaultValue={client.preferredName ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Email
          <input name="email" required type="email" defaultValue={client.email} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
          Phone
          <input name="phone" defaultValue={client.phone ?? ""} className={inputClass} />
        </label>
      </div>

      <label className="space-y-1.5 text-sm font-medium">
        Notes
        <textarea name="notes" rows={5} defaultValue={client.notes ?? ""} className={inputClass} />
      </label>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
          Save client
        </button>
        <Link href={`/clients/${client.id}`} className="rounded-sm border border-[var(--line)] px-4 py-2.5 text-center text-sm font-semibold transition hover:border-[var(--foreground)]">
          Cancel
        </Link>
      </div>
    </form>
  );
}
