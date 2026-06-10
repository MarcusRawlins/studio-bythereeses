import { projectStageOptions } from "@/lib/crm";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

export function CreateProjectForClientForm({ clientId }: { clientId: string }) {
  return (
    <form action={`/api/clients/${clientId}/projects`} method="post" className="grid gap-3 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
      <div className="grid gap-3 md:grid-cols-[1.3fr_160px_180px]">
        <label className="space-y-1.5 text-sm font-medium">
          Project name
          <input name="projectName" required placeholder="Bailey & Parker Wedding" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Type
          <select name="type" defaultValue="wedding" className={inputClass}>
            <option value="wedding">Wedding</option>
            <option value="portrait">Portrait</option>
            <option value="brand">Brand</option>
            <option value="event">Event</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Stage
          <select name="stage" defaultValue="inquiry" className={inputClass}>
            {projectStageOptions.map((stage) => (
              <option key={stage.value} value={stage.value}>{stage.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[170px_1fr_1fr_90px]">
        <label className="space-y-1.5 text-sm font-medium">
          Date
          <input name="eventDate" type="date" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Venue
          <input name="venueName" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          City
          <input name="city" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          State
          <input name="state" className={inputClass} />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[180px_180px_1fr_auto] md:items-end">
        <label className="space-y-1.5 text-sm font-medium">
          Budget
          <input name="budget" inputMode="decimal" placeholder="7500" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Client role
          <select name="primaryClientRole" defaultValue="primary" className={inputClass}>
            <option value="primary">Primary</option>
            <option value="bride">Bride</option>
            <option value="groom">Groom</option>
            <option value="partner">Partner</option>
            <option value="planner">Planner</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Notes
          <input name="notes" className={inputClass} />
        </label>
        <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Create project</button>
      </div>
    </form>
  );
}
