import type { Project } from "@/db/schema";
import { linkClientToProjectAction } from "@/lib/crm";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

export function LinkClientToProjectForm({
  clientId,
  projects,
}: {
  clientId: string;
  projects: Project[];
}) {
  return (
    <form action={linkClientToProjectAction} className="grid gap-3 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm md:grid-cols-[1fr_190px_1fr_auto] md:items-end">
      <input type="hidden" name="clientId" value={clientId} />
      <label className="space-y-1.5 text-sm font-medium">
        Link to project
        <select name="projectId" className={inputClass} disabled={!projects.length}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
          {!projects.length && <option>No unlinked projects</option>}
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Role
        <select name="role" className={inputClass} defaultValue="other">
          <option value="bride">Bride</option>
          <option value="groom">Groom</option>
          <option value="partner">Partner</option>
          <option value="mother_of_bride">Mother of the bride</option>
          <option value="mother_of_groom">Mother of the groom</option>
          <option value="planner">Planner</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        Custom role
        <input name="customRole" placeholder="Father of the bride" className={inputClass} />
      </label>
      <button disabled={!projects.length} className="brand-primary-button rounded-sm px-4 py-2.5 transition disabled:cursor-not-allowed disabled:opacity-50">
        Link
      </button>
    </form>
  );
}
