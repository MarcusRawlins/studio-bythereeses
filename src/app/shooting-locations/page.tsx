import { AppShell } from "@/components/AppShell";
import { formatDate } from "@/lib/format";
import { listShootingLocations, parseShootingLocationTags } from "@/lib/shooting-locations";
import { ExternalLink, MapPin, Pencil, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

const inputClass = "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--foreground)]";
const labelClass = "space-y-1.5 text-sm font-medium";

type ShootingLocation = Awaited<ReturnType<typeof listShootingLocations>>[number];

function tagsValue(location?: ShootingLocation) {
  return parseShootingLocationTags(location?.tagsJson ?? null).join(", ");
}

function LocationFields({ location }: { location?: ShootingLocation }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {location && <input type="hidden" name="locationId" value={location.id} />}
      <label className={labelClass}>
        Name
        <input name="name" defaultValue={location?.name ?? ""} placeholder="Rock Harbor Beach" className={inputClass} required />
      </label>
      <label className={labelClass}>
        Status
        <select name="status" defaultValue={location?.status ?? "active"} className={inputClass}>
          <option value="active">Active</option>
          <option value="needs_scouting">Needs scouting</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      <label className={labelClass}>
        Region
        <input name="region" defaultValue={location?.region ?? ""} placeholder="Cape Cod" className={inputClass} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          City
          <input name="city" defaultValue={location?.city ?? ""} placeholder="Orleans" className={inputClass} />
        </label>
        <label className={labelClass}>
          State
          <input name="state" defaultValue={location?.state ?? ""} placeholder="MA" className={inputClass} />
        </label>
        <label className={labelClass}>
          Country
          <input name="country" defaultValue={location?.country ?? "USA"} className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        Type
        <select name="locationType" defaultValue={location?.locationType ?? "other"} className={inputClass}>
          <option value="beach">Beach</option>
          <option value="venue">Venue</option>
          <option value="park">Park</option>
          <option value="estate">Estate</option>
          <option value="garden">Garden</option>
          <option value="urban">Urban</option>
          <option value="waterfront">Waterfront</option>
          <option value="mountain">Mountain</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className={labelClass}>
        Tags
        <input name="tags" defaultValue={tagsValue(location)} placeholder="cape cod, beach, sunset, drone" className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        Address
        <input name="address" defaultValue={location?.address ?? ""} placeholder="Optional exact address or parking area" className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        Google Maps URL
        <input name="googleMapsUrl" type="url" defaultValue={location?.googleMapsUrl ?? ""} placeholder="https://maps.google.com/..." className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        Best for
        <textarea name="bestFor" defaultValue={location?.bestFor ?? ""} rows={2} className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        Permit / rule notes
        <textarea name="permitNotes" defaultValue={location?.permitNotes ?? ""} rows={2} className={inputClass} />
      </label>
      <label className={labelClass}>
        Access notes
        <textarea name="accessNotes" defaultValue={location?.accessNotes ?? ""} rows={3} className={inputClass} />
      </label>
      <label className={labelClass}>
        Light notes
        <textarea name="lightNotes" defaultValue={location?.lightNotes ?? ""} rows={3} className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        Drone notes
        <textarea name="droneNotes" defaultValue={location?.droneNotes ?? ""} rows={2} className={inputClass} />
      </label>
      <label className={`${labelClass} md:col-span-2`}>
        General notes
        <textarea name="generalNotes" defaultValue={location?.generalNotes ?? ""} rows={3} className={inputClass} />
      </label>
    </div>
  );
}

export default async function ShootingLocationsPage() {
  const locations = await listShootingLocations();
  const activeLocations = locations.filter((location) => location.status !== "archived");
  const regions = new Set(activeLocations.map((location) => location.region).filter(Boolean));

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <h1 className="brand-page-title text-4xl">Shooting Locations</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Reusable location notes for sessions, weddings, scouting, and drone planning.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-64">
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-3">
              <div className="text-xs text-[var(--ink-muted)]">Active</div>
              <div className="mt-1 text-2xl font-semibold">{activeLocations.length}</div>
            </div>
            <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-3">
              <div className="text-xs text-[var(--ink-muted)]">Regions</div>
              <div className="mt-1 text-2xl font-semibold">{regions.size}</div>
            </div>
          </div>
        </header>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-lg font-semibold">
              <Plus className="h-4 w-4" />
              Add shooting location
            </summary>
            <form action="/api/shooting-locations" method="post" className="mt-5 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
              <input type="hidden" name="_action" value="create" />
              <LocationFields />
              <button className="brand-primary-button mt-4 inline-flex items-center gap-2 rounded-sm px-4 py-2.5 transition">
                <Plus className="h-4 w-4" />
                Add location
              </button>
            </form>
          </details>
        </section>

        <section className="grid gap-4">
          {locations.map((location) => {
            const tags = parseShootingLocationTags(location.tagsJson);

            return (
              <details key={location.id} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                <summary className="grid cursor-pointer list-none gap-3 md:grid-cols-[1fr_auto] md:items-start">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <MapPin className="h-4 w-4 text-[var(--ink-muted)]" />
                      <h2 className="text-lg font-semibold">{location.name}</h2>
                      <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
                        {location.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      {[location.region, location.city, location.state].filter(Boolean).join(" · ") || "Location details TBD"}
                    </p>
                    {location.bestFor && <p className="mt-3 text-sm leading-6 text-[var(--ink-2)]">{location.bestFor}</p>}
                    {tags.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {tags.map((tag) => <span key={tag} className="studio-chip">{tag}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {location.googleMapsUrl && (
                      <a href={location.googleMapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                        <ExternalLink className="h-4 w-4" />
                        Map
                      </a>
                    )}
                    <span className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold">
                      <Pencil className="h-4 w-4" />
                      Edit
                    </span>
                  </div>
                </summary>

                <div className="mt-5 grid gap-4 border-t border-[var(--line)] pt-5 lg:grid-cols-[1fr_420px]">
                  <div className="space-y-4 text-sm leading-6">
                    {[
                      ["Permit / rules", location.permitNotes],
                      ["Access", location.accessNotes],
                      ["Light", location.lightNotes],
                      ["Drone", location.droneNotes],
                      ["Notes", location.generalNotes],
                    ].map(([label, value]) => value ? (
                      <div key={label}>
                        <div className="studio-caps text-[0.58rem] text-[var(--ink-3)]">{label}</div>
                        <p className="mt-1 text-[var(--ink-2)]">{value}</p>
                      </div>
                    ) : null)}
                    <p className="text-xs text-[var(--ink-3)]">Updated {formatDate(location.updatedAt.slice(0, 10))}</p>
                  </div>

                  <div>
                    <form action="/api/shooting-locations" method="post" className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
                      <input type="hidden" name="_action" value="update" />
                      <LocationFields location={location} />
                      <button className="brand-primary-button mt-4 inline-flex items-center gap-2 rounded-sm px-4 py-2.5 transition">
                        <Pencil className="h-4 w-4" />
                        Save location
                      </button>
                    </form>
                    {location.status !== "archived" && (
                      <form action="/api/shooting-locations" method="post" className="mt-3">
                        <input type="hidden" name="_action" value="archive" />
                        <input type="hidden" name="locationId" value={location.id} />
                        <button className="text-sm font-semibold text-[var(--danger)]">Archive location</button>
                      </form>
                    )}
                  </div>
                </div>
              </details>
            );
          })}
          {!locations.length && (
            <div className="rounded-md border border-dashed border-[var(--line)] bg-[var(--surface)] p-8 text-sm text-[var(--ink-muted)]">
              No shooting locations yet.
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
