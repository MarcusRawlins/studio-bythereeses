# Phase 20 — Structured meeting/consult notes

Status: spec rev 2 (Fable adversarial spec review returned APPROVE WITH CHANGES; all findings folded
in below — see §6 changelog).
Origin: roadmap Tier 3 (`docs/roadmap-competitive-parity.md:68-69`, "Phase 20 — Structured
meeting/consult notes. Per-booking/consult notes surface distinct from questionnaires (today:
single `project.notes` + note-channel rows)."). Risk class: LOW — Tyler named this the lowest-risk
item in the Tier 3 batch: one nullable column, zero new tables, zero new endpoints, zero new MCP
tools, admin-only UI additions behind a dark flag.

## 0. What Tyler asked for — and what v1 narrows

**The gap.** After a consult call (a `scheduler_bookings` row — a consult call IS a booking,
`src/db/schema.ts:168-206`), Tyler wants a structured record of what was discussed, decided, and
what to follow up on, tied to *that specific meeting* — surfaced both on the booking and on the
project. Today he has exactly two places to put it, neither fits:
- `projects.notes` (`schema.ts:54`) — one free-text blob per project, already reserved for general
  "client preferences, planning decisions, logistics" working notes (`project-notes.ts`,
  `projects/[id]/page.tsx:887-888`). Burying a call recap here loses which call it was about, and
  competes with everything else already living there.
- `project_communications` rows with `channel: "note"` (`schema.ts:378-404`, canonicalized by
  migration `0060_project_communication_canon_guard.sql`) — already exist and already render in the
  project page's Communications section (`projects/[id]/page.tsx:1136-1457`). They're untyped free
  text with no link to which booking (if any) prompted them.

**What already exists that this phase reuses, unchanged:**
- The `note` channel itself — already a canonical enum member (`project-communications.ts:19`,
  migration `0060` triggers), already renders in the Communications feed, already has a "Log as sent
  (no send)" action distinct from the SMS/email send actions (`projects/[id]/page.tsx:1287-1311`).
- The booking detail page, `/scheduler/bookings/[id]` (`src/app/scheduler/bookings/[id]/page.tsx`) —
  exists today (payment recording, client/project linkage, "create project from booking"), but has
  **no notes surface at all**.
- The agenda's "today's calls" feed (`src/lib/agenda.ts:118-135, 183-199`) already links each
  booking row to `/scheduler/bookings/${row.bookingId}`.

**v1 narrowings (deliberate, each reversible by a follow-up CR):**
- **Reuse `project_communications`, add one nullable link column — no new table.** See D1.
- **Template is UI scaffolding text, not new schema.** "Discussed / Decisions / Follow-ups" ship as
  literal placeholder text pre-filling the note body textarea — free-edited like any other note.
  No structured per-section storage, no parsing. See D5.
- **Linkage is create-time only.** `bookingId` is set once, at creation; there is no "reassign this
  note to a different meeting" edit path in v1. See D4.
- **No agenda "has notes" indicator.** `agenda.ts`'s `getAgenda` is an always-on, ungated read path
  (no existing flag branch); adding a per-booking notes-lookup would need its own batched,
  flag-gated query for a feature Tyler asked for only "optionally." Deferred — noted in §5.
- **No "create task from follow-up" button.** `agent_tasks` (`schema.ts:328-346`) already exists,
  but wiring a follow-up line to a task is its own small feature (parsing free text into a task
  title, an actor decision, etc.) — out of scope for a lean v1. The follow-ups section is plain text
  for now. Deferred — noted in §5.
- **A meeting note requires a linked project.** A `scheduler_bookings` row can exist with
  `projectId: null` (`schema.ts:171`); `project_communications.projectId` is `NOT NULL`
  (`schema.ts:380`). An unlinked booking cannot get a meeting note — the booking page already has
  "Link to existing project" / "Create project from booking" forms
  (`scheduler/bookings/[id]/page.tsx:187-215`) as the prerequisite path. See D7.

## 1. Design decisions

**D1 — Reuse `project_communications`; the entire migration is one nullable column + one index.**
Migration `0060_project_communication_canon_guard.sql` already declares `channel` canonical over
`('email', 'sms', 'call', 'note')` (lines 5, 14, 26, 35) — a "note" is already a first-class
communication kind with its own actor attribution (`createdBy`), activity logging
(`logActivity` calls in `project-communications.ts:230-244, 313-326`), and canon-guard triggers. A
new `project_meeting_notes` table would duplicate all of that apparatus for a record that is
data-shape-identical to today's note rows plus one linkage field. Migration **`0098`** —
`0095_questionnaire_autofill_review.sql` is the current tail, but assigning the next-free number
naively collides: Phase 18 (`docs/specs/phase-18-ai-daily-brief.md`) and Phase 19
(`docs/specs/phase-19-embeddable-lead-form.md`) both also claim `0096` for their own additive
columns. Resolved by build order — **18 → `0096`, 19 → `0097`, this phase (20) → `0098`** — so all
three land without a three-way collision. **Build-time caveat, mandatory:** before writing this
migration file, `grep migrations/` for its actual current tail (Phases 18/19 may have shipped,
been renumbered, or been dropped by the time this phase builds) and renumber `0098` to whatever the
next free slot actually is — every `0098` reference in this spec is a placeholder for "next free
slot as of build time," not a hard requirement to force a collision if reality has moved on since
this rev was written:

```sql
-- 0098: Phase 20 structured meeting/consult notes. Additive, nullable, non-breaking.
-- Links a project_communications "note" channel row to the scheduler_bookings row it was taken
-- during (a consult call). NULL for every existing row and for any note not tied to a specific
-- meeting (e.g. a general project note) — unchanged behavior.
ALTER TABLE project_communications ADD COLUMN booking_id TEXT;

CREATE INDEX IF NOT EXISTS idx_project_communications_booking_id ON project_communications(booking_id);
```

`src/db/schema.ts`'s `projectCommunications` table gets a matching `bookingId: text("booking_id")`
field (typed, no `.references()` clause — see D2) plus a `ProjectCommunication` type update (the
type is inferred from the table, so no separate change needed).

**D2 — `booking_id` is a plain column, no DB-level FK constraint; referential integrity is enforced
in application code.** No migration in this repo's 96 files adds a `REFERENCES` clause via `ALTER
TABLE ... ADD COLUMN` — every FK-constrained column is declared at `CREATE TABLE` time (e.g.
migration `0089_finance_completeness.sql:40`, `payment_refunds.scheduler_booking_id TEXT REFERENCES
scheduler_bookings(id) ON DELETE SET NULL`, declared when that table was first created). Following
that convention, `booking_id` here stays a plain `TEXT` column. Integrity is enforced the same way
`sourceType: "project_source"` links are today: `requireProjectSourceForTask`
(`src/lib/agent-sources.ts:233-240`) validates a `project_sources` row belongs to the target
project before the write proceeds. This phase adds the mirror-image helper,
`requireBookingBelongsToProject(projectId, bookingId)`, in `project-communications.ts`: looks up
the `scheduler_bookings` row by id, throws if it doesn't exist or its `projectId` doesn't match —
called from `createProjectCommunication` whenever `bookingId` is present. This is strictly stronger
than a canon-guard trigger's "is this trimmed non-empty text" check (§ below explains why `booking_id`
is deliberately *not* added to migration `0060`'s trigger column lists).

**D3 — Admin-only linkage via an actor-based clamp on the new field, not by touching the existing
`note`-channel agent access at all.** Verified against the live code: **`channel: "note"` rows are
already fully agent-writable today, in any status.** The agent clamp in `createProjectCommunication`
(`project-communications.ts:206`) and `updateProjectCommunication` (`:270-275`) only forces
`status: "draft"` when `channel === "sms" || channel === "email"` for an agent actor — `note` was
never included. The generic MCP tools `studio_create_communication` / `studio_update_communication`
(`src/lib/studio-mcp.ts:1151-1200`) expose `channel: { enum: ["email", "sms", "call", "note"] }`
with no additional gating, and `docs/studio-agent-access.md:291-295` documents the SMS/email clamp
explicitly but says nothing about `note` — because there is no clamp on it. The Phase 14 spec's own
§8 write-up of "the agent authority gap" (`docs/specs/phase-14-two-way-email.md:358-362`) is scoped
to widening the SMS clamp to email; it never touched `note` either. **This is a real, pre-existing
gap relative to "admin-only writes," but it predates Phase 20 and is a generic-notes concern, not a
meeting-note-linkage concern — fixing "any agent can write any note in any status" is out of scope
here** (flagged explicitly, not silently left undocumented — see §5).

What Phase 20 actually needs to guarantee is narrower: **the *linkage* capability (`bookingId`) must
never be agent-writable**, or a prompt-injected agent could impersonate "a structured meeting note
Tyler took on this call" — attaching false authority to a note that reads as if it came from a
reviewed consult. Fix: `bookingId` gets a clamp, but written as an **allowlist, not a denylist** —
`createProjectCommunication` sets `bookingId: actor.actorType === "admin" ? cleanText(input.bookingId)
: null` (silently dropped, not thrown — a non-admin actor's note still saves normally, just
unlinked, exactly like every note it writes today). The allowlist form is deliberate: a denylist
(`actor.actorType === "agent" ? null : cleanText(...)`) would pass `bookingId` through for every
actor type that *isn't* `"agent"` — including `system` (the sequence runner) today, and silently for
any actor type added later (`CommunicationActor.actorType` already lists `"client"`,
`project-communications.ts:91`, unused today but present in the type). Only the admin form (Tyler,
authenticated) ever legitimately sets `bookingId`, so the clamp names that one case rather than
excluding the one case it happens to know about — it can't rot as new actor types are added. `bookingId` is also deliberately **not**
added to the `studio_create_communication` / `studio_update_communication` tool schemas (which have
`additionalProperties: false`, `studio-mcp.ts:1173, 1198`) — kept undiscoverable in the tool
contract. But the schema omission is *documentation*, not the enforcement: the raw REST route
(`src/app/api/agent/projects/[id]/communications/route.ts:16-20`) forwards `await request.json()`
straight into `createProjectCommunicationFromAgent` with no JSON-schema validation, so a caller
bearing the agent bearer token could still send `bookingId` directly over HTTP. The runtime clamp
inside `createProjectCommunication` is the actual boundary — matching this repo's established
pattern ("the real enforcement is a table-level boundary... not just tool schema",
`docs/studio-agent-access.md:294`).

This clamp only covers *minting* a linked note. "Never agent-writable" is a promise about the
linkage capability, not about the create path specifically — it applies with equal force to a note
that is already linked, sitting in the table, having been genuinely authored by Tyler on a real
call. D4 below adds the mirror-image guard on the update path so that promise actually holds
end-to-end.

**D4 — `bookingId` is create-time only for *setting* linkage; the update path gets one authority
guard so a booking-linked row can't be forged after the fact.**
`UpdateProjectCommunicationInput` never gains a `bookingId` field, and
`updateProjectCommunicationFromForm`/`updateProjectCommunicationFromAgent`
(`project-communications.ts:73-85, 360-380`) get **zero changes**. A note's meeting linkage is still
fixed at creation; relinking to a different booking is not supported in v1 (a rare edge case —
create a new note instead).

But D3's threat model doesn't stop at minting. An already-linked row (`booking_id` set, written by
the admin actor through the create clamp) *is* "a structured meeting note Tyler took on this
call" — exactly the thing D3 exists to protect — and, as drafted in rev 1, `updateProjectCommunication`
(`:249-329`) had no clamp guarding it at all. Verified against the live code: a prompt-injected
agent, via `updateProjectCommunicationFromAgent` (called from the raw REST route,
`src/app/api/agent/projects/[id]/communications/route.ts:39-44`, whose `PATCH` forwards
`await request.json()` straight through with no schema validation, same as the create route) or via
`studio_update_communication`, can rewrite `body` (`project-communications.ts:260-261, 295`) on an
existing booking-linked note outright, and can flip `status` too — the sms/email send-state clamp at
`:270-275` only narrows `channel === "sms" || channel === "email"`; `note` sails through untouched,
exactly as D3 already documents for `note` in general. `booking_id` itself is never in the update's
field set, so it persists unchanged through the rewrite. Result: a row that still carries the
authority marker ("this is what Tyler decided on that call") but whose actual content an agent just
forged — the precise false-authority scenario D3 exists to prevent, and **new** surface, since no
booking-linked row could exist before this phase.

Fix: one guard, mirroring the create clamp's placement — at the top of `updateProjectCommunication`,
immediately after the row lookup/existence check and before any field is resolved:

```ts
const communication = await db.query.projectCommunications.findFirst({ /* ...unchanged... */ });
if (!communication) throw new Error("Communication not found.");
if (actor.actorType === "agent" && communication.bookingId) {
  throw new Error("Agents cannot modify a booking-linked meeting note.");
}
```

This rejects the entire update for an agent actor on any row with a non-null `bookingId` — not just
`body`/`status` — because there is no legitimate agent-authored change to a row whose whole point is
"Tyler took this note on this call." It throws (rather than silently no-op-ing) so the agent surface
gets an explicit, loud refusal instead of an update that appears to succeed but changed nothing —
consistent with `requireProjectSourceForTask`/`requireBookingBelongsToProject`'s throw-on-invalid
convention elsewhere in this file. Non-agent actors (admin form, sequence runner) are unaffected; an
agent updating a plain, unlinked note is unaffected — this narrows nothing beyond the exact gap D3
already scoped in ("any agent can write/re-status a plain note" stays the pre-existing, out-of-scope
condition, unchanged). This keeps the blast radius to exactly one new field on exactly one existing
function for create (`createProjectCommunication`, D3) plus exactly one new guard clause on exactly
one existing function for update (`updateProjectCommunication`) — its two callers
(`updateProjectCommunicationFromForm`, the admin path; `updateProjectCommunicationFromAgent`) get
**zero changes**, since the guard lives in the shared core, same placement discipline D3 already
established.

**D5 — The "structured template" is UI scaffolding text, not new schema.** The task explicitly
prefers this over a schema-per-field design. The new "Meeting note" composer's body `<textarea>`
ships with a `defaultValue` of:

```
Discussed:


Decisions:


Follow-ups:

```

Tyler free-edits this like any other note body before saving — no client JS, no parsing, no
structured storage. This is the same "cheapest that genuinely serves" call the roadmap line invites;
a per-section schema would need a new table (rejected by D1) or three new nullable columns plus
UI/agent-clamp work tripled for no functional gain over free text Tyler is going to write in
sentences anyway.

**D6 — Reuse Phase 22's already-existing, already-flag-gated `bookings` query — don't add a second
one.** `getProject` (`src/lib/crm.ts:563-575`) already loads this project's `scheduler_bookings`
joined to `scheduler_meeting_types` for the meeting name, gated behind
`PROJECT_PROGRESS_TIMELINE === "1"` (Phase 22's own flag-off-purity guarantee). The shape it returns
— `{ id, startAt, status, meetingName }` — is exactly what a "which meeting is this note about"
picker needs. Rather than a second, near-duplicate query, this phase widens the existing gate:

```ts
const bookings = process.env.PROJECT_PROGRESS_TIMELINE === "1" || process.env.MEETING_NOTES_ENABLED === "1"
  ? await db.select({ ... }).from(schedulerBookings)... // unchanged query body
  : [];
```

Both flags off ⇒ the ternary is still false ⇒ zero added queries, identical to today. Either flag
alone on ⇒ the query runs once (not twice), independent of the other — same "independent flags"
discipline the Phase 17 spec used for `PROJECTS_BOARD_VIEW` / `PROJECT_PROGRESS_TIMELINE`
(`docs/specs/phase-17-kanban-pipeline-board.md` D2). The same `data.bookings` array is also reused,
unchanged, to label a booking-linked note in the Communications feed (a `Map<bookingId,
{startAt, meetingName}>` built once per render) — no lookup query for that either.

The query itself (`crm.ts:563-575`) stays exactly as Phase 22 wrote it — **unfiltered by
`status`** — because Phase 22's own timeline logic already consumes cancelled bookings
deliberately (`project-milestones.test.ts:411` asserts a `status: "cancelled"` booking still feeds
milestone computation); filtering `status` at the query level would regress that. The linkable-note
picker's own filtering is handled downstream, in D9, not here.

**D7 — A meeting note requires an already-linked project; the booking page's existing linkage forms
are the prerequisite, not a new one.** `scheduler_bookings.projectId` is nullable
(`schema.ts:171`); `project_communications.projectId` is `NOT NULL` (`schema.ts:380`). When
`data.project` is `null` on the booking detail page, the new "Meeting notes" section renders a
one-line hint ("Link this booking to a project to add meeting notes") instead of a compose form —
the page already has both "Link to existing project" and "Create project from booking" forms
immediately below (`scheduler/bookings/[id]/page.tsx:187-215`) that get the booking to a state where
notes become available on the next render. No new linkage mechanism is introduced.

**D8 — Meeting notes use `direction: "internal"`, not the generic composer's hardcoded
`"outbound"`.** The existing "Draft communication" composer always hardcodes `direction="outbound"`
for every channel it creates (`projects/[id]/page.tsx:1189`, a fixed hidden input, not a choice) —
a leftover of that form being email/SMS-first. A meeting note is not communication to or from the
client; it's an internal record of a call. `"internal"` is already a canonical `direction` value
(migration `0060` line 4, `communicationDirections` in `project-communications.ts:18`). The new
Meeting note composer hardcodes `direction="internal"` in its own hidden input — a small, deliberate,
correct default for this one new code path; it does not change the generic composer's existing
behavior for any other channel.

**D9 — Two separate composers, not one conditionally-rendered form.** The existing generic "Draft
communication" form (email/SMS/call/note, `projects/[id]/page.tsx:1148-1237`) is left **completely
untouched** — it still creates plain, unlinked notes exactly as it does today (useful for a quick
note that isn't about any particular call). A second, small, purpose-built "Meeting note" composer
is added alongside it: hardcoded `channel="note"`/`direction="internal"`, a booking `<select>`
(from `data.bookings`, D6) instead of the four-channel picker, and the D5 template pre-fill. Two
narrow forms are simpler to build, read, and test than one form whose fields change meaning based on
a client-side channel selection (which this mostly-server-rendered page has no JS wiring for today).

**The picker's options exclude cancelled bookings.** `data.bookings` (D6, `crm.ts:563-575`) is
unfiltered by `status` — deliberately, since Phase 22's timeline needs cancelled rows too. Left
as-is, the "which meeting is this note about" `<select>` would list a cancelled (or
rescheduled-away, which this codebase also marks `status: "cancelled"` — `scheduler.ts:974-990`)
consult as a linkable meeting, which reads wrong: there's no real call to attach a note to. Fix:
the composer builds its `<option>` list from `data.bookings.filter((b) => b.status !== "cancelled")`
— a presentation-layer filter local to this one picker, not a change to `data.bookings` itself (which
stays whole for Phase 22's timeline and for the D6 badge-labeling map, so a note already linked to a
booking that was *later* cancelled still renders its "Meeting: ..." badge correctly). If the
filtered list is empty, the composer hides exactly as it already does for zero bookings (§2, no
change to that rule).

**D10 — Saving a *new* booking-linked note redirects back to the booking; editing an existing row
always stays wherever it was (unchanged, byte-for-byte).**
`/api/projects/[id]/communications` (`route.ts`) always 303-redirects to `/projects/${id}` today
(`redirectToProject`, `route.ts:6-8`) — discarding the created/updated row's return value entirely
(`route.ts:33, 56` call `createProjectCommunicationFromForm`/`updateProjectCommunicationFromForm`
and never capture the result). Reused as-is for a booking-page compose form, this would silently
bounce Tyler off the booking page onto the project page after saving a meeting note — confusing,
since he came from and expects to stay near the booking.

**Scope check before the fix:** the only place a note is ever *created* with a `bookingId` is the
booking-page compose form (§2 — the project page's composer, D9, never sets `bookingId`, since a
project-page-authored note isn't tied to a specific meeting). But once a linked row exists, the
*project* page's Communications section still operates on it: the existing "Edit communication"
form (`projects/[id]/page.tsx:1381-1420`, posts `communicationId` through the same route) and the
"Log as sent (no send)" action (`:1294-1311`, same) both go through the **update** branch on that
row, from the project page, and both correctly expect to stay on the project page afterward. If the
redirect branched on `communication.bookingId` after every save (rev-1's draft), editing or
"logging as sent" an existing booking-linked note from the project page would incorrectly bounce
Tyler onto the booking page — the exact confusion D10 exists to avoid, just relocated. The booking
detail page (§2) never has an edit/log-sent form in v1 (D4: no relink, no edit path) — only its
create-a-note compose form — so the update branch never needs the booking-redirect behavior at all.

Fix, entirely server-side (no new query param, no open-redirect surface), **scoped to the create
branch only**:

```ts
// POST, create branch (no communicationId in the form):
const communication = await createProjectCommunicationFromForm(id, formData); // capture the result
if (communication.bookingId) {
  revalidatePath(`/scheduler/bookings/${communication.bookingId}`); // booking page must show the new note
  revalidateProject(id); // unchanged: the project page's feed also shows it
  return NextResponse.redirect(new URL(`/scheduler/bookings/${communication.bookingId}?saved=communication`, request.url), 303);
}
revalidateProject(id);
return redirectToProject(request, id); // unchanged today's target

// POST update branch (communicationId present) and PATCH: unchanged — always
// revalidateProject(id) + redirectToProject(request, id), regardless of the
// updated row's bookingId. Editing/logging-as-sent an existing row is always
// initiated from the project page and must always return to the project page.
```

The redirect target is derived from the row the server itself just wrote — never from client input
— so there is no new redirect-target injection surface. Every existing caller of the **update**
branch (email/SMS/call/plain-note edits, and now booking-linked-note edits/log-as-sent) is
unaffected byte-for-byte: it always redirects to the project, exactly as today. Only the **create**
branch's behavior changes, and only for a row whose `bookingId` is non-null — which, pre-Phase-20,
could never happen (every existing caller's created rows have `bookingId: null`), so this remains a
strictly additive change to the create path with zero effect on any existing flow. `revalidateProject`
(`route.ts:10-18`) only ever revalidates `/projects/{id}`; the added `revalidatePath` call for the
booking page ensures the booking detail page (which now also renders this booking's notes, §2)
reflects the just-created row immediately rather than serving a stale cache on first load.

## 2. Where it surfaces

- **Project detail page** (`/projects/[id]`, Communications section, `projects/[id]/page.tsx:1136-
  1457`), behind `MEETING_NOTES_ENABLED === "1"`:
  - A new "Meeting note" composer (D9), rendered only when the flag is on **and** at least one
    *non-cancelled* booking exists in `data.bookings` (D6) — nothing to link to otherwise. Fields:
    booking `<select>` (label `"{meetingName} · {formatDate(startAt)}"`, options from
    `data.bookings.filter((b) => b.status !== "cancelled")` ordered as returned, newest first), body
    `<textarea>` pre-filled per D5. Posts to the same `/api/projects/${data.project.id}/communications`
    route the generic composer already uses.
  - Each rendered communication row (existing loop, `page.tsx:1240-1450`) that carries a non-null
    `bookingId` gets one added line: `Meeting: {meetingName} · {formatDate(startAt)}` (from the D6
    map), linking to `/scheduler/bookings/{bookingId}` — placed alongside the existing "Source:"
    line (`page.tsx:1282-1284`), same visual treatment.
- **Booking detail page** (`/scheduler/bookings/[id]`, `scheduler/bookings/[id]/page.tsx`), behind
  the same flag: a new "Meeting notes" section (placed near "Client and project",
  `page.tsx:181-203`):
  - `data.project` present: lists this booking's notes (query added to
    `getSchedulerBookingDetail`, D-below) newest first, plus a compose form with `projectId` and
    `bookingId` pre-set as hidden fields (no picker needed — the booking is fixed) and the same D5
    template pre-fill.
  - `data.project` absent: the D7 hint, no compose form, no notes list (there cannot be any).
- **Agenda** (`src/lib/agenda.ts`): unchanged. No "has notes" indicator in v1 (§0, §5).

`src/lib/scheduler.ts`'s `getSchedulerBookingDetail` (`:1034-1046`) gets one additive query, gated
the same way: when `MEETING_NOTES_ENABLED === "1"`, also load
`project_communications` rows where `channel = "note"` and `bookingId` matches, ordered by
`createdAt desc`; when the flag is off, this key is simply omitted/empty, matching the page's
flag-off branch (mirrors the `getProject` `bookings` field precedent, D6).

## 3. Implementation shape

- **`migrations/0098_meeting_notes_booking_link.sql`** (new — confirm `0098` is still the free slot
  at build time per D1's caveat; renumber if Phase 18/19 have already claimed it) — D1's
  `ALTER TABLE` + index. Nothing else. Migration `0060`'s canon-guard triggers are **not** modified:
  `booking_id` is an opaque id reference written only by trusted server code (never raw
  operator-typed text), not free-form text
  prone to whitespace/casing mistakes the way `subject`/`recipient_name`/etc. are — the existing
  detail-text canon trigger's purpose doesn't meaningfully extend to it, and
  `requireBookingBelongsToProject` (D2) is a strictly stronger check than a trim/non-empty guard
  would be. A deliberate scope decision, not an oversight.
- **`src/db/schema.ts`**: add `bookingId: text("booking_id")` to `projectCommunications`
  (`schema.ts:378-404`) — no `.references()` (D2).
- **`src/lib/project-communications.ts`**:
  - `CreateProjectCommunicationInput` (`:58-71`): add `bookingId?: string | null`.
  - New `requireBookingBelongsToProject(projectId, bookingId)` (mirrors
    `requireProjectSourceForTask`, `agent-sources.ts:233-240` — same shape: look up, throw if
    missing or `projectId` mismatch, else return the row).
  - `createProjectCommunication` (`:172-247`): after resolving `channel`/`status` (existing lines
    190-208), resolve `bookingId = actor.actorType === "admin" ? cleanText(input.bookingId) : null`
    (D3's clamp — allowlist form, not `actorType === "agent" ? null : ...`, per B-5); when non-null,
    `await requireBookingBelongsToProject(projectId, bookingId)` before the insert (D2); include
    `bookingId` in the inserted row and in the `logActivity` metadata (`:236-243`) for auditability.
  - `createProjectCommunicationFromForm` (`:342-358`): thread `formString(formData, "bookingId")`
    through, same `cleanText` handling the function already applies to `sourceId`.
  - `createProjectCommunicationFromAgent` (`:331-333`) — unchanged function body; the clamp lives in
    the shared `createProjectCommunication` core, so it applies uniformly whether the caller is the
    admin form or the agent REST route.
  - `updateProjectCommunication` (`:249-329`): add the agent/booking-linked authority guard
    (`actor.actorType === "agent" && communication.bookingId` → throw) immediately after the
    existence check and before any field resolution (D4). `UpdateProjectCommunicationInput`,
    `updateProjectCommunicationFromForm`, and `updateProjectCommunicationFromAgent`
    (`:73-85, 360-380`) — **unchanged**; the guard lives entirely in the shared core.
- **`src/lib/crm.ts`**: widen the `getProject` bookings-query condition (`:563`) per D6.
- **`src/lib/scheduler.ts`**: extend `getSchedulerBookingDetail` (`:1034-1046`) to also load this
  booking's linked notes when the flag is on, per §2.
- **`src/app/api/projects/[id]/communications/route.ts`**: in the `POST` handler's **create**
  branch only (`:26-37`, no `communicationId` in the form), capture
  `createProjectCommunicationFromForm`'s return value and branch the redirect + add a
  `revalidatePath` for the booking page when `communication.bookingId` is set, per D10. The `POST`
  handler's **update** branch (`communicationId` present) and the `PATCH` handler (`:53-59`) are
  **unchanged** — always `revalidateProject` + `redirectToProject`, regardless of the row's
  `bookingId` (D10's scope-check).
- **`src/app/projects/[id]/page.tsx`**: add the "Meeting note" composer (D9) and the per-row
  "Meeting:" badge (§2) inside the existing Communications section. Both gated on
  `process.env.MEETING_NOTES_ENABLED === "1"` (same `process.env.X === "1"` convention as
  `PROJECT_PROGRESS_TIMELINE` at `crm.ts:563` and `EMAIL_SENDING_ENABLED` at
  `project-communications.ts:508`).
- **`src/app/scheduler/bookings/[id]/page.tsx`**: add the "Meeting notes" section (§2), same flag.
- **Flag**: `MEETING_NOTES_ENABLED === "1"` (this phase, new). Default unset/off ⇒ dark. Independent
  of `PROJECT_PROGRESS_TIMELINE` (D6's widened `||` condition is the only place the two flags
  interact, and only for the shared bookings-read, not for any UI).
- **No** new table, no new endpoint, no new MCP tool, no new dependency, no agenda change, no
  "create task from follow-up" button, no widening of the pre-existing (out-of-scope, flagged in D3)
  agent access to plain `note`-channel rows.

## 4. Tests

1. **Migration additive**: `0098` (or whatever the confirmed next-free slot is at build time, per
   D1) adds a nullable `booking_id` column + index; existing
   `project_communications` rows read back with `bookingId: null` unchanged.
2. **Canon guard unaffected**: inserting/updating rows with `booking_id` present or absent, and
   otherwise-canonical field combinations, still pass migration `0060`'s triggers unchanged (the new
   column isn't referenced by any trigger `WHEN` clause — a regression guard proving that).
3. **`requireBookingBelongsToProject`**: throws when the id doesn't exist; throws when the booking's
   `projectId` doesn't match the target project; returns the booking row when it matches.
4. **Linkage validation on create**: `createProjectCommunication` (studio/admin actor) with a
   `bookingId` for the *same* project stores `booking_id`; the identical call scoped to a
   *different* project's booking throws — no row written.
5. **Create-time clamp on `bookingId` is an allowlist**: `createProjectCommunicationFromAgent(projectId,
   { channel: "note", body, bookingId: "<a real booking that DOES belong to projectId>" })` stores
   `bookingId: null` regardless — proving the clamp fires even when the value would have validated,
   i.e. it's an actor-type gate, not a fallback from a failed lookup. A second case asserts the
   `system` actor (`createProjectCommunicationFromSystem`) with the same `bookingId` also stores
   `null` — proving the guard is written as `actorType === "admin" ? ... : null` (allowlist), not
   `actorType === "agent" ? null : ...` (denylist), so it doesn't silently widen for `system` or any
   future actor type (B-5). Mirrors the existing sms/email clamp test shape in
   `project-communications.test.ts`.
6. **MCP schema drift guard**: `studio_create_communication` / `studio_update_communication`'s
   `inputSchema.properties` do not include `bookingId` (`studio-mcp.ts:1151-1200`) — catches an
   accidental future addition without an explicit decision to revisit D3.
7. **Update-path immutability, and the agent authority guard on linked rows (D4)**: (a) calling
   `updateProjectCommunicationFromForm` / `updateProjectCommunicationFromAgent` with a `bookingId` in
   the form/JSON body has zero effect on an unlinked row — stored `booking_id` is unchanged (the
   update input type doesn't parse the field at all). (b) Calling
   `updateProjectCommunicationFromAgent` against an **existing booking-linked row** (non-null
   `booking_id`, created by the admin actor) with a changed `body` and/or `status` **throws**, and
   the stored row — `body`, `status`, every field — is asserted byte-for-byte unchanged afterward.
   (c) The identical call against the same row via `updateProjectCommunicationFromForm` (admin actor)
   succeeds normally, proving the guard is agent-specific, not a blanket lock on linked rows. (b) is
   the test the false-authority threat in D3/D4 requires: it proves an agent cannot rewrite the
   content of a genuinely Tyler-authored, booking-linked note, not merely that it can't touch the
   linkage field.
8. **`getProject` bookings-query gating matrix** (`crm.ts`): both flags off ⇒ `bookings: []` and the
   query is never issued (spy assertion); either flag alone on ⇒ the query runs exactly once, same
   rows Phase 22's own tests already assert.
9. **Project page flag-off purity**: `MEETING_NOTES_ENABLED` unset ⇒ no "Meeting note" composer, no
   per-row "Meeting:" badge, byte-identical markup to pre-Phase-20 (mirrors the Phase 17/22 flag-off
   test pattern).
10. **Project page composer, flag on + ≥1 non-cancelled booking**: the "Meeting note" form's fields
    are `channel=note`, `direction=internal`, `bookingId=<selected>`, and a body `defaultValue`
    containing the three scaffold headers ("Discussed:", "Decisions:", "Follow-ups:"). The `<select>`
    options come only from `data.bookings.filter((b) => b.status !== "cancelled")` — a fixture with a
    mix of `confirmed` and `cancelled` bookings asserts the cancelled one is absent from the options
    (B-4), while `data.bookings` itself (asserted separately) still contains it, unfiltered.
11. **Project page composer hidden with zero linkable bookings**: flag on but `data.bookings` empty,
    **or** every entry in `data.bookings` has `status === "cancelled"`, ⇒ no "Meeting note" composer
    rendered (nothing to link to).
12. **Booking-linked badge rendering**: a communication row with a non-null `bookingId` renders
    "Meeting: {meetingName} · {date}" linking to `/scheduler/bookings/{bookingId}`, sourced from the
    already-loaded `data.bookings` map — no additional query fired for the render.
13. **Booking detail page flag-off purity**: `MEETING_NOTES_ENABLED` unset ⇒ no "Meeting notes"
    section; `getSchedulerBookingDetail` issues only its pre-Phase-20 queries (no notes query spy
    hit).
14. **Booking detail page, flag on, unlinked booking** (`data.project` null): renders the D7 hint,
    no compose form, no notes list.
15. **Booking detail page, flag on, linked booking**: lists this booking's notes newest-first; the
    compose form posts `projectId`/`bookingId` pre-set from page data (no picker) plus the D5
    template.
16. **Redirect-after-save routing, create branch only (D10)**: **creating** a communication (`POST`,
    no `communicationId`) whose resulting row has a non-null `bookingId` redirects (303) to
    `/scheduler/bookings/{bookingId}?saved=communication` and calls `revalidatePath` for that booking
    path; a created row with `bookingId: null` redirects to `/projects/{id}?saved=communication`
    exactly as today — proving every existing (email/SMS/call/plain-note) create flow keeps its
    current redirect target byte-for-byte.
17. **Redirect-after-save routing, update branch is unaffected by `bookingId` (D10, B-3 regression
    guard)**: **updating** an existing communication — `POST` with `communicationId`, or `PATCH` —
    against a row whose `bookingId` is non-null (e.g. via the project page's "Edit communication"
    form or "Log as sent (no send)" action) still redirects to `/projects/{id}?saved=communication`,
    **not** to the booking page, proving the update branch never branches on `bookingId`. Without
    this test, an implementation that naively reused the create branch's logic for updates too would
    silently bounce an in-progress project-page edit onto the booking page.
18. **Booking-linked badge survives a later cancellation (B-4)**: a note whose `bookingId` points at
    a booking that is `status: "cancelled"` (cancelled *after* the note was linked) still renders its
    "Meeting: {meetingName} · {date}" badge — proving the cancelled-exclusion filter (test 10) is
    scoped to the composer's picker options only, not to `data.bookings`/the badge-labeling map.

Gate: `npm run lint` exit 0; `npm run build` exit 0; `npm test` all pass.

## 5. Rollout

Dark behind `MEETING_NOTES_ENABLED`. Enable = set the var (no migration-ordering constraint beyond
the usual "apply `0098` (build-time-confirmed number, D1) before or with the deploy that reads
`booking_id`" — the column is never read on an always-on path, so unlike `0087`/`0089` this is not
deploy-order-critical). Rollback =
unset — the composer/section disappear, any `booking_id` values already written stay in the table
(harmless, additive, matches this repo's standard "no down-migration" convention for purely additive
columns).

**Explicitly deferred (future CRs, not v1):**
- Agenda "has notes" indicator on today's-calls entries — needs its own batched, flag-gated
  per-booking lookup on an always-on read path (`agenda.ts`); disproportionate to a feature Tyler
  asked for only "optionally," for the lowest-risk item in the batch.
- "Create task from follow-up" button wiring a note's follow-ups text into `agent_tasks`
  (`schema.ts:328-346`) — free text for now.
- Re-linking an existing note to a different booking (D4) — create a new note instead.
- Closing the pre-existing, out-of-scope gap that any agent can write/re-status any plain,
  **unlinked** `note`-channel row today (D3) — a generic-notes concern, not introduced or worsened
  by this phase, flagged here for visibility rather than silently left undocumented. Narrowed by
  D4's rev-2 fix: this deferred gap now applies only to notes with `bookingId: null` — a
  booking-linked row is protected from agent rewrites end-to-end (create clamp, D3; update guard,
  D4).

## 6. Changelog

### Rev 2 (Fable spec review) — 2026-07-07

**Verdict: APPROVE WITH CHANGES.** All five findings below were verified against the cited code
before being folded in (the update-path clamp gap, the migration-number tail, the redirect/revalidate
behavior, the bookings-query filter, and the actor-type clamp shape). None required loosening the
rev-1 hard scope guarantees (§3) — no new table, endpoint, MCP tool, or dependency was needed for any
fix. Verified-correct by the reviewer and deliberately left unchanged: canon triggers cleanly accept
the note insert; `note` rows are already agent-writable in any status today (the runtime clamp is the
boundary, not the schema — D3); the FK-via-helper convention (D2); D6's flag-off purity; D10's "no
open-redirect" property; the nullable-`projectId` premise (D7); "no new table/endpoint/MCP tool" (§3).

| # | Severity | Finding | Fix (this rev) |
|---|---|---|---|
| B-1 | MAJOR | The false-authority threat D3 defines survives via the untouched update path: `updateProjectCommunication` had no clamp for `note` rows, so an agent (via `studio_update_communication` or the raw agent REST route) could rewrite `body`/`status` of an *existing*, genuinely Tyler-authored booking-linked note while `booking_id` (the authority marker) persisted — new surface, since no booking-linked rows could exist before this phase. Rev-1 Test 7 only proved `booking_id` immutability, not that content itself was protected. | D4 rewritten: `updateProjectCommunication` gets one guard, mirroring the create clamp's placement — `actor.actorType === "agent" && communication.bookingId` → throw, checked immediately after the row lookup, before any field resolution. Blocks the whole write (not just `body`/`status`) for an agent on any linked row; non-agent actors and agent updates to unlinked notes are unaffected. `updateProjectCommunicationFromForm`/`FromAgent` themselves stay unchanged — the guard lives in the shared core. Test 7 expanded (§4) to assert an agent update to an existing linked row's `body`/`status` throws and the row is unchanged byte-for-byte. |
| B-2 | MEDIUM | Migration number collision: Phases 18, 19, and 20 all claimed `0096` off the same `0095` tail. | D1 resolves by build order: 18 → `0096`, 19 → `0097`, this phase → `0098`. Every migration-number reference in this spec updated to `0098`. Added a mandatory build-time caveat: grep `migrations/` for the actual tail before writing the file and renumber if `0098` is no longer free — the number is a placeholder for "next free slot as of build time," not a hard-coded requirement. |
| B-3 | MINOR | D10's "every existing caller unaffected byte-for-byte" broke once linkage exists: the project page's "Edit communication" form and "Log as sent (no send)" action both operate on a booking-linked row through the same **update** branch, and rev-1's redirect logic (branch on `communication.bookingId` after *any* save) would have bounced those in-progress project-page edits onto the booking page. Also, `revalidateProject` never revalidated the booking detail page. | D10 rewritten: the booking-redirect branch (and its new `revalidatePath` call for the booking page) is scoped to the **create** branch only; the update branch (`POST` with `communicationId`, and `PATCH`) is unchanged — always redirects to the project, regardless of the row's `bookingId`, since editing/logging-as-sent an existing row is always initiated from, and must return to, the project page. Test 16 narrowed to the create branch; new Test 17 added as an explicit regression guard for the update-branch behavior. |
| B-4 | MINOR | The booking picker (`data.bookings`, `crm.ts:563-575`) is unfiltered by `status`, so cancelled (and rescheduled-away, which this schema also marks `cancelled`) consults would appear as linkable meetings in the "Meeting note" composer. | D9 adds a presentation-layer filter local to the composer's `<select>`: `data.bookings.filter((b) => b.status !== "cancelled")`. `data.bookings` itself stays unfiltered (D6, unchanged) since Phase 22's timeline and this phase's badge-labeling map both need cancelled rows too. Test 10 updated to assert cancelled bookings are excluded from picker options; Test 11 updated for the all-cancelled case; new Test 18 guards that a note linked to a since-cancelled booking still renders its badge. |
| B-5 | MINOR | The create-time clamp (`actor.actorType === "agent" ? null : cleanText(...)`) is a denylist: it passes `bookingId` through for `system` and any future `CommunicationActor.actorType` (the type already lists `"client"`), so it can silently widen as actor types are added. | D3's clamp rewritten as an allowlist: `actor.actorType === "admin" ? cleanText(input.bookingId) : null`. Only the admin form legitimately sets `bookingId`, so the clamp names that one case instead of excluding the one case it happens to know about. Test 5 expanded to assert the `system` actor also gets `bookingId: null`, proving the guard can't rot as new actor types are added. |

No findings were disagreed with or dropped — all five are folded in as specified above.

### Rev 1 (initial spec) — 2026-07-07
First draft, not yet reviewed. Awaiting Fable adversarial spec review before build; findings will be
folded in as Rev 2 here, in the same format as `phase-22-project-progress-timeline.md` §6 and
`phase-17-kanban-pipeline-board.md` §6.
