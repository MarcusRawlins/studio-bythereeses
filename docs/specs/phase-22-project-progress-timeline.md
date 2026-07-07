# Phase 22 — Project progress / milestone timeline (CR-1)

Status: spec rev 2 (build-ready — Fable spec review findings folded in, see §6 changelog).
Origin: Tyler's CR-1 (2026-07-07). Risk class: LOW — read-only projection; no canonical writes;
no money; no new endpoints.

## 0. What Tyler asked for — and what v1 narrows (explicit, so he can veto)

A progress bar on the projects page showing lifecycle stages that "automates based on the date":
inquiry, retainer paid, engagement-session planning, e-session delivery, wedding planning,
vision & timeline call, final payment made, week-of, wedding day, sneak-peek delivery,
full-gallery delivery, anniversary gift. He is open to refinement.

v1 narrowings (deliberate, each reversible by a follow-up CR):
- **"Wedding planning"** renders as the *span* between `booked` and `week_of` (the current-position
  indicator sitting in it), not a checkable dot.
- **"Engagement-session planning"** is folded into the `esession` milestone (scheduled → happened),
  not a separate planning dot.
- **"Anniversary gift"** is a date touchpoint only (shows the date, flips on it). Automating a
  gift/email is a WRITE and belongs to the sequences engine — separate CR if wanted.
- **v1 ships the project-DETAIL strip first**; the compact list-page bar is part two of the same
  phase behind the same flag (see §3 — it has a real D1 constraint to engineer around, and the
  detail strip is the immediately-usable 90%).

## 1. Design decisions (the two that matter)

**D1 — Derive at read time; never mutate `stage`.** The bar is a pure function
`computeProjectMilestones(input, today)` over existing canonical data (stage, typed project
events, scheduler bookings, proposals, invoices + payment schedule rows, delivered galleries).
NO cron, NO writes, NO parallel stage system. The canonical `projects.stage` pipeline stays the
only written state; the timeline is a richer *display* projection layered on top.

**D2 — Dates mark milestones *due*; data marks them *done*.** A date-only "automation" that
flips "e-session delivered" just because the date passed would lie. Rules:
- A **data milestone** (retainer paid, final payment, gallery delivered) is `done` only when the
  canonical fact exists.
- A **date milestone** (week-of, wedding day, anniversary) is `done` when the date passes.
- A **hybrid milestone** (e-session delivery, sneak peek, full gallery) becomes **`overdue`**
  (amber) when its expected date passes without the data — the bar doubles as a what's-late
  signal. It is `done` only on data.
- **Nothing is ever vacuously done.** A milestone whose prerequisite records don't exist yet
  (e.g. final payment on a project with no real invoice) is `upcoming`, not done (§2 row 7).

## 2. Milestone catalog

### Track selection

**Wedding track ⇔ `project.type === "wedding"` — the type alone decides.** (Rev 2: do NOT infer
from the presence of a wedding-typed event — `createProjectFromForm` inserts a `type:"wedding"`,
title "Wedding day" event for ANY project type whenever eventDate/venue is set (`crm.ts` ~979-994),
so event-presence would route family shoots onto the wedding track.) All other types get the
generic track.

**Wedding date resolution (rev 2):** `project.eventDate` is primary — it is the canonical,
agent-guarded wedding date ("Only Tyler can change the wedding date", `crm.ts` ~2287). Fallback:
the **max-dated** wedding-predicate event (`type === "wedding"` or title "wedding day", the
existing ~2315 predicate), **ignoring null-dated events**. No date from either ⇒ date/hybrid
milestones that need it render `upcoming`, undated, never overdue.

### Wedding track

| # | Key | Label | Kind | done when | due/overdue when |
|---|---|---|---|---|---|
| 1 | inquiry | Inquiry | data | always (project exists); date = createdAt | — |
| 2 | proposal | Proposal sent | data | stage ≥ proposal_sent OR a proposal row **accepted-or-signed-or-sent** (reuse the `proposalIsAcceptedOrSigned` semantics in `sales.ts` ~540 for the accepted predicate; a merely-sent proposal also counts as "sent") | renders done for projects imported directly at retainer_paid (stage ≥) — intended |
| 3 | booked | Booked (retainer paid) | data | stage ≥ retainer_paid OR a retainer payment row paid | — |
| 4 | esession | Engagement session | hybrid | its event date passed | due = the engagement-typed event's date. `n/a` (omitted) when no engagement event exists. **Undated engagement event (the `ensureEngagementPlaceholder` rows, `crm.ts` ~800-837) ⇒ `upcoming`, undated, never overdue** (rev 2) |
| 5 | esession_delivery | E-session gallery | hybrid | a delivered gallery whose (title matches `/engagement|e.?session/i` OR normalized date < wedding date) exists | overdue when esession date + `ESESSION_DELIVERY_DAYS` (21) passed without one; `n/a` when no engagement event; undated esession ⇒ never overdue |
| 6 | vision_call | Vision & timeline call | hybrid | a matching booking's start time passed | source = **scheduler bookings** (rev 2 — consult calls live in `schedulerBookings`, NOT projectEvents): a non-cancelled booking for the project whose meeting-type name or booking title matches `/vision|timeline|planning|consult/i`. `n/a` when none |
| 7 | final_payment | Final payment | data | **≥ 1 invoice with status ∉ {draft, void} exists AND every such invoice is `paid`** (equivalently zero client-payable balance across non-draft, non-void invoices). Zero invoices, draft-only, or void-only ⇒ `upcoming` — never vacuously done (rev 2, B1: HoneyBook imports create retainer_paid projects with zero invoice rows; `void` never becomes paid and must not block forever) | overdue when any unpaid, non-void **payment schedule row**'s `dueDate` passed (`invoicePayments.dueDate` — rev 2, M3: `invoices.dueDate` is optional/rarely set; the schedule rows are the real due dates) |
| 8 | week_of | Week of wedding | date | today ≥ weddingDate − 7 days | — |
| 9 | wedding_day | Wedding day | date | today ≥ weddingDate | — |
| 10 | sneak_peek | Sneak peek delivered | hybrid | first delivered non-e-session gallery (title NOT matching the e-session regex) with normalized date ≥ weddingDate | overdue when weddingDate + `SNEAK_PEEK_DAYS` (7) passed without one |
| 11 | full_gallery | Full gallery delivered | hybrid | ≥ 2 qualifying post-wedding galleries, OR 1 qualifying gallery + sneak-peek window elapsed (single "full gallery only" delivery completes both 10 and 11), OR stage ≥ delivered | overdue when weddingDate + `FULL_GALLERY_DAYS` (56) passed without |
| 12 | anniversary | Anniversary | date | today ≥ weddingDate + 1 year (renders as an upcoming touchpoint with the date until then) | — |

Thresholds are module constants. Gallery "date" = `coalesce(deliveredAt, createdAt)` normalized
per §3 timezone rules (rev 2 — legacy delivered rows may have null `deliveredAt`).

### Generic track (all other project types)

inquiry → proposal → booked → session day (project.eventDate; the auto-created "Wedding day"
event on a non-wedding project is IGNORED for track/labels) → gallery delivered → completed
(stage `completed`, or delivered + final_payment done). Same D2 semantics, same final_payment
predicate as row 7.

### Statuses

`done | current | upcoming | overdue | n/a`. **At most one `current`** (rev 2 — a fully-finished
project has zero): the first non-done, non-n/a milestone. `n/a` milestones are omitted from
rendering entirely.

## 3. Implementation shape

- **`src/lib/project-milestones.ts`** — pure module (no DB imports; enforced by test):
  `computeProjectMilestones(input: MilestoneInput, today: Date): ProjectMilestone[]` +
  `milestoneSummary(list)`. `MilestoneInput` (rev 2 — widened per M2/M3):
  `{ stage, type, createdAt, eventDate, events[{type,title,eventDate}],
  bookings[{startAt,status,meetingName,title?}], proposals[{status}],
  invoices[{status,dueDate?}], payments[{invoiceId?,status,dueDate}] (schedule rows of non-void
  invoices), galleries[{status,title,deliveredAt,createdAt}] }`.
- **Timezone (rev 2, M4):** `eventDate` / payment `dueDate` are stored `YYYY-MM-DD` — compare as
  calendar strings. `deliveredAt` / `createdAt` / booking `startAt` are UTC ISO **datetimes** —
  normalize to a calendar date via the existing `dateKeyInTimeZone` (`src/lib/timezone.ts`,
  America/New_York default, already used by agenda) BEFORE any comparison. "Today" = the ET
  date key of `today`.
- **Project detail (`/projects/:id`) — v1 part one**: full horizontal milestone strip near the
  top — done=filled, current=ring, upcoming=muted, overdue=amber with the expected date.
  Data: the existing `getProject()` result **plus two small additive changes**: (a) return the
  invoice payment schedule rows it ALREADY loads internally (`paymentsByInvoice`, `crm.ts`
  ~452-455 — currently folded into balances and discarded) as `payments`; (b) one added query for
  the project's scheduler bookings (id/startAt/status/meeting name). Both additive — no existing
  consumer changes shape.
- **Projects list (`/projects`) — part two, same flag**: compact per-row bar (done/total +
  current label; overdue tints amber). **D1 HARD CONSTRAINT (rev 2, B2): D1 caps bound
  parameters at 100 per query; the list default is `pageSize = 200` (`projects/page.tsx` ~11), so
  a single `inArray(projectId, ids)` THROWS in production while passing local SQLite.** Batched
  fetches (events, invoices, payments, galleries, bookings) MUST chunk `inArray` at ≤ 90 ids per
  query (a small shared `chunkedInArray` helper). `listProjectIndex` batches nothing today — this
  is new load; keep it behind the flag and off the unflagged path entirely.
- **Flag**: `PROJECT_PROGRESS_TIMELINE` — strict `=== "1"`, read in the component body. Off ⇒
  pages render exactly as today (zero added queries on the unflagged path).
- **No** new endpoints, no schema change, no agent/MCP surface, no writes anywhere.

## 4. Tests (tsx; compute module tests are pure — no DB)

1. Wedding golden path: booked + paid + galleries fixture walks every milestone to done as an
   explicit `today` advances.
2. D2 overdue: wedding + 10d, no post-wedding gallery ⇒ sneak_peek `overdue`; adding a delivered
   gallery flips it done.
3. Single-delivery collapse: one qualifying gallery + windows elapsed ⇒ sneak_peek AND
   full_gallery done (no phantom overdue).
4. n/a + current: no engagement event ⇒ rows 4-5 omitted; **at most one** `current`; a
   fully-finished project (anniversary passed) has **zero** current.
5. No wedding date ⇒ nothing overdue; date milestones upcoming, undated.
6. **final_payment (rev 2, B1):** zero invoices (HoneyBook-import shape: stage retainer_paid, no
   invoice rows) ⇒ `upcoming`, NOT done; draft-only ⇒ upcoming; one void + one paid ⇒ done (void
   ignored); void-only ⇒ upcoming; unpaid non-draft ⇒ not done; schedule row dueDate passed
   unpaid ⇒ overdue.
7. Generic track: a family project WITH the auto-created wedding-titled event stays on the
   generic track (rev 2, M1).
8. **Timezone (rev 2, M4):** gallery `deliveredAt` 2026-06-13T01:30:00Z (= 9:30 pm ET June 12,
   the night before a June 13 wedding) does NOT count as the post-wedding sneak peek.
9. Undated engagement placeholder event ⇒ esession/esession_delivery `upcoming`, never overdue
   (rev 2, M7).
10. vision_call: matched non-cancelled booking before/after its startAt ⇒ upcoming/done;
    cancelled booking ⇒ n/a (rev 2, M2).
11. Purity guard: `project-milestones.ts` imports nothing beyond types/timezone helper (no DB).

Gate: `npm run lint` exit 0; `npm run build` EXIT=0; `npm test` all pass.

## 5. Rollout

Dark behind `PROJECT_PROGRESS_TIMELINE`. Enable = set the var; rollback = unset. No migration,
no deploy-ordering constraints. Future CRs: anniversary automation (writes → sequences engine),
per-project expected-date overrides, gallery `kind` column if the title heuristic proves noisy.

## 6. Changelog

### Rev 2 (Fable spec review) — 2026-07-07
Verdict REVISE folded in. B1: final_payment predicate rewritten (≥1 non-draft non-void invoice
required; void excluded; zero/draft/void-only ⇒ upcoming — was vacuously done for HoneyBook
imports with zero invoices). B2: D1 100-bound-param limit named; chunked `inArray` (≤90)
mandated; detail-first is the plan of record. M1: track = `project.type === "wedding"` only
(every project gets a wedding-typed event from the form — event-presence routing was wrong).
M2: vision_call sourced from scheduler bookings (one added query; was a dead milestone — consult
calls are not projectEvents). M3: final_payment overdue uses `invoicePayments.dueDate` schedule
rows; `getProject` returns the payment rows it already loads. M4: ISO-datetime fields normalized
via `dateKeyInTimeZone` before comparing (gallery-at-9pm-ET edge). M5: wedding date =
`project.eventDate` primary, max-dated wedding event fallback, null-dated ignored. M6: "at most
one current". M7: undated engagement placeholder ⇒ upcoming, never overdue. Minors: proposal
predicate reuses accepted-or-signed semantics; e-session title regex excluded from sneak/full
counts; `coalesce(deliveredAt, createdAt)`; v1 narrowings made explicit in §0.
