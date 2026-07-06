# Phase 10 — Intelligence + Forecasting (build-ready spec)

Status: spec → Fable review → build. Deploys **dark**. Moves ZERO money, writes ZERO
canonical business rows. Next migration number: **0090** (0089 applied).

This phase is **derived analytics** over data Phases 1–9a already persist. Every number is
recomputed at read time from the existing ledgers, projects, proposals, events, and bookings.
Nothing here is a new source of truth.

---

## 0. Scope boundary — what moves/writes nothing

**Reads only.** All Phase 10 code is pure `SELECT` + in-memory aggregation. It calls the
existing report builders and never a mutation:

- `getBookkeepingReport()` (`src/lib/bookkeeping.ts`) — net-of-refunds revenue/expense totals,
  already period-scoped and already treating `refunded` as settled (Fable 9a fixes baked in).
- `getPaymentLedgerReport()` / AR aging (`src/lib/sales.ts`) — scheduled vs paid, `openCents`,
  `clientPayableOpenCents`, `netCollectedCents`, aging buckets.
- `getAgentFinanceReport()` (`src/lib/agent-finance.ts`) — project-level rollups.
- `getAgenda()` (`src/lib/agenda.ts`) + `project_events` — event/session dates for seasonality.
- `projects`, `proposals`, `invoices`, `invoice_payments`, `scheduler_bookings`,
  `inbound_inquiries`, `clients.referralSource` — for conversion, package value, lead source.

**No agent-write to finance/canonical records.** The one new agent-facing surface
(`studio_get_business_review` MCP read tool) is read-only. There is **no** new agent write path.
The existing finance-write block (`requireTylerApprovalForAgentFinance`,
`src/lib/sales.ts:697`) is untouched and its guard test (`src/lib/agent-payment.test.ts`) still
holds. Phase 10 adds its own guard test asserting the new read tool leaves every canonical table
row-count unchanged for both a normal and a hostile argument set (§7).

**Persisted config is admin-only, guarded, never agent-written.** Forecast horizon, trailing
window, monthly capacity target, and (optional) lead-source taxonomy are stored as **nullable
columns on `app_settings`** with safe code defaults when `NULL` — the exact pattern 9a used for
`tax_set_aside_rate_percent` (`src/lib/tax.ts:32`). CRUD is a guarded admin route
(`guardDirectWorkerApiRequest`), mirroring `/api/finance/tax-settings`. Agents cannot reach it.

**Off-by-default where it changes runtime.** A new report page, a new CSV route, and a new
MCP **read** tool change nothing until deliberately opened/called → no flag needed. The **only**
always-on runtime change (an optional forecast tile injected into the main dashboard) ships
behind an OFF flag `INTELLIGENCE_DASHBOARD` with an observation window; the optional scheduled
weekly-review Worker ships un-wired behind `WEEKLY_REVIEW_CRON` (§6.6, §8).

---

## 1. Data inventory — capturable today vs gaps

| Signal | Source today | Sufficient? |
| --- | --- | --- |
| Monthly net revenue | `getBookkeepingReport({fromDate,toDate})` → `totals.netRevenueCents` (refunds/lost disputes already subtracted on money-event date) | ✅ yes |
| Contracted/pipeline inflow | `getPaymentLedgerReport()` rows: `openCents` / `clientPayableOpenCents` with `payment.dueDate` | ✅ yes |
| Inquiries | `projects` (stage `inquiry`/`proposal_sent`, `createdAt`) ∪ `scheduler_bookings.createdAt` ∪ `inbound_inquiries.receivedAt`, deduped by identity | ✅ yes (see §3.2 dedup) |
| Bookings (won) | `proposals.acceptedAt`/`signedAt` (status `accepted`) and/or project stage ≥ `retainer_paid` | ✅ yes |
| Package/contract value | `invoices.totalCents` for invoices whose proposal is accepted; fallback `proposals.totalCents` | ✅ yes (caveat §3.4) |
| Event/session dates (seasonality) | `project_events.eventDate` (types `wedding`/`engagement`/`portrait`/…); `projects.eventDate` | ✅ yes |
| **Lead source** | `clients.referralSource` — **free text, nullable, sparse, lives on client not project** | ⚠️ partial — needs read-time normalization + `unknown` bucket (§3.3) |
| **Ad/marketing spend (for true ROI)** | **not captured anywhere** | ❌ gap — MVP reports revenue-per-source, NOT ROI; optional spend capture deferred (§3.3, §4) |
| Capacity target / forecast horizon | not captured | ➕ additive admin settings (migration 0090, §5) |

**Decision:** lead source is captured *well enough* via `clients.referralSource` to report
revenue-by-source with an `unknown` bucket — **no new capture column is required for MVP**. True
ROI is impossible without spend data, so the metric is honestly named "lead-source performance
(revenue, no cost data)". An optional `lead_source_taxonomy_json` admin setting (0090) lets Tyler
map raw strings → canonical buckets and, later, attach per-source spend to unlock real ROI.

---

## 2. Metric integrity principles (apply to every metric)

1. **Explainable models only** — trailing means, run-rate, ratios, YoY seasonal index. No ML,
   no opaque smoothing.
2. **State the window and the formula** on the surface itself (page copy + CSV footer + MCP JSON
   `method` field), so a reader can reproduce the number by hand.
3. **Degrade gracefully + LABEL low confidence.** Every metric carries a `confidence` ∈
   `high | medium | low | insufficient_data` and a `dataPoints` count. Below a per-metric minimum
   (§3), the surface shows the honest fallback ("Contracted pipeline only — not enough history for
   a statistical forecast") and **never** an extrapolated hero number.
4. **Facts vs projections are visually separate.** The revenue forecast shows *Contracted*
   (scheduled payments due — facts) apart from *Projected* (statistical run-rate). They are never
   merged into a single unqualified figure.
5. **Reuse the settled-status-aware helpers.** Revenue comes only from `getBookkeepingReport`
   (which counts `paid`+`refunded` as settled and subtracts refunds on the money-event date) —
   Phase 10 must NOT write a fresh `status = 'paid'`-only revenue query (that re-introduces the
   9a "settled status enumeration" bug where a later refund retroactively deletes prior-period
   gross, or a `refunded` row is misread as open).

---

## 3. Metrics — exact definitions

Money in cents throughout. All month bucketing uses UTC `YYYY-MM` on the relevant date column.

### 3.1 Revenue forecast

**Two explicitly separated components; never one blended hero number.**

**(A) Contracted pipeline (facts).** For each month `m` in the horizon
`[thisMonth, thisMonth + H)`:
```
contractedCents[m] = Σ paymentLedger.rows[r].openCents
                     where r.payment.dueDate ∈ month m
                     and r.payment.status ∉ {paid, waived, refunded}
```
Source: `getPaymentLedgerReport({status:"all"})`. `openCents` already excludes settled/refunded.
Confidence: `high` (these are signed, scheduled receivables).

**(B) Statistical projection.**
```
trailingMonths      = settings.forecastTrailingMonths (default 6)
history[]           = for each of the last `trailingMonths` fully-elapsed months,
                      getBookkeepingReport(monthBounds).totals.netRevenueCents
baseRunRateCents    = mean(history)                         // trailing arithmetic mean
seasonalIndex[m]    = (only if ≥24 months history) monthAvg[calMonth(m)] / overallMonthlyAvg
projectedCents[m]   = round(baseRunRateCents × (seasonalIndex[m] ?? 1))
```
Horizon `H = settings.forecastHorizonMonths` (default 3).

**Cold-start / low-confidence:**
- `history.length == 0` → `confidence: insufficient_data`; emit **only** component (A); projection
  section shows "Not enough revenue history to project — showing contracted pipeline only."
- `1 ≤ history.length < 3` → `confidence: low`; show `baseRunRateCents` with a prominent
  "based on N month(s) — directional only" label; **no** seasonal adjustment.
- `3 ≤ history.length < 24` → `confidence: medium`; run-rate, no seasonal index.
- `≥24 months` → `confidence: high` for the seasonal-adjusted run-rate.
- Guard against wild extrapolation: `projectedCents[m]` is clamped to
  `[0, 4 × baseRunRateCents]`; a clamp event flips that month's confidence to `low` and sets a
  `note`.

Output per month: `{ month, contractedCents, projectedCents, confidence, note }` plus a
`method` string.

### 3.2 Booking-conversion rate

**Denominator (inquiries).** Reuse the existing identity dedup from `getDashboardMetrics`
(`src/lib/dashboard.ts:383`, `inquiryIdentity`): key = `project:<id>` ‖ `client:<id>` ‖
`email:<lower(email)>` ‖ `booking:<id>` fallback. An inquiry cohort for window `W` =
distinct identities whose **first touch** falls in `W`, drawn from:
- `projects` created in `W` with stage ∈ {`inquiry`,`proposal_sent`} (or any stage — a project
  that jumped straight to booked still had an inquiry moment; include all projects created in `W`
  and classify by outcome),
- `scheduler_bookings` created in `W` (discovery/consult calls),
- `inbound_inquiries` received in `W` with status ∉ {`spam`,`dismissed`} (8a staging — count the
  human inquiry, exclude spam).

Dedup across all three by identity so one couple emailing + booking a call + becoming a project
counts **once**.

**Numerator (booked).** An inquiry identity is `booked` if its project reached a booked
milestone: `proposals.status = 'accepted'` (has `acceptedAt`/`signedAt`) **OR** project stage ∈
{`retainer_paid`,`planning`,`editing`,`delivered`,`completed`} (the `RETAINER_STAGE_PRECEDENCE`
ranks in `src/lib/sales.ts:92`). Booked date = `acceptedAt` (fallback: first retainer `paidAt`).

**Two reported figures (label both honestly):**
1. **Cohort conversion** (primary): of inquiries first-touched in `W`, the % booked *to date*.
   Carries a **lag caveat** — recent cohorts are still maturing, so the last N weeks are marked
   `still maturing` and excluded from the headline rate.
2. **Period run-rate ratio** (secondary, labeled approximate):
   `bookings dated in W / inquiries first-touched in W` — fast but mixes cohorts.

**Cold-start:** `< 5` inquiries in the window → `confidence: low` and show raw counts
(`3 of 4 booked`) instead of a percentage (a 25%→50% swing on one booking is noise).
`0` inquiries → `insufficient_data`, suppress the rate.

### 3.3 Lead-source performance (NOT ROI)

**Honest naming.** No spend data exists, so this reports **revenue and booked-count per source**,
never a return-on-investment multiple. The page/CSV/MCP `method` states this in one line.

**Attribution.** A project's source = its primary contact's `clients.referralSource`
(primary participant per `projectParticipants.isPrimaryContact`). Normalize:
```
raw = trim(referralSource)
bucket = taxonomy[lower(raw)] ?? titleCaseKnown(raw) ?? raw
if !raw → bucket = "Unknown"
```
`taxonomy` comes from `settings.leadSourceTaxonomyJson` (optional; default `{}` → identity map).
Blank/null always lands in the explicit **`Unknown`** bucket (never silently dropped).

**Per bucket:** `{ source, projectCount, bookedCount, netRevenueCents, avgPackageValueCents }`.
- `netRevenueCents` = Σ over that source's projects of the project's collected net
  (`projectFinancials[p].netDepositCents − paidExpenseCents`, from `getAgentFinanceReport`), so it
  reconciles with the finance report and respects refunds.
- Sorted by `netRevenueCents` desc; `Unknown` always rendered (even at 0) so sparsity is visible.

**Cold-start / sparsity:** buckets with `projectCount < 3` are grouped-visible but flagged
`sparse` (one big wedding shouldn't crown a source). If `Unknown` ≥ 50% of projects, surface a
banner: "Lead source is unknown for N of M projects — capture referral source to improve this
report." (Actionable, not a fake number.)

**Optional future ROI:** if a bucket in `leadSourceTaxonomyJson` carries `spendCents`, additionally
emit `roi = netRevenueCents / spendCents` for that bucket only, labeled. MVP ships taxonomy with
label-mapping only; spend is a later admin follow-up (no code change needed beyond reading the
field).

### 3.4 Average-package-value trend

**Booked value source (canonical):** `invoices.totalCents` for invoices whose `proposalId`
resolves to a proposal with `status = 'accepted'`, bucketed by `proposals.acceptedAt` month.
Rationale: `syncUnpaidProposalInvoicesToAcceptedTotal` (`src/lib/sales.ts:229`) keeps the invoice
total equal to the accepted proposal total including selected optionals, so the invoice total is
the truest "what they actually booked". **Fallback** when no linked invoice: `proposals.totalCents`
(note: may predate optional-line-item selection — flag such rows `estimated`).

```
avgPackageValueCents[month] = mean(bookedContractCents for proposals accepted in month)
trend = series over trailing `settings.forecastTrailingMonths` booking months (default 6),
        plus a simple first-vs-last delta and % change
```
Exclude declined/expired proposals. Dedup: one proposal = one booked value (if a project has two
accepted proposals, count both as separate bookings — rare, but correct).

**Cold-start:** a month with `< 2` bookings shows the raw value(s), not a "mean", and is marked
`thin`. `< 3` total booked proposals across the window → `confidence: low`, suppress the % trend,
show the raw list.

### 3.5 Seasonal capacity

**Shootable events per month** (calls are not shoots — exclude `scheduler_bookings`; use
`project_events` + `projects.eventDate`):
```
eventsByMonth[YYYY-MM] = count of project_events with eventDate in that month
                         and type ∈ {wedding, engagement, portrait, other-non-call}
```
**Seasonal index (YoY):** requires `≥2` calendar years of event history:
```
calMonthAvg[1..12] = mean events in that calendar month across years with data
seasonalIndex[month] = calMonthAvg[month] / mean(calMonthAvg[1..12])
```
**Utilization vs target:** if `settings.monthlyCapacityTarget` is set,
`utilization[m] = eventsByMonth[m] / target`; flag months `> 1.0` as `over capacity` and the
seasonal peak months as `plan ahead`.

**Cold-start:** `< 2 years` of events → `confidence: insufficient_data` for the *index*; show raw
monthly counts + a note "Not enough history for a seasonal index (need 2+ years)." No target set →
show counts without utilization.

---

## 4. Weekly "state of the business" review

**Agent-drafted, read-only, never auto-acting** — follows the standing "agents draft, Tyler acts"
guard.

- **Primary (MVP): on-demand MCP read tool `studio_get_business_review`.** Returns the structured
  output of §3 for a requested period (default: trailing 30 days + current-quarter context) plus a
  compact `headlines[]` array (e.g. "Net revenue $X, N% vs prior period", "Conversion 3 of 5",
  "Peak season May–Oct"). The **agent composes the prose narrative** from this JSON; the tool never
  returns a canned "sent" artifact and never writes anything. This is exactly parallel to
  `studio_get_finance_report` (`src/lib/studio-mcp.ts:2432`).
- The agent may, if Tyler asks, save its drafted narrative via the **existing** draft-only paths
  (`studio_create_agent_task` or `studio_create_project_source`) — those are already guarded,
  human-reviewed, and non-sending. Phase 10 adds no new write path for the review.
- **Optional follow-up (deferred, dark): scheduled weekly Worker.** If Tyler later wants an
  unprompted Monday draft, add a cron route `POST /api/cron/weekly-review` that ONLY drafts an
  `agent_task` ("Review last week's numbers") — it **never sends** a client message and never
  mutates finance. It ships **off** (`WEEKLY_REVIEW_CRON` unset → route returns 503, like
  scheduler-reminders on an unset secret) and its cron is not wired until Tyler opts in. Cron rules
  (from the Active-Learning Log): bearer-authed with constant-time compare (reuse
  `src/app/api/cron/scheduler-reminders/route.ts` pattern), the caller hits the **workers.dev
  origin** (not the Pages proxy), uses `redirect: "manual"`, and treats any 3xx/opaqueredirect as
  failure (fail-loud). MVP does **not** build this; it is specced so the builder does not invent a
  send path.

---

## 5. Data-model + migration 0090

**No new business tables.** Only additive, nullable **admin settings** columns on `app_settings`,
mirroring the 9a tax-settings pattern (nullable, safe code defaults when `NULL`).

`migrations/0090_intelligence_forecasting.sql`:
```sql
-- Phase 10 — intelligence/forecasting admin settings. Additive + idempotent.
-- Reports-only; safe code defaults apply when NULL. app_settings is read on
-- always-on paths, so this migration is DEPLOY-ORDER-CRITICAL (apply before Worker).
ALTER TABLE app_settings ADD COLUMN forecast_horizon_months INTEGER;      -- code default 3
ALTER TABLE app_settings ADD COLUMN forecast_trailing_months INTEGER;     -- code default 6
ALTER TABLE app_settings ADD COLUMN monthly_capacity_target INTEGER;      -- code default NULL (no target)
ALTER TABLE app_settings ADD COLUMN lead_source_taxonomy_json TEXT;       -- code default '{}' (identity map)
```

Mirror into **all four** places (drift guard):
1. `src/db/schema.ts` — add the four columns to `appSettings` (nullable `integer`/`text`).
2. `src/db/studio-canon.test.ts` — add a `columnNames("app_settings")` assertion block for the
   four columns (matches the existing 9a block at lines 900–906).
3. `src/db/client.ts` dev migrate — four `addColumnIfMissing(database, "app_settings", …)` calls
   in the 0090 section (helper at `src/db/client.ts:23`; identical to the 0089 calls at 746–752).
4. The migration file above.

**No new canon triggers required** — the columns are clamped in code (`clampPositiveInt`-style,
reuse from `src/lib/tax.ts:46`); `lead_source_taxonomy_json` is JSON-parsed defensively
(try/catch → `{}` on parse failure). Keeping 0090 to `ALTER ADD COLUMN` only keeps it additive +
idempotent (`addColumnIfMissing` swallows `duplicate column name`).

**Why deploy-order-critical:** `app_settings` is read via `db.query.appSettings.findFirst`
(`src/lib/tax.ts:33`, `src/lib/settings.ts`), which drizzle compiles to an explicit column list.
Once `schema.ts` names the new columns, that SELECT references them — if the Worker deploys before
prod has the columns, **every settings read 500s**. Therefore: apply 0090 to prod D1 first, verify
the four columns via `PRAGMA table_info(app_settings)`, sanity-check a settings read, **then**
deploy the Worker (Active-Learning "migration ordering" rule).

---

## 6. Surfaces

### 6.1 `src/lib/intelligence.ts` (new, read-only)

Pure functions, each returning `{ ...data, method, confidence, dataPoints }`:
```
getRevenueForecast(input)      → §3.1
getConversionReport(input)     → §3.2
getLeadSourcePerformance(input)→ §3.3
getPackageValueTrend(input)    → §3.4
getSeasonalCapacity(input)     → §3.5
getBusinessReview(input)       → aggregates the above + headlines[] (§4)
getIntelligenceSettings()      → reads app_settings, applies safe defaults
```
Plus CSV builders (`csvCell`/`centsCsv` copied from `bookkeeping.ts:667`):
`revenueForecastCsv`, `conversionCsv`, `leadSourceCsv`, `packageValueCsv`, `seasonalCapacityCsv`.
**No exported mutation.** No `db.insert/update/delete`. (Enforced by grep test, §7.)

`updateIntelligenceSettings(input)` lives here too but is **admin-only** (called solely by the
guarded route in §6.4) and writes **only** the four `app_settings` columns — never a business row.

### 6.2 Admin report page `src/app/finance/intelligence/page.tsx`

`export const dynamic = "force-dynamic"`. Rendered inside `AppShell`, reachable through the
existing admin Pages-proxy exactly like `/finance` and `/finance/tax` — **no new public path, no
origin-guard/admin-proof change** (pre-empts the proxy-composition pitfall). Sections: Revenue
forecast (contracted vs projected split), Conversion, Lead-source performance, Package-value trend,
Seasonal capacity, and an admin "Intelligence settings" form (horizon/trailing/capacity/taxonomy)
posting to §6.4. Each metric renders its `confidence` badge + `method` caption. Charts optional
(sparkline/bar); if drawn, follow the dataviz skill and keep them theme-aware — but the numbers +
labels must stand alone without the chart.

Add a link from `/finance` and `/finance/tax` nav.

### 6.3 CSV routes `src/app/api/finance/*.csv/route.ts`

One route per metric (mirrors `tax-estimate.csv/route.ts` exactly):
`revenue-forecast.csv`, `conversion.csv`, `lead-source.csv`, `package-value.csv`,
`seasonal-capacity.csv`. Each:
```ts
const blocked = guardDirectWorkerApiRequest(request);
if (blocked) return blocked;
// parse period from query, call lib, return text/csv attachment
```
Guarded identically to every existing finance CSV — no bypass list entry, no new public
classifier.

### 6.4 Admin settings route `src/app/api/finance/intelligence-settings/route.ts`

`POST`, `guardDirectWorkerApiRequest` first (copy `mileage/route.ts`), parse form, call
`updateIntelligenceSettings`, `303 → /finance/intelligence?saved=settings`. Agents cannot reach
it (admin-guarded, not in the MCP tool list).

### 6.5 MCP read tool `studio_get_business_review`

Add to `studioTools` (schema: optional `fromDate`,`toDate`,`asOfDate`) and to the dispatch block
next to `studio_get_finance_report` (`src/lib/studio-mcp.ts:2432`):
```ts
if (name === "studio_get_business_review") {
  const review = await getBusinessReview({ /* optional dates */ });
  return textToolResult({ review });
}
```
Read-only; returns §4 JSON. **No** write tool is added.

### 6.6 Optional dashboard tile (flag-gated OFF)

If a forecast/conversion tile is injected into the main dashboard (an always-on runtime change),
it is gated behind `INTELLIGENCE_DASHBOARD` (default off → tile not rendered). Ships off; Tyler
flips after an observation window. MVP may skip the tile entirely; if built, it must be off.

---

## 7. Guard / no-agent-write test plan

`src/lib/intelligence-guard.test.ts` (tsx):
1. Seed a temp DB (`DATABASE_PATH` tmp, `rawDb()` pattern from `agent-payment.test.ts`) with a
   project, client, accepted proposal, invoice, paid payment, event, booking, inbound inquiry.
2. Snapshot `SELECT count(*)` for **every** canonical table (projects, clients,
   project_participants, proposals, proposal_line_items, invoices, invoice_payments,
   scheduler_bookings, expenses, vendors, project_events, activity_logs, inbound_inquiries,
   payment_refunds, payment_disputes, mileage_logs).
3. Call `getBusinessReview()`, every `get*` in `intelligence.ts`, and the MCP dispatch for
   `studio_get_business_review` with (a) a normal args object and (b) a **hostile** args object
   (`{ projectId:"x'; DROP", fromDate:"'; DELETE FROM projects; --", toDate:{}, extra:"…" }`).
4. Assert **all** row counts are byte-for-byte unchanged and no `activity_logs` row was written.
5. Assert `intelligence.ts` source contains no `db.insert(`/`db.update(`/`db.delete(` outside the
   admin-only `updateIntelligenceSettings` (grep-in-test), and that `updateIntelligenceSettings`
   touches only `app_settings` (assert the four columns changed and every business table count is
   unchanged).
6. Assert the existing finance-write block still throws (re-run one `recordInvoicePaymentFromAgent`
   rejection) so Phase 10 didn't loosen it.

`src/db/studio-canon.test.ts`: add the four `app_settings` column assertions (§5).

---

## 8. Test plan (tsx + build-exit-code gate)

`src/lib/intelligence.test.ts` — formula + honesty unit tests:
- **Cold-start labeling**: 0 / 1 / 3 / 24+ months history → correct `confidence`
  (`insufficient_data`/`low`/`medium`/`high`) and that `< 3` months emits contracted-only.
- **Extrapolation clamp**: a spiky trailing month cannot push `projectedCents` above `4×` run-rate;
  clamp flips confidence `low`.
- **Refund honesty**: a refund in the trailing window lowers `netRevenueCents` on the money-event
  month, not the original month; forecast uses the net series (asserts we did NOT use a paid-only
  query).
- **Conversion dedup**: one couple as project + booking + inbound inquiry counts once; spam
  inbound excluded; `< 5` inquiries → counts not percentage; cohort lag marks recent weeks
  `still maturing`.
- **Lead-source**: null/blank `referralSource` → `Unknown` bucket; taxonomy maps raw→canonical;
  `Unknown ≥ 50%` sets the banner flag; revenue reconciles with `getAgentFinanceReport`.
- **Package value**: accepted-invoice total preferred over `proposals.totalCents`; `< 2`
  bookings/month marked `thin`; declined/expired excluded.
- **Seasonal**: `< 2 years` → index `insufficient_data`, raw counts shown; utilization only when
  target set; calls excluded.
- **CSV**: header/row shape, cents formatting, `method`/`confidence` present in footer.

Existing suites must stay green: `bookkeeping.test.ts`, `dashboard-metrics.test.ts`,
`agent-payment.test.ts`, `studio-canon.test.ts`, `src/app/api/mcp/route.test.ts`.

**Gates:** `npm run lint`; `npm run build` and check the **exit code** (a type error prints after
"Compiled successfully" and exits 1 — tsx tests don't type-check). In `intelligence.ts` read env
in the function body, never a `{…}=process.env` default param (TS2559). Run the tsx tests.

---

## 9. Dark rollout plan

1. **Migrate first (deploy-order-critical).** Apply `0090` to prod D1 via idempotent
   `d1 execute --file` (or the `addColumnIfMissing` path) — **not** a blanket
   `migrations apply --remote` (tracker is out of sync; would error on existing tables). Verify
   `PRAGMA table_info(app_settings)` shows the four columns and a settings read succeeds.
2. **Backup + capture rollback.** Real D1 backup; record current Worker version.
3. **Deploy Worker + Pages-proxy.** Report page, CSV routes, settings route, MCP read tool ship —
   all inert until opened/called. `INTELLIGENCE_DASHBOARD` unset (tile off). `WEEKLY_REVIEW_CRON`
   unset (cron route 503, not wired).
4. **Health-check.** `/finance/intelligence` 200 through the admin proxy; a CSV route returns
   `text/csv`; a direct `*.workers.dev` hit to a CSV route is blocked by `guardDirectWorkerApiRequest`;
   `/finance` and `/finance/tax` unchanged; security headers/redirects intact. Auto-rollback on
   failure.
5. **Enablement (Tyler, non-autonomous):** enter forecast horizon/trailing/capacity + lead-source
   taxonomy; optionally flip `INTELLIGENCE_DASHBOARD` after an observation window; optionally wire
   `WEEKLY_REVIEW_CRON` + cron schedule. All queued to Tyler with a runbook.

Reversibility: revert = redeploy prior Worker (page/routes/tool vanish); the additive nullable
columns are harmless if left. No data migration to undo.

---

## 10. Active-Learning Log — explicit pre-emption

| Pitfall | How Phase 10 avoids it |
| --- | --- |
| Build gate = exit code | CI checks `npm run build` exit code; tsx tests don't type-check. |
| `env={}=process.env` TS2559 | Read env in body; no weak-type default params. |
| Off-by-default for runtime change | Page/CSV/MCP-read need no flag (inert); dashboard tile `INTELLIGENCE_DASHBOARD` off; weekly cron `WEEKLY_REVIEW_CRON` off. |
| Unawaited promises canceled | N/A — pure reads, no deferred side-effects. (If weekly cron is later built, its work is synchronous within the request; no post-response side-effects.) |
| Constant-time secret compare | Weekly cron (if built) reuses `timingSafeEqual` byte-compare from scheduler-reminders. |
| D1 has no usable transaction | Phase 10 writes nothing at request time except the admin settings route, which is a single `UPDATE app_settings` (no multi-write flow, no `db.transaction`). |
| Settled-status enumeration | Revenue only via `getBookkeepingReport` (counts `paid`+`refunded` settled, subtracts refunds on money-event date). No new `status='paid'`-only revenue query. Conversion/forecast reuse the shared settled predicates. |
| Prod D1 migration drift | 0090 applied via idempotent `ALTER ADD COLUMN` / `addColumnIfMissing`, not blanket apply. Tracker reconciled separately. |
| Migration ordering (always-on read) | `app_settings` is always-on read → apply 0090 to prod, verify columns, THEN deploy Worker. |
| Proxy composition (REJECT-class) | No new public path; report page + CSV routes ride the existing admin proxy/admin-proof exactly like `/finance`+`tax-estimate.csv`. No origin-guard bypass entry. |
| Machine-client redirect trap | Only relevant if the weekly cron is built → it uses `redirect:"manual"`, hits workers.dev origin, treats 3xx as failure, fails loud. MVP doesn't build it. |
| Agent authority / no canonical write | New agent surface is a single read tool; guard test asserts zero canonical rows written for normal + hostile args, finance-write block re-verified. |
| Secrets fail closed | Weekly cron (if built) returns 503 on unset secret (scheduler-reminders pattern). |
| Sparse-data honesty | Every metric carries `confidence` + `dataPoints`; below minima it shows the honest fallback and never an extrapolated hero number; forecast clamps to `4×` run-rate. |

---

## 11. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration 0090 + mirror into schema.ts, studio-canon.test.ts, client.ts | S | Low (additive nullable; deploy-order noted) |
| 2 | `getIntelligenceSettings` + `updateIntelligenceSettings` (safe defaults, clamps, JSON parse guard) | S | Low |
| 3 | `getRevenueForecast` (contracted vs projected split, cold-start, clamp) | M | Med (forecast honesty is the review focus) |
| 4 | `getConversionReport` (identity dedup, cohort vs run-rate, lag caveat) | M | Med (denominator correctness) |
| 5 | `getLeadSourcePerformance` (attribution, Unknown bucket, sparsity banner) | M | Med (attribution + honest naming) |
| 6 | `getPackageValueTrend` (accepted-invoice total, thin-month handling) | S–M | Low–Med |
| 7 | `getSeasonalCapacity` (YoY index, utilization, calls excluded) | S–M | Low–Med |
| 8 | `getBusinessReview` aggregator + `headlines[]` | S | Low |
| 9 | CSV builders + 5 guarded CSV routes | S | Low |
| 10 | Admin report page + settings form + nav links | M | Low–Med (UI) |
| 11 | MCP `studio_get_business_review` tool + dispatch | S | Low |
| 12 | Guard test (`intelligence-guard.test.ts`) + unit tests (`intelligence.test.ts`) | M | Med (the correctness net) |
| 13 | (Optional, deferred) dashboard tile behind `INTELLIGENCE_DASHBOARD` off | S | Low |
| 14 | (Optional, deferred/dark) weekly-review cron Worker, off | M | Med (send-path temptation — draft-only) |

Build order: 1 → 2 → 3–8 (metrics) → 9–11 (surfaces) → 12 (tests) → deploy dark. 13–14 are
post-MVP, flag-off.
```
