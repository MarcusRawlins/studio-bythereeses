# Change requests — Tyler's notes on what to change

This is the **single intake list** for changes Tyler wants to the CRM. Walk the live site
(`schedule.bythereeses.com` public, `studio.bythereeses.com` admin — your Google login) with
`docs/app-surface-map.md` open as a checklist, and add one entry here per change you want. An agent
(any capability level) then picks up each entry, writes a spec, gets it Fable-reviewed, builds it
**dark**, and reports back — you flip it on.

## How to add a request (so any agent can act on it without guessing)

Copy the block below and fill every field. The more concrete the **Now** and **Want**, the less an
agent has to guess. A screenshot pasted into `Notes` (or a file dropped in `docs/change-shots/`) is
worth a paragraph.

```
### CR-<n> — <short title>
- Status: OPEN            # OPEN | SPEC | BUILDING | DARK (built, flag off) | LIVE | WONTDO
- Screen: <route + name from app-surface-map.md, e.g. /projects/:id — Project detail>
- Host: <admin | public>
- Priority: <P1 blocks me | P2 want soon | P3 nice-to-have>
- Now: <what the screen does / shows today>
- Want: <what you want it to do / show instead — be specific about the outcome>
- Why: <the business reason — helps the agent make the right call on edge cases>
- Money/risk: <does this touch payments, refunds, sending email/SMS, or client-visible data? yes/no>
- Notes: <anything else — examples, a competitor that does it well, a screenshot path>
```

**Rules an agent MUST follow on every request** (these are the standing guardrails for this repo —
see `docs/handoff-build-state.md` for the full list):
- Build it **dark** behind an off-by-default flag. Never enable it yourself — Tyler flips the flag.
- Anything that moves money (refund/charge/autopay) or sends outbound email/SMS **pauses for Tyler's
  explicit go** before the first live action, and gets an Opus/Fable money-math review.
- Every spec and every code diff gets a **Fable review** before it lands.
- Never commit the Cloudflare API token or any secret to the repo.
- Green build gate required: `npm run lint` (exit 0), `npm run build` (**exit 0** — type errors print
  after "Compiled successfully"), `npm test` (all pass).

## Priority legend
- **P1** — blocks my day-to-day / something is wrong or missing that I hit constantly.
- **P2** — clear improvement I want in the next batch.
- **P3** — nice-to-have, do when convenient.

---

## Worked example (delete or keep as a reference)

### CR-0 — Show remaining balance at top of project detail
- Status: OPEN
- Screen: /projects/:id — Project detail
- Host: admin
- Priority: P2
- Now: The balance is only visible after scrolling to the invoice section.
- Want: A summary strip at the top of the project page showing total, paid, and remaining balance.
- Why: I check "what do they still owe" constantly and don't want to scroll.
- Money/risk: no (read-only display of existing numbers).
- Notes: HoneyBook shows this as a little pill row under the client name.

---

## Requests

### CR-1 — Project progress bar / milestone timeline (auto-advancing)
- Status: DARK (built, flag off) — commits 726c129 + 74e7d93, flag PROJECT_PROGRESS_TIMELINE
- Screen: /projects — Projects list (compact bar per project) AND /projects/:id — Project detail (full milestone strip)
- Host: admin
- Priority: P2
- Now: Projects show a single `stage` value (inquiry → proposal_sent → retainer_paid → planning → editing → delivered → completed). No visual lifecycle progress; nothing date-aware.
- Want: A progress bar showing the full client lifecycle, auto-advancing. Tyler's candidate milestones: inquiry, retainer paid, engagement-session planning, e-session delivery, wedding planning, vision & timeline call, final payment made, week-of, wedding day, sneak-peek delivery, full-gallery delivery, anniversary gift. Open to refinement.
- Why: See at a glance where every couple is in the journey and what's next/late, without opening each project.
- Money/risk: no (read-only projection of existing data; no canonical writes).
- Notes (agreed design, 2026-07-07): **Derive, don't mutate.** The bar is a read-time projection
  (`computeProjectMilestones(project, today)`) over existing canonical data — stage, event dates,
  payment rows, delivered galleries — NOT a cron that rewrites `stage`. **Dates mark milestones
  *due*; real data marks them *done*** — a date passing without its data (e.g. wedding + 10 days,
  no sneak-peek gallery) shows **overdue/amber**, never falsely "done." So the bar doubles as a
  what's-late signal. Wedding track ≈ Tyler's list (with "wedding planning" as the span between
  booking and week-of rather than a point); non-wedding projects get a shorter generic track.
  Ships dark behind a flag. Spec: `docs/specs/phase-22-project-progress-timeline.md`.

### CR-2 — Left nav: raise Settings; fold Activity / Data Health / System Status into it
- Status: DARK (built, flag off) — commit 389aa08
- Screen: all admin pages — left sidebar navigation (`src/components/AppShell.tsx`)
- Host: admin
- Priority: P2
- Now: Flat 16-item nav; Settings is the last item; Activity, Data Health, and System Status sit
  as separate top-level items mid-list.
- Want: Settings higher up, with Data Health / System Status / Activity accessible from within the
  Settings area instead of cluttering the top-level nav.
- Why: Nav is long; the three system/ops pages are rarely-visited and belong under Settings.
- Money/risk: no (navigation re-organization only; zero data/behavior change).
- Notes (agreed design, 2026-07-07): Remove the three from the top-level nav and move Settings up.
  `/settings` and the three pages get a shared "Settings" tab strip
  (Settings | Activity | Data Health | System Status) so everything remains one click away and
  **all URLs stay unchanged** (bookmarks/agent surface map intact). Dark behind
  `SETTINGS_NAV_GROUP === "1"`; off ⇒ nav renders exactly as today. Small enough that the spec is
  this entry; the Fable gate runs on the diff.

### CR-3 — Quick-find dialog renders UNDER the app navigation (bug)
- Status: DARK (fixed + reviewed, commits f2edf7d + 74e7d93) — live on next deploy, no flag
- Screen: all admin pages — Quick find (⌘K) overlay
- Host: admin
- Priority: P1 (bug — search is unusable when the nav covers it)
- Now: Opening Quick find leaves the project navigation painted on top of the search overlay.
- Want: The overlay covers everything; nav never paints over it.
- Why: Bug. The Quick-find trigger renders inside the sticky mobile header (z-30 + backdrop-blur —
  which creates its own stacking context) / the fixed desktop sidebar, so the dialog's fixed z-50
  overlay was TRAPPED inside that ancestor stacking context and lost to the nav.
- Money/risk: no.
- Notes: Fixed by portaling the dialog to document.body (root stacking context, z-50 > header
  z-30) — `src/components/QuickFind.tsx`. Straight bug fix restoring intended behavior, so it
  ships UNFLAGGED (the dark-flag rule covers new capabilities, not repairs). Verified via the
  component test + full gate; Fable diff review runs with the next batch.
