# Phase 22 — Project progress / milestone timeline (CR-1)

Status: spec (build-ready pending Fable review). Origin: Tyler's CR-1 (2026-07-07).
Risk class: LOW — read-only projection; no canonical writes; no money; no new endpoints.

## 0. What Tyler asked for

A progress bar on the projects page showing lifecycle stages that "automates based on the date":
inquiry, retainer paid, engagement-session planning, e-session delivery, wedding planning,
vision & timeline call, final payment made, week-of, wedding day, sneak-peek delivery,
full-gallery delivery, anniversary gift. He is open to refinement.

## 1. Design decisions (the two that matter)

**D1 — Derive at read time; never mutate `stage`.** The bar is a pure function
`computeProjectMilestones(input, today)` over existing canonical data (stage, typed project
events, proposals, invoices/payments, delivered galleries). NO cron, NO writes, NO parallel
stage system. The canonical `projects.stage` pipeline (inquiry → … → completed) stays the only
written state; the timeline is a richer *display* projection layered on top. This makes the
feature zero-risk, always consistent with reality, and trivially dark-shippable.

**D2 — Dates mark milestones *due*; data marks them *done*.** A date-only "automation" that
flips "e-session delivered" just because the date passed would lie. Rules:
- A **data milestone** (retainer paid, final payment, gallery delivered) is `done` only when the
  canonical fact exists.
- A **date milestone** (week-of, wedding day, anniversary) is `done` when the date passes — these
  are purely temporal, nothing can be "missing."
- A **hybrid milestone** (e-session delivery, sneak peek, full gallery — things with an expected
  date AND a data fact) becomes **`overdue`** (amber) when its date passes without the data —
  the bar doubles as a what's-late signal. It is `done` only on data.

## 2. Milestone catalog

### Wedding track (`project.type === "wedding"`, or any project with a wedding event)

| # | Key | Label | Kind | done when | due/overdue when |
|---|---|---|---|---|---|
| 1 | inquiry | Inquiry | data | always (project exists); date = createdAt | — |
| 2 | proposal | Proposal sent | data | stage ≥ proposal_sent OR a proposal row sent/accepted | n/a if stage skipped past it (render done) |
| 3 | booked | Booked (retainer paid) | data | stage ≥ retainer_paid OR a retainer payment row paid | — |
| 4 | esession | Engagement session | hybrid | its event date passed | due = the engagement/e-session event date; `n/a` (skipped, hidden) when no such event exists |
| 5 | esession_delivery | E-session gallery | hybrid | a delivered gallery exists dated/created before the wedding date (or any delivered gallery when no wedding date) | overdue when esession date + `ESESSION_DELIVERY_DAYS` (default 21) passed with no qualifying gallery; `n/a` when no e-session event |
| 6 | vision_call | Vision & timeline call | hybrid | its event date passed | due = an event whose type/title matches consult/vision/timeline/planning call; `n/a` when none |
| 7 | final_payment | Final payment | data | every non-draft invoice for the project has status `paid` (equivalently: zero client-payable balance across non-draft invoices) | overdue when the latest payment due date passed unpaid |
| 8 | week_of | Week of wedding | date | today ≥ weddingDate − 7 days | — |
| 9 | wedding_day | Wedding day | date | today ≥ weddingDate | — |
| 10 | sneak_peek | Sneak peek delivered | hybrid | first delivered gallery dated on/after weddingDate | overdue when weddingDate + `SNEAK_PEEK_DAYS` (default 7) passed without one |
| 11 | full_gallery | Full gallery delivered | hybrid | ≥ 2 delivered galleries on/after weddingDate, OR 1 delivered gallery on/after weddingDate + sneak-peek window elapsed (so a single "full gallery only" delivery still completes both 10 and 11), OR stage ≥ delivered | overdue when weddingDate + `FULL_GALLERY_DAYS` (default 56 ≈ 8 weeks) passed without |
| 12 | anniversary | Anniversary | date | today ≥ weddingDate + 1 year (render as an upcoming touchpoint until then, with the date shown) | — |

"Wedding planning" from Tyler's list is the **span** between `booked` and `week_of`, not a point —
the bar's current-position indicator sitting in that span communicates it. The gallery-count
heuristics for sneak-peek vs full are deliberately simple (the schema has no gallery `kind`
column); thresholds are module constants so they're easy to tune. A milestone whose prerequisite
data can't exist yet is `upcoming`; the first non-done, non-n/a milestone is `current`.

**Wedding date** = the project's wedding event (`type === "wedding"` or title "wedding day" —
the same predicate `crm.ts` already uses at ~line 2315), falling back to `project.eventDate`.
No wedding date ⇒ date/hybrid milestones that need it render `upcoming` with no date (never
overdue — can't be late against an unknown date).

### Generic track (all other project types)

inquiry → proposal → booked → session day (project.eventDate) → gallery delivered → completed
(stage `completed` or delivered+paid). Same D2 semantics.

### Statuses

`done | current | upcoming | overdue | n/a`. Exactly one `current` (the first actionable
non-done); `n/a` milestones are omitted from rendering entirely (no dead segments).

## 3. Implementation shape

- **`src/lib/project-milestones.ts`** — pure module, no DB imports:
  `computeProjectMilestones(input: MilestoneInput, today: Date): ProjectMilestone[]` +
  `milestoneSummary(list)` (done/total + current label, for the compact bar). `MilestoneInput` is
  a narrow typed subset (stage, type, createdAt, eventDate, events[{type,title,eventDate}],
  proposals[{status}], invoices[{status,clientPayableBalanceCents,dueDate?}], galleries
  [{status,deliveredAt,createdAt}]) assembled by callers from data they ALREADY load. Date
  comparisons are calendar-date (string `YYYY-MM-DD` compare against today in
  `America/New_York`), matching how event dates are stored.
- **Project detail (`/projects/:id`)**: full horizontal milestone strip near the top —
  done=filled, current=ring/highlight, upcoming=muted, overdue=amber with the expected date.
  Data comes from the existing `getProject()` result (already loads events, proposals, invoices
  + balances, galleries — zero new queries). Payments detail beyond invoice status/balance is NOT
  needed (final_payment uses invoice status/balance).
- **Projects list (`/projects`)**: compact per-row bar (done/total segments + current-milestone
  label; overdue tints the bar amber). **No N+1**: one batched `inArray` query per table
  (events, invoices, galleries — proposals only if the list doesn't already load them) over the
  visible page of project ids, mirroring how the page batches today. If the list page's current
  loader makes this awkward, ship detail-page first and put the list bar behind the same flag as
  a fast follow — do not regress list-page query count.
- **Flag**: `PROJECT_PROGRESS_TIMELINE` — strict `=== "1"`, read in the component body
  (three-state pattern). Off ⇒ pages render exactly as today.
- **No** new endpoints, no schema change, no agent/MCP surface, no writes anywhere.

## 4. Tests (tsx, pure — no DB needed for the compute module)

1. Wedding golden path: booked+paid+galleries fixture walks every milestone to done as `today`
   advances (pass `today` explicitly; no `Date.now()` reliance in assertions).
2. D2 overdue: wedding date + 10d, no post-wedding gallery ⇒ sneak_peek `overdue`, full_gallery
   `upcoming`/`overdue` per threshold; adding a delivered gallery flips sneak_peek done.
3. Single-delivery collapse: one delivered gallery after wedding + windows elapsed ⇒ both
   sneak_peek and full_gallery done (no phantom overdue).
4. n/a skipping: no engagement event ⇒ esession + esession_delivery omitted; exactly one
   `current` at all times across fixtures.
5. No wedding date ⇒ nothing overdue; date milestones upcoming, undated.
6. final_payment: unpaid non-draft invoice ⇒ not done; all paid ⇒ done; draft-only invoices ⇒
   upcoming (not done — nothing owed yet is not "final payment made").
7. Generic track for a non-wedding project.
8. Purity guard: module imports no DB/client modules (assert via a small import-graph check or
   keep it enforced by the module having zero imports beyond types).

Gate: `npm run lint` exit 0; `npm run build` EXIT=0; `npm test` all pass.

## 5. Rollout

Dark behind `PROJECT_PROGRESS_TIMELINE`. Enable = Tyler sets the var; instant rollback = unset.
No migration, no deploy ordering constraints. Future (separate CRs if wanted): per-project
overrides (custom expected dates), anniversary reminder automation (that one WRITES — would go
through the sequences engine + its guards, not this read-only layer).
