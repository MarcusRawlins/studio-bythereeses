"use client";

import { useState } from "react";

const inputClass =
  "w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition placeholder:text-[#aaa197] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(47,93,80,0.14)]";

type Block = {
  id: string;
  type: string;
};

function newBlock(type = "other") {
  return { id: crypto.randomUUID(), type };
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-xs font-semibold transition hover:border-[var(--foreground)]">
      Remove
    </button>
  );
}

export function ProjectFormDynamicFields() {
  const [events, setEvents] = useState<Block[]>([]);
  const [locations, setLocations] = useState<Block[]>([]);
  const [clients, setClients] = useState<Block[]>([]);

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setEvents((current) => [...current, newBlock("engagement")])}
          className="rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
        >
          + Additional Project Event
        </button>
        {events.map((event, index) => (
          <div key={event.id} className="grid gap-3 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Additional project event</h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">Engagement session, rehearsal/welcome party, portrait, or other project date.</p>
              </div>
              <RemoveButton onClick={() => setEvents((current) => current.filter((item) => item.id !== event.id))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Event title
                <input name="projectEventTitle" placeholder={index === 0 ? "Engagement session" : "Project event"} className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Event date
                <input name="projectEventDate" type="date" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Type
                <select
                  name="projectEventType"
                  className={inputClass}
                  value={event.type}
                  onChange={(changeEvent) => setEvents((current) => current.map((item) => item.id === event.id ? { ...item, type: changeEvent.target.value } : item))}
                >
                  <option value="engagement">Engagement</option>
                  <option value="rehearsal">Rehearsal / Welcome party</option>
                  <option value="portrait">Portrait</option>
                  <option value="other">Other</option>
                </select>
              </label>
              {event.type === "other" && (
                <label className="space-y-1.5 text-sm font-medium">
                  Custom type
                  <input name="projectEventCustomType" placeholder="After party" className={inputClass} />
                </label>
              )}
              {event.type !== "other" && <input type="hidden" name="projectEventCustomType" value="" />}
              <label className="space-y-1.5 text-sm font-medium">
                Venue
                <input name="projectEventVenueName" placeholder="Location name" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                Address
                <input name="projectEventVenueAddress" placeholder="Full address" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                City
                <input name="projectEventCity" placeholder="Cold Spring" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                State
                <input name="projectEventState" placeholder="NY" className={inputClass} />
              </label>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setLocations((current) => [...current, newBlock("ceremony")])}
          className="rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
        >
          + Wedding Day Location
        </button>
        {locations.map((location) => (
          <div key={location.id} className="grid gap-3 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Wedding day location</h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">Ceremony, getting ready, portraits, reception, or another location tied to the wedding day.</p>
              </div>
              <RemoveButton onClick={() => setLocations((current) => current.filter((item) => item.id !== location.id))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Type
                <select
                  name="projectLocationType"
                  className={inputClass}
                  value={location.type}
                  onChange={(changeEvent) => setLocations((current) => current.map((item) => item.id === location.id ? { ...item, type: changeEvent.target.value } : item))}
                >
                  <option value="ceremony">Ceremony</option>
                  <option value="getting_ready">Getting ready</option>
                  <option value="portraits">Portraits</option>
                  <option value="reception">Reception</option>
                  <option value="other">Other</option>
                </select>
              </label>
              {location.type === "other" && (
                <label className="space-y-1.5 text-sm font-medium">
                  Custom type
                  <input name="projectLocationCustomType" placeholder="After party" className={inputClass} />
                </label>
              )}
              {location.type !== "other" && <input type="hidden" name="projectLocationCustomType" value="" />}
              <label className="space-y-1.5 text-sm font-medium">
                Location name
                <input name="projectLocationName" placeholder="Ceremony church" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                Address
                <input name="projectLocationAddress" placeholder="Full address" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                City
                <input name="projectLocationCity" placeholder="Beacon" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                State
                <input name="projectLocationState" placeholder="NY" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                Notes
                <input name="projectLocationNotes" placeholder="Parking, timing, access notes" className={inputClass} />
              </label>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setClients((current) => [...current, newBlock("groom")])}
          className="rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]"
        >
          + Additional Client
        </button>
        {clients.map((client) => (
          <div key={client.id} className="grid gap-3 rounded-md border border-[var(--line)] bg-[#faf7f1] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Additional client</h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">Add a partner, parent, planner, or another person connected to the project.</p>
              </div>
              <RemoveButton onClick={() => setClients((current) => current.filter((item) => item.id !== client.id))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Role
                <select
                  name="additionalClientRole"
                  className={inputClass}
                  value={client.type}
                  onChange={(changeEvent) => setClients((current) => current.map((item) => item.id === client.id ? { ...item, type: changeEvent.target.value } : item))}
                >
                  <option value="bride">Bride</option>
                  <option value="groom">Groom</option>
                  <option value="partner">Partner</option>
                  <option value="mother_of_bride">Mother of the bride</option>
                  <option value="mother_of_groom">Mother of the groom</option>
                  <option value="planner">Planner</option>
                  <option value="other">Other</option>
                </select>
              </label>
              {client.type === "other" && (
                <label className="space-y-1.5 text-sm font-medium">
                  Custom role
                  <input name="additionalClientCustomRole" placeholder="Father of the bride" className={inputClass} />
                </label>
              )}
              {client.type !== "other" && <input type="hidden" name="additionalClientCustomRole" value="" />}
              <label className="space-y-1.5 text-sm font-medium">
                First name
                <input name="additionalClientFirstName" placeholder="Jordan" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Last name
                <input name="additionalClientLastName" placeholder="Taylor" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Preferred name
                <input name="additionalClientPreferredName" placeholder="Jordan" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Email
                <input name="additionalClientEmail" type="email" placeholder="jordan@example.com" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                Phone
                <input name="additionalClientPhone" placeholder="555-0123" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Instagram
                <input name="additionalClientInstagramHandle" placeholder="@jordan" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Source
                <input name="additionalClientReferralSource" placeholder="Planner, referral, inquiry form" className={inputClass} />
              </label>
              <label className="space-y-1.5 text-sm font-medium sm:col-span-2">
                Communication preference
                <textarea name="additionalClientCommunicationPreference" rows={3} placeholder="Email for contracts; text for week-of logistics." className={inputClass} />
              </label>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
