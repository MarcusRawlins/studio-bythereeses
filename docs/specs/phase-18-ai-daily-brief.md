# Phase 18 — AI daily brief

Status: spec (build-ready). No code in this document.
Scope owner: autonomous build loop. Enablement: **Tyler** (flag flip + narration Routine, if he wants it).

---

## 0. Why this exists (and what it is NOT)

Tyler's ask (roadmap): *"A rule-based daily 'what needs you' exists; add an AI-narrated daily
digest (priority leads to answer, overdue, upcoming shoots, stuck items) + optional push."*

The rule-based "what needs you" already exists as a **dashboard section**, not an email:
`src/app/page.tsx:164` renders `<h2>What needs you</h2>` fed by
`listDashboardActionItems(now, 8)` (`src/lib/dashboard.ts:156`, imported at `page.tsx:5`) plus
`getAgenda(...)` (`src/lib/agenda.ts:65`, imported at `page.tsx:3`, called `page.tsx:86`). Tyler
only sees it when he opens the app. This phase's entire job is: (a) put that same information —
plus overdue project milestones — in his **inbox** every morning, and (b) add a short AI-narrated
paragraph on top of the bullet list, without inventing a new AI vendor integration or blocking
the email on it.

**This is a convenience feature, not a security boundary.** It moves no money, and every signal
it surfaces is already visible to Tyler in the admin app today. Keep it lean.

**Hard scope guarantees (non-negotiable):**

1. **Zero new canonical queries.** Every signal reuses an existing, already-shipped read
   verbatim: `listDashboardActionItems`, `getAgenda`, `loadProjectMilestoneSummaries`. No new
   SQL joins over `projects`/`clients`/`invoices`/etc. are written for this phase.
2. **Zero canonical writes.** The brief reads; it writes at most one non-canonical row/day
   (the optional AI narration cache, §3.3) and the existing `job_runs` heartbeat. A guard test
   asserts this (mirrors `src/lib/observability-guard.test.ts`).
3. **The email always sends on schedule with or without AI narration.** The AI-narration step
   is best-effort and fully decoupled from the send path (§3.4) — it cannot delay, block, or
   fail the digest, because it was produced (or wasn't) hours earlier by an entirely separate
   process; the digest request only ever does a single cheap `SELECT ... WHERE day_key = ?`
   against it. **This guarantee is specifically about the AI-narration step, not the rule-based
   brief as a whole**: `computeDailyBrief` itself IS awaited synchronously inside the digest send
   request (§2.1), and with `PROJECT_PROGRESS_TIMELINE=1` it runs the paged `listProjectIndex`
   scan (§1.1a) plus `loadProjectMilestoneSummaries`'s chunked batch reads across every active
   project before `sendAdminAlertEmail` is called — that adds real, bounded latency to the digest
   cron request (bounded by the number of active projects / pagination round trips, not
   unbounded), it just cannot *fail* the send (§2.1's try/catch) or depend on any AI/agent process
   succeeding.
4. **No new AI vendor integration.** There is no direct LLM API call anywhere in this codebase
   today (verified — see §3.1). This phase does not add one. It reuses the exact mechanism
   Phase 10 already uses for "AI narrative": a read-only MCP/REST surface that an agent session
   consumes and narrates *outside* the CRM's own runtime.
5. **Push is out of scope.** The PWA has no service worker (`PWA_SERVICE_WORKER` deferred,
   `docs/specs/phase-15-pwa-mobile.md:18`) — web push requires a service worker
   (`PushManager.subscribe` needs a SW registration). This phase specs **email only**; push is
   revisited when Phase 15's SW ships.

---

## 1. Signal catalog (reuse, don't reinvent)

Three signal groups, all pure reads, all reused verbatim from shipped code:

| Signal group | Source (existing) | What it covers | Notes |
|---|---|---|---|
| Priority leads / stuck items / overdue payments | `listDashboardActionItems(now, limit)` — `src/lib/dashboard.ts:156-319` | Engagement sessions to schedule, overdue + upcoming invoice payments, proposals waiting on the client, questionnaire drafts in progress, inquiries needing follow-up | Same query that feeds the dashboard "What needs you" section (`page.tsx:164`, wired `page.tsx:85`). Call with a higher `limit` (e.g. `50`) than the dashboard's `8` — an email digest isn't paginated, so don't silently truncate what the dashboard truncates for screen space. |
| Upcoming shoots / calls | `getAgenda({ fromDate, toDate, timeZone: "America/New_York" })` — `src/lib/agenda.ts:65-229` | Weddings, engagement sessions, "other" sessions, and scheduler calls in a date window | Window: today through **+2 days** (ET), matching a "what's coming up" brief rather than the dashboard's full-future agenda. Reuses the exact query at `page.tsx:86`. |
| Overdue project milestones | `loadProjectMilestoneSummaries(projectRows, today)` — `src/lib/project-milestones-batch.ts:30-119`, filtered to `hasOverdue === true` | Projects whose current milestone (final payment, gallery delivery, etc.) is past due | **Gated on `PROJECT_PROGRESS_TIMELINE=1`.** See §1.1 — this is a deliberate boundary, not an oversight. `projectRows` source is specified precisely in §1.1a — do not improvise it. |

None of these is a new query. `listDashboardActionItems` and `getAgenda` are unconditionally
safe to call (no flag). `loadProjectMilestoneSummaries` carries an explicit existing-code
constraint that this phase respects rather than relitigates (§1.1).

### 1.1 Why the milestone-overdue signal is flag-gated, not always-on

`project-milestones-batch.ts:10-11` states plainly: *"this is new load and MUST stay behind the
flag entirely (callers must not invoke this when the flag is off)."* That comment was written for
the Phase 22 list-page bar, but the constraint is about the **batch load itself** (five extra
`chunkedInArrayFetch` reads — events, invoices, payments, galleries, bookings — across every
active project), not about which page calls it. The daily brief is a new caller. Rather than
deciding unilaterally that a once-a-day cron's load profile is different enough to ignore that
comment, this phase **respects the existing boundary**: the "overdue milestones" section of the
brief is included only when `PROJECT_PROGRESS_TIMELINE=1`. When the flag is off, that section is
silently omitted from the email (not an error, not a placeholder row) — the brief still ships
useful signal from the other two groups. This also means Phase 18 adds a second, independent
caller-site consumer of that Phase 22 flag, which is worth flagging to whoever eventually decides
to graduate `PROJECT_PROGRESS_TIMELINE` to always-on.

### 1.1a Where `projectRows` comes from (this is not optional detail — read before implementing)

`loadProjectMilestoneSummaries(projectRows, today)` takes project rows as its first argument
(`project-milestones-batch.ts:30-33`); it does not fetch them itself. Both existing callers feed
it from `listProjectIndex` / `listProjectBoardIndex` (`src/app/projects/page.tsx:170,254`
pre-rev; current lines `page.tsx:164/240-246,253-255`). This phase's `projectRows` **MUST** come
from the same reused read — `listProjectIndex` — not a fresh query, and **MUST NOT** silently
truncate the set of active projects scanned for overdue milestones. Concretely:

- Call `listProjectIndex({ page: n, pageSize: 200, sort: "eventDate" })` (`src/lib/crm.ts:285-347`
  — the exact function `page.tsx:240-246` already calls, same parameters the list page's largest
  `pageSizeOptions` entry already uses, `page.tsx:15`) starting at `page: 1`, and **loop across
  every page**: accumulate `rows.map(({ project }) => project)` from each response, and keep
  calling with `page: n + 1` until `currentPage >= totalPages` (both already returned by
  `listProjectIndex`). Feed the accumulated array into `loadProjectMilestoneSummaries`.
- This is zero new SQL — it is the identical query the projects list page already issues once per
  pagination click, issued N times in a loop instead of once by a batch job that (unlike a page
  request) can afford to make N round trips before the digest hour fires. It does not violate the
  "zero new canonical queries" guarantee (§0).
- **Do not** call `listProjectIndex` once with a single hardcoded `pageSize` and treat that as
  "good enough": `pageSize` is hard-capped at 200 inside `listProjectIndex` itself
  (`crm.ts:292`, `Math.min(Math.max(..., 1), 200)`) — a single call can never return more than 200
  rows. With 200 or fewer active projects a one-shot call happens to return everything, but that
  is incidental, not guaranteed; the studio's active-project count is not bounded by this spec, so
  a one-shot call silently drops overdue projects past row 200 the day that bound is crossed, with
  no error and no log line. The page-loop above has no such ceiling.
- **Do not** use `listProjectBoardIndex` for this. It hard-caps at `BOARD_MAX_ROWS = 300`
  (`src/lib/project-board.ts:17`, enforced at `crm.ts:402,407`) and reports truncation via a
  `truncated` boolean (`crm.ts:413`) that the board UI renders as a visible banner
  (`page.tsx:217-221`) — a background job has nowhere to render that banner, so silently
  swallowing `truncated: true` inside a once-a-day digest is exactly the "truncate overdue
  projects via a default page size" failure mode this fix exists to prevent. It also defaults to
  only the 6 in-flight stages (`crm.ts:368`) unless `stages` is passed explicitly, which is a
  second, independent way it can under-report.
- `listProjectIndex`'s `projectIndexWhere` always filters `eq(projects.status, "active")`
  (`crm.ts:269`), matching "every active project" as already stated in §1.1 above — no additional
  status filter is needed or should be added.

### 1.2 Assembling the report — `src/lib/daily-brief.ts` (new, pure)

One new module, `computeDailyBrief(now, options?)`, mirrors the shape of
`computeSystemHealth()` (`src/lib/system-health.ts:185`): it calls the three signal sources
above (wrapping each in try/catch so one failing source degrades that section to "unavailable"
rather than throwing the whole report — identical defensive shape to
`computeSystemHealth`'s per-block try/catch, e.g. `system-health.ts:386-433`), and returns a
typed, whitelisted-fields-only report:

```
type DailyBriefReport = {
  generatedAt: string;               // ISO
  dateLabel: string;                 // e.g. "Tuesday, July 7"
  actionItems: DashboardActionItem[]; // from listDashboardActionItems (already exported type)
  upcoming: AgendaItem[];             // from getAgenda (already exported type)
  overdueMilestoneProjects: Array<{ projectId: string; projectName: string | null }>; // only when PROJECT_PROGRESS_TIMELINE=1
  narrative: string | null;           // set from the day's cached AI narration row, if fresh (§3.3); else null
}
```

No new field categories are invented — every field already exists in
`DashboardActionItem` (`dashboard.ts:136-146`), `AgendaItem` (`agenda.ts:8-21`), or is a
`{ id, name }` pair already present on every `projects` row.

---

## 2. Delivery: fold into the Phase 21 digest (do not build a second cron+worker+email)

**Decision: the daily brief is a NEW SECTION of the existing Phase 21 systems digest email, not
a second email/cron/Worker.**

Phase 21 already ships every piece a second daily email would otherwise need to reinvent:

| Need | Phase 21 already has it |
|---|---|
| Once-a-day cron at a configurable ET hour | `easternHour(now) === parseDigestHour(process.env.MONITOR_DIGEST_HOUR)` — `src/app/api/cron/systems-monitor/route.ts:25-34,75` |
| Bearer-authed, fail-closed cron route reachable through the origin-guard bypass | `src/app/api/cron/systems-monitor/route.ts:36-51`; `PUBLIC_API_PREFIXES` entry `src/lib/origin-guard.ts:22-29` |
| Fail-loud Worker (workers.dev origin, `redirect:"manual"`, throws on non-2xx) | `workers/systems-monitor.ts:1-29` |
| Owner-only email sender, no unsubscribe footer, fail-closed on missing config | `sendAdminAlertEmail` — `src/lib/email.ts:190-199` |
| Self-heartbeat + dead-man's-switch (email silently stops → that absence is itself the alarm) | `system-health.ts:488-498`; route `:105-113` |
| A single recipient Tyler already trusts (`ALERT_EMAIL`) | `alertEmail()` — `system-health.ts:48-50` |

Building a second `wrangler.daily-brief.jsonc` + Worker + cron route + digest-hour config would
duplicate every one of those seven items for one extra section of prose. It would also mean a
**second thing that can silently die** with its own dead-man's-switch story — exactly the failure
class Phase 21 exists to eliminate. Tyler is a solo owner: one morning email he actually reads
beats two he starts skimming past.

**The cost of folding in:** the systems-monitor email now mixes "is the CRM's plumbing healthy"
(ops) with "what needs your attention today" (business) in one message. Mitigated by:
- The brief renders as a clearly labeled second section, appended **after** the health signals
  but **before** `buildHealthDigest`'s trailing dead-man footer (the "If you did NOT receive
  today's Systems email..." line and the "External dead-man ping: ..." line,
  `system-health.ts:551-553`) — see §2.1's precise insertion point — with its own heading
  (`"Today: what needs you"`) — never interleaved with health signals.
- It has its **own** enablement flag (§4) so Tyler can run ops monitoring alone, or add the brief
  later, without touching the other.
- `buildHealthDigest`'s subject line is untouched by this phase — the subject still reflects
  system health (green/warn/critical), because that is the signal that matters most for the
  dead-man's-switch story; the brief section is additive body content, not a subject-line
  concern.

### 2.1 Where the section is built — and where in the text it lands (before the footer, not after)

**Ordering hazard, called out explicitly:** `buildHealthDigest` (`system-health.ts:526-555`)
already ends its returned `text` with a trailing dead-man footer — `lines.push("—")` followed by
the "If you did NOT receive today's Systems email..." line and the "External dead-man ping: ..."
line (`system-health.ts:551-553`). A naive `digest.text = digest.text + briefSection` (or any
`appendDailyBriefSection(text, report)` that does plain string concatenation onto the already-
built `text`) lands the brief section **after** that footer, not "after the health signals" as
§2 requires — Tyler would have to scroll past the dead-man boilerplate to reach "Today: what needs
you" every morning. That is the wrong order and must not ship.

**Fix: extend `buildHealthDigest` with an optional parameter for the extra section, inserted
BEFORE the footer lines are pushed** (i.e. before `system-health.ts:551`'s `lines.push("—")`),
not by string-splicing the already-assembled text afterward:

```
// system-health.ts — buildHealthDigest gains one optional field on its options bag; no health
// logic changes, it stays agnostic to what the section contains.
export function buildHealthDigest(
  report: SystemHealthReport,
  options?: { deadmanArmed?: boolean; extraSection?: string },
): { subject: string; text: string } {
  // ...unchanged signals loop...
  if (options?.extraSection) {
    lines.push(options.extraSection);
    lines.push("");
  }
  lines.push("—");                                   // footer starts here — extraSection is
  lines.push("If you did NOT receive today's Systems email...");  // already above it
  ...
}
```

`daily-brief.ts` owns *formatting* the brief into a text block (heading + bullets + narrative) —
it never needs to know about the footer at all — and the cron route passes that formatted string
in as `extraSection`:

```
// src/app/api/cron/systems-monitor/route.ts, inside the existing digest branch (route.ts:75-79)
if (easternHour(now) === parseDigestHour(process.env.MONITOR_DIGEST_HOUR)) {
  let extraSection: string | undefined;
  if (dailyBriefEnabled()) {
    const brief = await computeDailyBrief(now);
    extraSection = formatDailyBriefSection(brief); // pure text formatting, no digest.text knowledge
  }
  const digest = buildHealthDigest(report, { deadmanArmed: Boolean(deadmanPingUrl()), extraSection });
  sentDigest = await sendAdminAlertEmail(digest);
  ...
}
```

This guarantees "after the health signals, before the footer" by construction — the insertion
point is a fixed line in `buildHealthDigest` itself, not a string search over already-rendered
text, so it cannot silently regress if the footer's wording changes later.

`computeDailyBrief` (and the `formatDailyBriefSection` call around it) is wrapped in the SAME
try/catch discipline as every other block in `computeSystemHealth` — a thrown error here must not
prevent `sendAdminAlertEmail(digest)` from running with the health-only body. Concretely: wrap the
`dailyBriefEnabled()` branch in its own try/catch that falls back to leaving `extraSection`
`undefined` on any throw (so `buildHealthDigest` renders exactly as it does today, footer and
all), logged nowhere sensitive — see §3.4 for the full degrade chain.

No new Worker, no new wrangler config, no new cron secret, no new digest-hour env var, no new
`/system-status` wiring beyond one line noting "daily brief: <on/off>".

---

## 3. The AI narration step

### 3.1 Ground truth: there is no in-app LLM call to reuse (verified)

Before designing this step, the codebase was checked for any existing direct model-provider
call: no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-shaped env var, no `fetch` to `api.anthropic.com`
or any model host, and no `@anthropic-ai/*` / `openai` package in `package.json` dependencies.
**Zero hits.** The only "AI narrative" this codebase produces today is Phase 10's weekly business
review, and it is produced entirely **outside** the CRM's own runtime:

- `studio_get_business_review` (`src/lib/studio-mcp.ts:163-166`) is described in its own tool
  metadata as: *"READ-ONLY — the agent composes the prose narrative from this JSON; the tool
  never sends or writes anything."*
- The same sentence is repeated in the authoritative agent-access doc:
  `docs/studio-agent-access.md:246`.

In other words: the CRM exposes structured JSON over an authenticated MCP/REST surface, and
whatever agent session calls that tool (Tyler's own Claude Code session, a scheduled agent run,
Fable review, etc.) writes the prose. The Next.js app / Cloudflare Worker never talks to a model
provider, holds no model API key, and sends no data to an LLM host from its own infrastructure.

**This phase reuses that exact shape** rather than inventing a new one. Concretely, that means
the "AI call" for the daily brief is **not a `fetch()` inside `src/app/api/cron/systems-monitor`**
— it is a scheduled agent session (outside the Worker) that reads a new read-only signal, writes
a short narration, and hands it back through a small authenticated endpoint before the cron fires.
This preserves every property the "no new AI integration" instruction is protecting: no new
vendor secret, no new outbound network call from the Worker, no new per-call cost path inside the
request that MUST succeed for the email to go out.

### 3.2 New read-only surface for the agent to narrate from

Add `studio_get_daily_brief` to the MCP tool list (`src/lib/studio-mcp.ts`), mirroring
`studio_get_business_review`'s shape and description exactly (read-only, "the agent composes the
prose narrative from this JSON; the tool never sends or writes anything"). It returns
`computeDailyBrief(now)` (§1.2) verbatim — the same JSON the cron route itself would build the
rule-based section from, so the agent's narration is always describing the literal same signals
Tyler will see below it in the email, never a divergent view.

### 3.3 Where a narration lands: one non-canonical, capped, upsert-by-day row

New table `daily_brief_narrations`, styled identically to `job_runs` (`src/db/schema.ts:638-646`)
— current-state, one row per day, non-canonical, safe to lose:

```sql
-- migrations/0096_daily_brief_narration.sql
CREATE TABLE IF NOT EXISTS daily_brief_narrations (
  day_key       TEXT PRIMARY KEY NOT NULL,  -- YYYY-MM-DD in America/New_York
  narrative     TEXT NOT NULL,              -- agent-composed prose, capped (see below)
  generated_at  TEXT NOT NULL
);
```

**Migration number, assigned: 0096.** As of this spec revision the migrations tail is
`0095_questionnaire_autofill_review.sql`, so 0096 is the next free slot. **However**, three
unshipped specs — Phase 18 (this one), `phase-19-embeddable-lead-form.md`, and
`phase-20-meeting-notes.md` — all currently claim 0096, because all three were written against
the same tail before any of them shipped. Whichever of the three lands first wins 0096
legitimately; the other two collide. **Build-time caveat (mandatory, first step of task #1 in
§10): before creating `migrations/0096_daily_brief_narration.sql`, the builder MUST `ls migrations/
| tail` (or equivalent) to confirm 0096 is still the next free number.** If Phase 19 or Phase 20
landed first and already claimed 0096, this phase's migration — and every 0096 reference in this
document (§3.3 above, §4, §10) — must be renumbered to whatever the next free number is at build
time (0097, 0098, ...), across all three files in the 3-place mirror below. Do not ship a
duplicate/colliding migration number under any circumstances.

3-place mirror per this repo's migration convention (verified against 0093/0094/0095), using
whichever number is confirmed free per the caveat above (0096 unless already claimed):
1. `migrations/0096_daily_brief_narration.sql` (above).
2. `src/db/client.ts` `migrate()` — idempotent `CREATE TABLE IF NOT EXISTS` block, appended after
   the existing 0093 block (`src/db/client.ts:1259-1281`), same style.
3. `src/db/schema.ts` — `export const dailyBriefNarrations = sqliteTable("daily_brief_narrations", {...})`,
   placed next to `jobRuns`/`healthAlerts` (`schema.ts:638-654`).

New route `POST /api/agent/daily-brief-narrative`, double-guarded exactly like
`/api/agent/health` (`src/app/api/agent/health/route.ts:1-22`):

```
guardDirectWorkerApiRequest(request)  // blocks the raw workers.dev origin
guardAgentApiRequest(request)         // STUDIO_AGENT_API_TOKEN bearer, 503 unset / 401 wrong
```

Body: `{ narrative: string }`. Handler:
- Trims; rejects empty (`400`).
- **Runs the same secret-value redaction `sanitizeJobRunError` performs — not just a length cap
  and a control-character strip.** `sanitizeJobRunError` (`job-runs.ts:45-56`) is load-bearing
  precisely because it walks `SECRET_ENV_NAMES` (`job-runs.ts:27-41`) and replaces any configured
  secret's literal *value* with `[redacted]` before capping/trimming — that is what makes it safe
  for text to reach `last_error`, which the digest renders verbatim. The narration is agent-
  composed free text with no schema constraining what it can contain, flowing into that same
  digest email, which `buildHealthDigest` carries an explicit invariant against
  (`system-health.ts:522-524`: *"It MUST NEVER interpolate process.env"*) — an accidentally
  self-narrated secret (e.g. an agent that pastes an error message containing
  `STUDIO_AGENT_API_TOKEN`'s value while describing a stuck job) must not survive into the sent
  email. A control-character strip alone does nothing to catch that. Concretely:
  - Extract `sanitizeJobRunError`'s secret-redaction loop (the `for (const name of
    SECRET_ENV_NAMES) { ... text.split(secret).join("[redacted]") ... }` body,
    `job-runs.ts:48-52`) into a small shared helper both `sanitizeJobRunError` and the narration
    handler call, or call `sanitizeJobRunError` itself against the narrative text before applying
    the narration's own (longer, 1500-char) cap — do not re-implement the redaction loop a second
    time by hand; a duplicated copy is exactly the kind of thing that silently drifts from
    `SECRET_ENV_NAMES` when a tenth secret name is added later.
  - Then cap at a fixed length (e.g. 1500 chars — long enough for 4-6 sentences, short enough that
    a narration can never smuggle in a large blob) and strip control characters, same discipline
    as `sanitizeJobRunError`'s own cap/trim (defense-in-depth; the endpoint does not trust the
    caller to pre-clean).
  - **Extend the secret-redaction test to cover the narration path**: whatever test file currently
    exercises `sanitizeJobRunError`'s secret-value redaction must gain a case (or the narration
    handler must gain an equivalent one) asserting a narrative string containing a live
    `SECRET_ENV_NAMES` value is redacted to `[redacted]` before the row is written — the same
    property, proven on the new code path, not assumed by proximity to the old one.
- `day_key` = today's date in `America/New_York` (`dateKeyInTimeZone`, already imported elsewhere,
  e.g. `agenda.ts:3`).
- `INSERT ... ON CONFLICT(day_key) DO UPDATE` (no `db.transaction()`, matching the D1-no-
  transactions rule already documented at `job-runs.ts:17` and enforced throughout Phase 21).
  A second call the same day simply overwrites — last-write-wins, not a second AI spend charged
  to anyone (§5).
- **Not exported as an MCP tool** — this is a write endpoint; it stays REST-only, matching how
  every other agent *write* in this codebase is REST (`studio_draft_sms`, `studio_draft_email`)
  while read-only analytics are MCP tools. Add it to the same "no agent/MCP export of internals"
  guard-test discipline as `recordJobRun`/`computeSystemHealth` (`observability-guard.test.ts:117-123`)
  — a parallel assertion that the MCP tool list never references `daily_brief_narrations` as a
  writable surface.
- No `origin-guard` `PUBLIC_API_PREFIXES` entry needed: like `/api/agent/health`, the path already
  lives under `/api/agent/` and inherits `isStudioTrustedAgentApiPath` proxy pass-through
  (`origin-guard.ts` comment pattern at `:22-28`) — the bearer token is the trust boundary, and it
  is a REST endpoint an authenticated agent hits directly, not a cron-worker-to-origin path.

### 3.4 What happens when there's no narration (the required degrade path)

`computeDailyBrief` reads `daily_brief_narrations` for **today's** `day_key` only (ET). Three
cases, all producing a shippable email:

1. **Row exists, generated today.** `report.narrative` = the cached text. It renders as a short
   italic paragraph above the rule-based sections.
2. **Row missing** (the narration Routine didn't run, isn't configured, or the agent produced
   nothing that day). `report.narrative = null`. The email ships with the rule-based bullet
   sections only — no placeholder text, no "AI unavailable" apology line (this is a convenience
   feature; a missing narration is not an error state worth narrating about).
3. **Row exists but stale** (yesterday's `day_key`, or clock skew). Same as case 2 — a stale
   narration describing yesterday's numbers next to today's bullet list would be actively
   misleading, so staleness is treated identically to absence, not rendered with a caveat.

Crucially: **the read in case 1-3 is a single `SELECT ... WHERE day_key = ?` against a table this
phase owns**, wrapped in the same try/catch discipline as every other `computeDailyBrief`
sub-block (§1.2). There is no synchronous network call to any AI provider anywhere in the send
path — so "the AI call fails" cannot manifest as a hang, a timeout, or a thrown error inside the
cron request at all. This is the strongest possible version of "never blocks the email": the
guaranteed-send path has zero code-level dependency on AI narration succeeding, because the
narration was (or wasn't) produced by an entirely separate process, on an entirely separate
schedule, hours before the digest cron ever runs.

---

## 4. Flags

Two flags, layered (mirrors the `MONITOR_ENABLED` → `DEADMAN_PING_URL` layering already
established in Phase 21, `system-health.ts:456` runbook):

| Flag | Default | Effect |
|---|---|---|
| `MONITOR_ENABLED` (existing, unchanged) | off | Gates whether the digest email sends **at all**. Without it, nothing in this phase can ever produce an email — same as today. |
| `DAILY_BRIEF_ENABLED` (new) | off | Gates whether the "Today: what needs you" section is appended to the digest. Takes effect **only when `MONITOR_ENABLED=1`** — it is a sub-toggle of an already-gated email, not an independent send path. When off, `computeSystemHealth`'s digest ships exactly as it does today (byte-identical to pre-Phase-18 behavior). |

**Why a separate flag rather than folding under `MONITOR_ENABLED` alone:** Tyler may already have
`MONITOR_ENABLED=1` running (ops digest live) before he's ready for business-priority content in
the same email, or vice versa — this mirrors the existing pattern of `SEQUENCES_ENABLED` +
per-sequence flags (`docs/studio-agent-access.md:161-164`) and `MONITOR_ENABLED` +
`DEADMAN_PING_URL` (independently togglable layers under one master gate). A single combined flag
would force an all-or-nothing choice neither precedent supports.

`PROJECT_PROGRESS_TIMELINE` (existing, unchanged) additionally gates only the overdue-milestones
section (§1.1) — independent of both flags above.

**Ships dark:** migration 0096 applied (additive — renumbered per the §3.3 build-time free-slot
caveat if Phase 19/20 claimed 0096 first), `daily-brief.ts`, the MCP tool, the narration
endpoint, and the digest-section wiring all deployed with `DAILY_BRIEF_ENABLED` unset — zero
behavior change to the existing Phase 21 email. Enabling requires Tyler to (1) set
`DAILY_BRIEF_ENABLED=1` (only meaningful if `MONITOR_ENABLED=1` is already set), and (2)
optionally set up a daily narration Routine (§3.3) if he wants the AI paragraph — the rule-based
sections work with zero agent involvement.

---

## 5. Cost bound (one AI call/day max)

There is no metered API call inside the CRM's own runtime to bound — the "AI call" is a
Claude session Tyler (or his own scheduling harness) runs once a day against
`studio_get_daily_brief`, mirroring exactly how often Phase 10's weekly review is narrated
(on Tyler's own cadence, not the app's). The system-side guarantee is narrower and simpler:
the narration endpoint (§3.3) upserts by `day_key`, so however many times it is called in a
given day, **at most one row (one narration) exists per day** — repeat calls overwrite, they
never accumulate cost or duplicate content in the email. There is no rate limit needed beyond
that upsert semantics, because a second call the same day is a correction, not a second charge
billed by this system.

---

## 6. Data-boundary statement (no new client-data egress)

The daily brief exposes **the same field categories** Phase 10's `studio_get_business_review`
already exposes to any agent holding `STUDIO_AGENT_API_TOKEN`: project names, client names,
dates, amounts, and stage/status labels — all already readable via existing MCP tools
(`studio_get_agenda`, `studio_search_projects`, the business review itself). `studio_get_daily_brief`
adds no new field type; it re-serves `DashboardActionItem` / `AgendaItem` / a
`{projectId, projectName}` pair, all of which are already fields returned by tools listed in
`docs/studio-agent-access.md`. Any data an agent sees while narrating the daily brief is data
that same agent could already see today by calling `studio_get_agenda` +
`studio_get_business_review` back to back. **No new data leaves the system** — the boundary is
identical to Phase 10's, by construction, because the tool is deliberately shaped to match it.

The CRM's own Cloudflare Worker still sends nothing to any AI/model provider — exactly as today.

---

## 7. Push (explicitly out of scope this phase)

Tyler's ask included "optional push." Web Push requires a registered `ServiceWorkerRegistration`
to call `pushManager.subscribe()` — this app has no service worker. Phase 15 built the PWA
manifest/install path deliberately **without** one (`docs/specs/phase-15-pwa-mobile.md:16`,
`:18`: *"Deferred / behind a flag: service worker ... Web push — specced at a high level in §9,
not built in this phase"*) and that flag (`PWA_SERVICE_WORKER`) remains unshipped/off. Building
push infrastructure now means either (a) shipping a service worker ahead of its own phase's
readiness gate (Phase 15 §3's explicit "do NOT ship the SW in v1" recommendation), or (b) a
non-SW push substitute (there isn't one for web). **This spec does not design push.** When
Phase 15's SW ships and is validated in production, a follow-up note can revisit whether the
daily brief should also fire a push notification; until then, email is the only delivery channel
and satisfies the "what needs you" ask on its own.

---

## 8. Reuse map

| Need | Reuse |
|---|---|
| Priority leads / stuck items / overdue payments | `listDashboardActionItems` (`src/lib/dashboard.ts:156`) |
| Upcoming shoots / calls | `getAgenda` (`src/lib/agenda.ts:65`) |
| Overdue milestones | `loadProjectMilestoneSummaries` (`src/lib/project-milestones-batch.ts:30`), flag-gated per §1.1, fed `projectRows` from a full-pagination loop over `listProjectIndex` (`src/lib/crm.ts:285`) per §1.1a — never a fresh query, never a single truncated page |
| Once-daily ET-hour cron + fail-loud Worker + bearer route | Phase 21's `workers/systems-monitor.ts` + `src/app/api/cron/systems-monitor/route.ts` (unchanged; extended) |
| Owner-only email send | `sendAdminAlertEmail` (`src/lib/email.ts:190`) |
| Digest body composition | `buildHealthDigest` (`system-health.ts:526-555`), extended with an optional `extraSection` field inserted before the footer (§2.1) |
| Agent-composed-prose-from-read-only-JSON pattern | `studio_get_business_review` (`studio-mcp.ts:163`) — the exact shape `studio_get_daily_brief` copies |
| Bearer-guarded `/api/agent/*` REST write, double-guard pattern | `/api/agent/health/route.ts:1-22` (guard shape copied; this route is a POST instead of GET) |
| Non-canonical, capped, secret-redacted, sanitized text storage | `job-runs.ts`'s `sanitizeJobRunError` (secret-value redaction over `SECRET_ENV_NAMES`, reused/extracted, not re-implemented — §3.3) + upsert-by-key pattern |
| Zero-canonical-write guard test | `src/lib/observability-guard.test.ts` (pattern extended, not duplicated from scratch) |
| Migration 3-place mirror | migrations 0093/0094/0095 + `db/client.ts` inline block + `db/schema.ts` |

---

## 9. Test plan

Build gate: `npm run build` (exit 0), `npm run lint`, `npm test`.

Unit tests (tsx, local better-sqlite3):

1. **`computeDailyBrief` assembles all three groups from real fixtures** — seed action-item,
   agenda, and (with `PROJECT_PROGRESS_TIMELINE=1`) overdue-milestone fixtures; assert the report
   contains exactly the expected rows, using the same fixture style as
   `src/lib/dashboard-actions.test.ts` / `src/lib/project-milestones.test.ts`.
2. **Milestone section omitted when the flag is off** — with `PROJECT_PROGRESS_TIMELINE` unset,
   `overdueMilestoneProjects` is absent/empty even when overdue projects exist in fixtures; no
   error thrown, no extra queries fired (assert via a query-count spy or by checking the batch
   loader's import is not invoked in that branch).
3. **One failing signal source degrades only that section** — force `getAgenda` (or the
   milestone loader) to throw; assert `computeDailyBrief` still returns action items + whatever
   other sections succeeded, with the failed section empty/omitted, never a thrown report.
4. **Digest ships with `DAILY_BRIEF_ENABLED` off — byte-identical to today** — run the existing
   systems-monitor digest path with the flag unset; assert the sent body matches
   `buildHealthDigest`'s output exactly (no section appended), i.e. zero behavior change to
   Phase 21.
5. **Digest ships with the brief appended when enabled, in the right position** — flag on, a
   narration row present for today → digest body contains the health signals, then the brief
   section (narrative + bullets) under its labeled heading, then the dead-man footer, in that
   exact order (§2.1) — assert the brief section's text appears BEFORE the "If you did NOT
   receive today's Systems email..." line, not after it.
6. **No narration row → rule-based section still ships** — flag on, no `daily_brief_narrations`
   row for today → digest sends with the bullet sections and no narrative paragraph, `sentDigest`
   is still `true`, no error surfaced, no delay.
7. **Stale narration is treated as absent** — a row present for **yesterday's** `day_key` →
   `report.narrative` is `null` (not yesterday's stale text).
8. **AI-narration-step failure never blocks the email** — force `computeDailyBrief` to throw
   inside the digest-building branch; assert `sendAdminAlertEmail` is still called with the
   health-only body and the route still returns its normal success shape (mirrors the
   degrade-to-rule-based requirement literally, at the integration level).
9. **Narration endpoint: auth + validation + upsert + secret redaction** — missing/wrong bearer →
   401/503 (mirrors `guardAgentApiRequest`); empty body → 400; oversized/control-char narrative →
   capped + cleaned before storage; **a narrative containing a live `SECRET_ENV_NAMES` value is
   stored with that value replaced by `[redacted]`** (same assertion style as whatever test
   already covers `sanitizeJobRunError`'s redaction — extended to this path per §3.3); two POSTs
   same day → one row (`ON CONFLICT DO UPDATE`), not two.
10. **Zero-canonical-write guard (extends `observability-guard.test.ts`)** — running
    `computeDailyBrief`, the narration endpoint, and a full digest send (flag on) writes rows
    **only** to `daily_brief_narrations` (+ the existing `job_runs`/`health_alerts`); assert the
    same seeded-snapshot-unchanged check already used for `CANONICAL_TABLES`
    (`observability-guard.test.ts:17-25,109-115`) still passes with these new code paths
    exercised.
11. **No MCP/REST export of the narration write as a public write surface beyond the agent
    bearer** — `studio_get_daily_brief` is a READ-ONLY MCP tool (assert its handler never calls
    anything that writes); the narration POST route is not listed as an MCP tool name (extends
    the `observability-guard.test.ts:117-123` scan to also check for
    `daily_brief_narrations`/`daily-brief-narrative` references).
12. **Flag-off is a true no-op** — `DAILY_BRIEF_ENABLED` unset (or `MONITOR_ENABLED` unset):
    `daily_brief_narrations` is never read, `computeDailyBrief` is never called from the route.
13. **Overdue-milestone scan does not truncate past one page** (§1.1a) — seed more than 200
    active projects (exceeding `listProjectIndex`'s hard-capped `pageSize`, `crm.ts:292`), with at
    least one overdue-milestone project seeded on what would be page 2+ if only a single page were
    fetched; with `PROJECT_PROGRESS_TIMELINE=1`, assert `computeDailyBrief`'s
    `overdueMilestoneProjects` includes that project — proving the `projectRows` source pages
    through `listProjectIndex` to `currentPage >= totalPages` rather than issuing one bounded
    call. Also assert no fresh/ad-hoc `SELECT ... FROM projects` is issued (spy/query-count, same
    technique as test 2) — only repeated calls to the existing `listProjectIndex` function.

---

## 10. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
|---|---|---|---|---|
| 1 | Migration 0096 — **first confirm 0096 is still free** (`ls migrations/ \| tail`; renumber if Phase 19/20 shipped first, per §3.3) — then the 3-place mirror: SQL + `client.ts` block + `schema.ts` | S | Low | Additive, non-canonical |
| 2 | `src/lib/daily-brief.ts` — `computeDailyBrief()` over the 3 reused signal sources, per-block try/catch; overdue-milestone `projectRows` sourced by paging `listProjectIndex` to completion per §1.1a | S | Low | Pure read; zero new queries; must not truncate (test 13) |
| 3 | `studio_get_daily_brief` MCP tool (read-only, mirrors `studio_get_business_review`) | S | Low | Add to `docs/studio-agent-access.md` catalog too |
| 4 | `POST /api/agent/daily-brief-narrative` (double-guard, cap+sanitize, upsert-by-day) | S | Low | Mirrors `/api/agent/health` guard shape |
| 5 | Extend `buildHealthDigest` with the optional `extraSection` field (inserted before the footer, §2.1) + the systems-monitor digest branch computing it behind `DAILY_BRIEF_ENABLED`, wrapped so a throw never blocks `sendAdminAlertEmail` | M | Med | Must preserve byte-identical output when the flag is off (test 4); must land before the footer (test 5) |
| 6 | `/system-status` — one line noting daily-brief on/off (reuse existing page, no new section needed beyond a status line) | S | Low | Optional polish, not required for the email to work |
| 7 | Tests §9 (13 cases) + extend `observability-guard.test.ts` | M | Low | Build-gate green |
| 8 | Deploy dark (`DAILY_BRIEF_ENABLED` unset); document the optional narration-Routine setup for Tyler as an enablement note, not an autonomous step | S | Low | Guardrails 1/2/4 |

---

## 11. Active-Learning-Log pitfalls — pre-empted

- **Don't invent a new AI vendor integration.** Verified (§3.1) that no direct LLM API call
  exists anywhere in this codebase; this phase reuses the read-only-JSON + agent-composes-prose
  shape Phase 10 already established, rather than adding a model API key/secret/network call
  inside the Worker.
- **Don't build a second cron+Worker+email when folding in is strictly less to maintain.**
  Decided and justified in §2 — one email, clearly sectioned, independently flaggable.
- **Don't relitigate an existing load-bearing comment.** `project-milestones-batch.ts:10-11`
  explicitly restricts its own batch load to `PROJECT_PROGRESS_TIMELINE=1` callers; this phase
  obeys that rather than treating a cron's different load shape as an excuse to bypass it (§1.1).
- **The guaranteed-send path has zero code-level dependency on any AI/agent process succeeding.**
  The only read in the hot path is a `SELECT` against a table this phase owns; there is no
  network call to any model provider inside the digest-building request at all, which is the
  strongest possible version of "AI failure never blocks the email" (§3.4).
- **No D1 transactions.** The narration upsert is `INSERT ... ON CONFLICT DO UPDATE`, matching
  the D1-rejects-transactions rule already enforced throughout Phase 21.
- **Secret/length hygiene on agent-submitted free text.** The narration runs the same
  secret-value redaction `sanitizeJobRunError` performs (over `SECRET_ENV_NAMES`, reused/extracted
  rather than re-implemented) before it is capped and stripped of control characters — not just a
  cap-and-strip. `buildHealthDigest`'s explicit "MUST NEVER interpolate process.env" invariant
  (`system-health.ts:522-524`) applies to this new tainted-input path exactly as it does to
  `last_error`; the secret-redaction test is extended to prove it (test 9, §9).
- **No agent/MCP export of the write surface.** The narration POST endpoint is REST-only, guarded
  identically to other agent-write endpoints, and explicitly asserted absent from the MCP tool
  list (test 11) — read/write separation stays consistent with the rest of the agent surface.
- **Push is not quietly smuggled in.** No service-worker code, no `PushManager` calls, no push
  subscription storage is introduced by this phase — explicitly deferred to post-Phase-15 (§7).

---

## 12. Changelog

### Rev 2 — 2026-07-07 — adversarial Fable review folded in (verdict: APPROVE WITH CHANGES)

| Finding | Severity | Root cause (verified) | Fix in this spec |
|---|---|---|---|
| **A-1** — migration number collision | MEDIUM | Migrations tail is `0095_questionnaire_autofill_review.sql`; Phase 18, 19 (`phase-19-embeddable-lead-form.md`), and 20 (`phase-20-meeting-notes.md`) all independently claim 0096 | §3.3: Phase 18 → 0096, assigned, **plus** a mandatory build-time caveat to `ls migrations/ \| tail` and renumber (§3.3, §4, §10 task 1) if 19/20 shipped first. |
| **A-2** — `projectRows` source unspecified (MOST IMPORTANT) | MEDIUM | `loadProjectMilestoneSummaries(projectRows, today)` (`project-milestones-batch.ts:30-33`) takes rows as input; neither existing caller nor this spec named the read/params supplying them for the brief — risk of a fresh `SELECT` (violating §0's "zero new canonical queries") or silent truncation | New **§1.1a**: `projectRows` comes from `listProjectIndex` (`crm.ts:285-347`), called in a full-pagination loop (`page: 1..totalPages`, `pageSize: 200`) — reuses the existing blessed read exactly, never truncates regardless of active-project count. `listProjectBoardIndex` explicitly rejected (hard-caps at `BOARD_MAX_ROWS=300`, defaults to 6 in-flight stages). Test 13 added. |
| **A-3** — narrative sanitization missing secret redaction | MINOR | Spec said "cap + strip control characters," but the cited precedent `sanitizeJobRunError` (`job-runs.ts:45-56`) is load-bearing for SECRET-VALUE redaction over `SECRET_ENV_NAMES`, protecting `buildHealthDigest`'s "MUST NEVER interpolate process.env" invariant (`system-health.ts:522-524`) — the narration is new tainted input entering that same digest | §3.3: narration handler MUST reuse/extract `sanitizeJobRunError`'s secret-redaction loop before its own cap+strip; test 9 extended to assert a live secret value is redacted before storage. |
| **A-4** — section placement lands below the dead-man footer | MINOR | `appendDailyBriefSection` via plain string concat would append after `buildHealthDigest`'s trailing footer (`system-health.ts:551-553`), not "after the health signals" as intended | §2.1 rewritten: `buildHealthDigest` gains an optional `extraSection` field inserted before the footer lines are pushed — insertion point fixed by construction, not a string search. Test 5 extended to assert ordering. |
| **A-5** — latency overclaim | MINOR | §0's "cannot delay ... the digest" is accurate for the AI-narration step (§3.4) but overstated for the rule-based part: `computeDailyBrief` is awaited inside the send request, and with `PROJECT_PROGRESS_TIMELINE=1` runs the paged project scan + batch milestone reads before send | §0 guarantee 3 now explicitly scopes the "cannot delay" claim to AI narration only, and states the rule-based compute adds real, bounded (not unbounded) latency to the digest request. |

Verified correct by the reviewer, unchanged: fold-into-digest via the inner try/catch (test 8)
preserving dead-man semantics; the `/api/agent/` double-guard needing no `PUBLIC_API_PREFIXES`
entry; milestone gating behind `PROJECT_PROGRESS_TIMELINE`; data egress matching Phase 10's
boundary; no canonical write.

Test plan grew from 12 to 13 cases.

### Rev 1 — initial spec, 2026-07-07

Grounded in-repo: `src/lib/dashboard.ts`, `src/lib/agenda.ts`, `src/lib/project-milestones.ts` +
`project-milestones-batch.ts`, `src/lib/system-health.ts`, `src/app/api/cron/systems-monitor/route.ts`,
`workers/systems-monitor.ts`, `src/lib/email.ts`, `src/lib/studio-mcp.ts`,
`docs/studio-agent-access.md`, `docs/specs/phase-21-observability-alerting.md`,
`docs/specs/phase-15-pwa-mobile.md`. No code changed by this document.
