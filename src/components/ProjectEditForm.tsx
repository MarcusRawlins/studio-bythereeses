import type { Project } from "@/db/schema";
import { updateProjectAction } from "@/lib/crm";
import Link from "next/link";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

const projectTypes = ["wedding", "engagement", "family", "branding", "portrait"];
const projectStages = [
  "inquiry",
  "proposal_sent",
  "retainer_paid",
  "planning",
  "editing",
  "delivered",
  "completed",
];
const projectStatuses = ["active", "on_hold", "completed", "archived"];

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function budgetValue(cents: number | null) {
  if (cents === null) return "";
  return String(cents / 100);
}

export function ProjectEditForm({ project }: { project: Project }) {
  return (
    <form action={updateProjectAction} className="grid gap-4 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
      <input type="hidden" name="projectId" value={project.id} />

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Project fields</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">Update the admin project record.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">
          Project name
          <input name="name" required defaultValue={project.name} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Event date
          <input name="eventDate" type="date" defaultValue={project.eventDate ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Type
          <select name="type" className={inputClass} defaultValue={project.type}>
            {projectTypes.map((type) => (
              <option key={type} value={type}>
                {titleize(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Stage
          <select name="stage" className={inputClass} defaultValue={project.stage}>
            {projectStages.map((stage) => (
              <option key={stage} value={stage}>
                {titleize(stage)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Status
          <select name="status" className={inputClass} defaultValue={project.status}>
            {projectStatuses.map((status) => (
              <option key={status} value={status}>
                {titleize(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Budget
          <input name="budgetCents" inputMode="decimal" defaultValue={budgetValue(project.budgetCents)} className={inputClass} />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1.5 text-sm font-medium sm:col-span-3">
          Venue
          <input name="venueName" defaultValue={project.venueName ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-3">
          Venue address
          <input name="venueAddress" defaultValue={project.venueAddress ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          City
          <input name="city" defaultValue={project.city ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          State
          <input name="state" defaultValue={project.state ?? ""} className={inputClass} />
        </label>
      </div>

      <label className="space-y-1.5 text-sm font-medium">
        Notes
        <textarea name="notes" rows={5} defaultValue={project.notes ?? ""} className={inputClass} />
      </label>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={`/projects/${project.id}`} className="inline-flex items-center justify-center rounded-sm border border-[var(--line)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--foreground)]">
          Cancel
        </Link>
        <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
          Save project
        </button>
      </div>
    </form>
  );
}
