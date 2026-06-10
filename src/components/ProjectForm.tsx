import { ProjectFormDynamicFields } from "@/components/ProjectFormDynamicFields";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

export function ProjectForm() {
  return (
    <form action="/api/projects" method="post" className="grid gap-4 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Create Project</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">Add the project and primary client together.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium">
          Project name
          <input name="projectName" required placeholder="Emma & Jordan Wedding" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Event date
          <input name="eventDate" type="date" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Type
          <select name="type" className={inputClass} defaultValue="wedding">
            <option value="wedding">Wedding</option>
            <option value="engagement">Engagement</option>
            <option value="family">Family</option>
            <option value="branding">Branding</option>
            <option value="portrait">Portrait</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Stage
          <select name="stage" className={inputClass} defaultValue="inquiry">
            <option value="inquiry">Inquiry</option>
            <option value="proposal_sent">Proposal sent</option>
            <option value="retainer_paid">Retainer paid</option>
            <option value="planning">Planning</option>
            <option value="editing">Editing</option>
            <option value="delivered">Delivered</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1.5 text-sm font-medium sm:col-span-3">
          Venue
          <input name="venueName" placeholder="Venue name" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-3">
          Venue address
          <input name="venueAddress" placeholder="2 E Main St, Beacon, NY 12508" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          City
          <input name="city" placeholder="Beacon" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          State
          <input name="state" placeholder="NY" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Budget
          <input name="budget" inputMode="decimal" placeholder="8500" className={inputClass} />
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-md border border-[var(--line)] bg-white p-3 text-sm font-medium">
        <input name="engagementSessionIncluded" type="checkbox" className="mt-1 h-4 w-4 rounded border-[var(--line)] accent-[var(--accent)]" />
        <span>
          Engagement session included
          <span className="mt-1 block text-xs font-normal text-[var(--ink-muted)]">
            Adds an unscheduled engagement reminder until the date is set.
          </span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
          Primary client role
          <select name="primaryClientRole" className={inputClass} defaultValue="bride">
            <option value="bride">Bride</option>
            <option value="groom">Groom</option>
            <option value="partner">Partner</option>
            <option value="primary">Primary contact</option>
            <option value="planner">Planner</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          First name
          <input name="firstName" required placeholder="Emma" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Last name
          <input name="lastName" placeholder="Taylor" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Preferred name
          <input name="preferredName" placeholder="Emma" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Email
          <input name="email" required type="email" placeholder="emma@example.com" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
          Phone
          <input name="phone" placeholder="555-0123" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Instagram
          <input name="instagramHandle" placeholder="@emma" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          Source
          <input name="referralSource" placeholder="Planner, referral, inquiry form" className={inputClass} />
        </label>
        <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
          Communication preference
          <textarea name="communicationPreference" rows={3} placeholder="Email for contracts; text for week-of logistics." className={inputClass} />
        </label>
      </div>

      <ProjectFormDynamicFields />

      <label className="space-y-1.5 text-sm font-medium">
        Notes
        <textarea name="notes" rows={3} placeholder="Anything important about the inquiry or project." className={inputClass} />
      </label>

      <p className="text-xs text-[var(--ink-muted)]">
        Google Calendar sync is tracked on the project now. Actual calendar creation will turn on after Google OAuth/API credentials are connected.
      </p>

      <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">
        Create project
      </button>
    </form>
  );
}
