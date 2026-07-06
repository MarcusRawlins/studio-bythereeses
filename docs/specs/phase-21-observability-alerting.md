# Phase 21 — Observability + failure alerting

Status: spec (build-ready). No code in this document.
Scope owner: autonomous build loop. Enablement: **Tyler** (flag flip + alert email + cron schedule).

---

## 0. Why this exists (the motivating failure)

The `reese-scheduler-reminders` cron pointed at the login-walled proxy host
(`studio.bythereeses.com/api/cron/*`), which answered `303 → /admin/login → 200`.
The worker used `redirect: "follow"` + `res.ok`, so it read that `200` login **page** as
success. Every hourly run "succeeded" and sent **nothing** for ~2 months. Nobody knew until
a code review found it. (The worker is now fixed — `workers/scheduler-reminders.ts` uses
`redirect: "manual"` and throws on any non-2xx/opaqueredirect. `workers/sequence-runner.ts`
mirrors that fix.)

That fix makes *this one job* fail loud **in Cloudflare's Worker logs**. But:

- Tyler does not watch Worker logs. A `scheduled()` throw is invisible unless someone looks.
- The CRM runs **many** autonomous background jobs (two crons, four webhook handlers, an
  inbound-email endpoint, the sequence auto-send path) plus money-critical reconciliation
  queues. A solo owner cannot be confident in systems he cannot see fail.

**Goal:** a silent failure surfaces to Tyler **within a day**, not two months. This is a
pragmatic owner-scale heartbeat + daily digest + immediate critical alert — **not** an APM.

**Hard scope guarantees (non-negotiable):**

1. Adds **no new attack surface** and **moves no money**. It only: (a) writes non-canonical
   heartbeat rows, (b) READS existing health signals, (c) emails **Tyler's own address**.
2. Every runtime-changing piece is **off by default**; the digest cron ships **un-wired**
   until Tyler sets the alert email + schedule (enablement step).
3. Monitoring never mutates a canonical row. A guard test asserts it (mirrors the
   `sequences`/`inbound-inquiry` zero-canonical-write guard tests).

---

## 1. Health-signal catalog

Each signal has a **source** (already in the codebase), a **healthy** definition, a
**stale/failed threshold**, and a **severity**. Severities: `CRITICAL` = immediate email
(don't wait for the daily digest); `WARN` = rolled into the daily digest; `INFO` = shown on
the health page, not alerted.

### Scheduled jobs (cadence-based → staleness is the signal)

| Signal | Source | Cadence | Healthy | Threshold | Severity |
|---|---|---|---|---|---|
| Reminders cron ran + succeeded **and actually sent what was due** | heartbeat `job_runs['scheduler-reminders']`, written by `POST /api/cron/scheduler-reminders` (`sendDueSchedulerReminders` → `{checked, due, sent, failed}`) | hourly (`0 * * * *`, `wrangler.scheduler-reminders.jsonc`) | `last_success_at` within ~2h **and** not a "due>0, sent=0" run (that is recorded as FAILURE, §2.3); transient `failed>0 && sent>0` → WARN only | > 2h stale → WARN; > 6h stale → **CRITICAL**; `due>0 && sent===0` recorded FAILURE → escalates via `consecutive_failures` | **CRITICAL** (this is the job that silently died — staleness **and** silent-non-send both count) |
| Sequence runner ran + succeeded | heartbeat `job_runs['sequence-runner']`, written by `POST /api/cron/sequences` (`runDueSequences`) | daily 14:00 UTC (`0 14 * * *`, `wrangler.sequence-runner.jsonc`) | `last_success_at` within ~26h. Note: `{skipped:'flag_off'}` is a **successful run** — record `ok:true` | > 26h stale → WARN; > 50h stale → CRITICAL | WARN (daily granularity; escalates to CRITICAL when very stale) |
| Systems monitor itself ran | heartbeat `job_runs['systems-monitor']` (self-write) + the **dead-man's-switch** (§4.3) | hourly | ran within ~2h | > 2h stale (visible only from outside — see §4.3) | CRITICAL (external) |

**Required-cadence jobs — a missing `job_runs` row is a maximally-stale signal, not green.**
The three rows above (`scheduler-reminders`, `sequence-runner`, `systems-monitor`) are the
**REQUIRED set**: they are supposed to run on a fixed schedule from the moment they are enabled. For
these, `computeSystemHealth` treats **a missing row OR a NULL `last_success_at` exactly like a
maximally-stale `last_success_at`** — it clocks staleness from the job's **deploy/enablement
timestamp** (a small config constant per job, set when the cron is wired) and applies the *same*
WARN→CRITICAL thresholds. This closes the exact target failure class: a cron whose trigger is broken
from day one, or a table wipe/restore that drops the heartbeat row, must **not** render green just
because there is no row to read. (Only `backup-d1` had missing-row semantics before; this generalizes
it to the required crons with the opposite default — absent = stale, not absent = not-configured.)

**Event-driven jobs default the other way.** The webhook/inbound handlers below and the backup
heartbeat are **NOT** in the required set: they only run when an external event arrives (or when Tyler
wires backup), so a missing row is genuinely `not-configured` (INFO), never a stale/failed alarm. See
§4.1 for where this branch lives and §8 test 2 for the missing-row unit test.

### Webhook / inbound handlers (event-driven → error-rate is the signal, NOT staleness)

Staleness is meaningless here: no Stripe events for a week is normal (no payments), and SMS
webhooks only fire when `SMS_ENABLED=1`. The signal is **repeated failures**.

| Signal | Source | Healthy | Threshold | Severity |
|---|---|---|---|---|
| Stripe webhook errors | `job_runs['stripe-webhook']` written by `POST /api/stripe/webhook` (`handleStripeCheckoutWebhook`). Existing `stripe_webhook_events` table already records *received* events | last call `ok` | `consecutive_failures ≥ 3` → **CRITICAL** (settle/refund/dispute not landing = money state drift) | CRITICAL |
| Twilio status webhook errors | `job_runs['twilio-status']` written by `POST /api/twilio/status` | last call `ok` | `consecutive_failures ≥ 5` → WARN | WARN |
| Twilio inbound webhook errors | `job_runs['twilio-inbound']` written by `POST /api/twilio/inbound` | last call `ok` | `consecutive_failures ≥ 5` → WARN | WARN |
| Inbound inquiry-email errors | `job_runs['inbound-inquiry']` written by `POST /api/inbound/inquiry-email` (`ingestInboundInquiry`) | last call `ok` (the worker forwards-to-human on failure, so leads aren't lost, but repeated failures mean the pipeline is down) | `consecutive_failures ≥ 3` → WARN | WARN |

### Reconciliation queues + send failures (computed live from existing queries — no heartbeat)

| Signal | Source (existing) | Healthy | Threshold | Severity |
|---|---|---|---|---|
| Refund stuck in-flight | `getRefundInitiationReconciliation().stuckSubmitting` (`stripe-refund-initiation.ts`, `submitting` > 1h) | zero rows | ≥ 1 row → **CRITICAL** (money may have left the bank; §4.4 tripwire) | CRITICAL |
| Initiated refund not recorded | `getRefundInitiationReconciliation().initiatedNotRecorded` (`succeeded` > 24h, no matching `payment_refunds`) | zero rows | ≥ 1 row → WARN (webhook never landed) | WARN |
| Payments needing reconciliation | `buildReconciliationSummary` / `getFinanceReport().reconciliation.paymentCount` (`agent-finance.ts`; `paymentLedgerNeedsReconciliation` in `sales.ts` — missing evidence / over-cap / open dispute) | count 0 | count > 0 → WARN | WARN |
| Sequence sends stuck | `sequence_sends` rows `status='claimed'` older than one run interval (already surfaced as `sequence.send_stuck` activity by `surfaceStuckSends`) | 0 | > 0 → WARN | WARN |
| Sequence sends failed | `sequence_sends` rows `status='failed'` (provably-not-sent, retry-exhausted) | 0 | count > 0 → WARN | WARN |
| SMS delivery failures | `project_communications.delivery_status` in Twilio failure states (`failed`/`undelivered`), written by `handleStatusCallback` | 0 recent | count > 0 in trailing window → WARN | WARN |

### Backup (runs on Tyler's Mac via launchd, not on Cloudflare)

| Signal | Source | Healthy | Threshold | Severity |
|---|---|---|---|---|
| D1 backup freshness | `job_runs['backup-d1']` — written by the backup script POSTing the **heartbeat endpoint** (§3.4). **Optional** enablement; a job with no heartbeat row renders `not-configured` (INFO), never a false alarm | `last_success_at` within ~36h (matches the existing `deploy:preflight` `<=36h` D1 check) | > 36h stale → WARN | WARN |

Backup runtime monitoring stays **out of scope** unless Tyler wires the backup heartbeat.
The authoritative backup gate remains `deploy:preflight` + the quarterly `drill:restore`
(`docs/ops-stabilization-checklist.md`). This phase does not duplicate them; it optionally
*surfaces* backup freshness in the same digest.

---

## 2. Heartbeat mechanism (the source of truth the digest reads)

**Decision: in-DB heartbeat, not Cloudflare Workers Analytics.** Workers logs/analytics are
not queryable from the app, not owned by Tyler, and cannot express "reminders succeeded but
sent nothing." A D1 table that each job writes on every run (success **or** failure) is
queryable, owned, and is exactly what the digest and `/api/agent/health` read.

### 2.1 `job_runs` table (current-state, one row per job, upserted)

```
job_runs
  job_name              TEXT PRIMARY KEY   -- 'scheduler-reminders' | 'sequence-runner' | 'stripe-webhook' | ...
  last_run_at           TEXT               -- ISO; set on every call (ok or fail)
  last_success_at       TEXT               -- ISO; set only on ok  → staleness is computed from this
  last_status           TEXT               -- 'ok' | 'error'
  last_error            TEXT               -- cleaned, capped (≤500) message; NULL on ok
  consecutive_failures  INTEGER NOT NULL DEFAULT 0
  updated_at            TEXT NOT NULL
```

Current-state (not append-only history): the digest only needs "when did each job last
succeed / is it currently failing." Per-event history already exists in `activity_logs`
(e.g. `sequence.send_stuck`) and in `stripe_webhook_events`. Owner-scale — no history table.

### 2.2 `recordJobRun(name, ok, error?)` — the tiny shared helper

New module `src/lib/job-runs.ts`. One D1-safe **upsert** (`INSERT ... ON CONFLICT(job_name)
DO UPDATE`) — no `db.transaction()` / `db.batch()` (Active-Learning Log: D1 rejects
transactions at runtime).

```
recordJobRun(name, ok=true, error?):
  now = ISO
  on ok:    INSERT (name, last_run_at=now, last_success_at=now, last_status='ok',
                    last_error=NULL, consecutive_failures=0, updated_at=now)
            ON CONFLICT(job_name) DO UPDATE SET
                    last_run_at=now, last_success_at=now, last_status='ok',
                    last_error=NULL, consecutive_failures=0, updated_at=now
  on fail:  INSERT (name, last_run_at=now, last_status='error',
                    last_error=cap(error,500), consecutive_failures=1, updated_at=now)
            ON CONFLICT(job_name) DO UPDATE SET
                    last_run_at=now, last_status='error', last_error=cap(error,500),
                    consecutive_failures = job_runs.consecutive_failures + 1, updated_at=now
```

Rules:
- **Never throws into the monitored job.** Wrap the write in `try/catch` that swallows (like
  `logActivity`'s audit-fail swallow). If the heartbeat write itself fails, `last_success_at`
  simply stops advancing → the job reads as **stale** → the digest alerts. That is the correct
  fail-toward-visible behavior (the monitor failing is itself surfaced).
- **Recording a failure must NOT convert a failure into success.** In each caller, record the
  outcome and then **preserve the original HTTP status / re-raise** so the fixed fail-loud
  crons still return non-2xx and the cron worker still throws. Monitoring is additive; it never
  masks the failure it observes.
- **`error` is a cleaned message, never a raw secret — and `recordJobRun` re-sanitizes it
  itself, never trusting the caller.** Callers pass the same already-cleaned message they log
  today (e.g. `stripeErrorMessage(...)`), but the secret-redaction + ≤500-char cap runs
  **inside `recordJobRun`** as a defense-in-depth backstop (a future careless caller cannot
  land a raw secret or an unbounded blob in `last_error`). `last_error` feeds the digest, so it
  must not carry secrets (see the secret-redaction test, §7).
- No agent/MCP export. `recordJobRun` is imported only by the job entry points below.

### 2.3 Which jobs call it, and exactly where

Call at the **end** of the job, after the real work commits (Active-Learning Log: write the
audit/dedupe row LAST) — `await` it before returning (unawaited post-response promises are
canceled on Workers).

| Caller (file) | ok call | fail call |
|---|---|---|
| `src/app/api/cron/scheduler-reminders/route.ts` | after `sendDueSchedulerReminders()` resolves — **but see the "ran but sent nothing" rule below**: record FAILURE (not ok) when `due > 0 && sent === 0` | `try/catch` around it → record fail, then return 500 (unchanged fail-loud) |
| `src/app/api/cron/sequences/route.ts` | after `runDueSequences()` (incl. `{skipped:'flag_off'}` = ok) | `try/catch` → record fail, re-raise |
| `src/app/api/stripe/webhook/route.ts` | in the success branch before `NextResponse.json({received:true})` | **only for errors raised AFTER signature verification succeeds** (see the signature-reject carve-out below) |
| `src/app/api/twilio/status/route.ts` | before `twiml(200)` | in the `catch` around `handleStatusCallback` before the 500 (already after the 403 signature gate — correct) |
| `src/app/api/twilio/inbound/route.ts` | on success | on handled failure (already after the 403 signature gate — correct) |
| `src/app/api/inbound/inquiry-email/route.ts` | after `ingestInboundInquiry` resolves | in the `catch` before the 500 |

**Stripe signature-reject carve-out (do NOT poison the CRITICAL counter).**
`/api/stripe/webhook` is in origin-guard `PUBLIC_API_PREFIXES` (`origin-guard.ts:24`), so on
`*.workers.dev` it is reachable **unauthenticated** by any scanner. `handleStripeCheckoutWebhook`
calls `verifyStripeWebhookPayload({ rawBody, signatureHeader })` **first** (`stripe-checkout.ts:693`),
which **throws** on a missing/invalid signature; the route's single `catch` then returns `400`
(`route.ts:9-15`). If that catch recorded a webhook FAILURE, three junk POSTs from any scanner
would push `consecutive_failures ≥ 3` and fire the CRITICAL "money state drift" email —
attacker-triggerable griefing + cry-wolf.

Therefore the stripe wiring **must not** treat a pre-verification reject as a monitored failure.
Implement one of:
- **Split the try** so `verifyStripeWebhookPayload` runs *before* the recorded region: a throw from
  verification returns `400` **unrecorded** (or recorded under a separate, **non-alerting** key such
  as `stripe-webhook-rejected` that is NOT in the CRITICAL catalog); only a throw from *processing a
  successfully-verified event* records a `stripe-webhook` FAILURE.
- **Or classify the thrown error type** in the catch: signature/verification errors → skip the
  heartbeat FAILURE (return 400 as today); all other (post-verify processing) errors → record
  FAILURE, then return 400.

Either way: a real **verified-event-then-processing-throws** failure still counts toward
`consecutive_failures` and can legitimately escalate to CRITICAL; a pre-verify reject never does.

**Twilio note (already correct, no change needed).** Both Twilio routes return `403` from the
signature gate **before** the `try/catch` that records the failure (`twilio/status/route.ts:35,50`
return before the `catch` at `:58`; `twilio/inbound/route.ts:40,57` likewise). So Twilio's
signature-reject paths already cannot reach the recorded catch — the §2.3 wiring for them is sound
as written.

**"Ran but sent nothing" rule (scheduler-reminders — close the original incident class).**
`sendDueSchedulerReminders` (`scheduler.ts:1246-1275`) swallows every send failure
(`if (!emailed) continue;`) and resolves `{checked, sent}` — it **cannot throw** for email
failures, and `resendRequest` returns `delivered:false` (no throw) when `RESEND_API_KEY` is
missing/revoked. So persistent Resend breakage on this job would keep the heartbeat green forever
while reminders go silently unsent — the original 2-month incident via a different mechanism
(booking reminders have no other failure signal, unlike sequences/SMS). Fix:
- Extend the function's return to `{ checked, due, sent, failed }` where `due` = bookings eligible
  to send this run and `failed` = sends that returned `delivered:false`.
- In the reminders route, **record the run as FAILURE when `due > 0 && sent === 0`** (persistent
  provider breakage), and pass a cleaned reason. Transient single-send blips (`failed > 0` but
  `sent > 0`) stay self-healing (retried next hour) and are surfaced as **WARN** in
  `computeSystemHealth` rather than a hard failure. See the health-signal catalog (§1) and test §8.

The **cron Workers** (`workers/*.ts`) do **not** call `recordJobRun` — they have no D1 binding
(their `Env` is only the endpoint + `CRON_SECRET`). The heartbeat is written CRM-side inside
the bearer-authed route, which is exactly where DB access + true success/failure are known
(and matches the 2xx the worker verifies).

---

## 3. Migration sketch (additive, 3-place mirror)

This repo mirrors every schema change in **three** places (verified against migrations
0088/0089/0091):

1. **`migrations/0092_observability_heartbeat.sql`** — the numbered, applied-to-prod file.
2. **`src/db/client.ts` `migrate()`** — an idempotent `CREATE TABLE IF NOT EXISTS` block so
   local better-sqlite3 and any partially-migrated prod D1 converge without a blanket
   `migrations apply` (see the 0088/0089 inline blocks).
3. **`src/db/schema.ts`** — the Drizzle table definitions (`sqliteTable(...)`).

### 3.1 `migrations/0092_observability_heartbeat.sql`

```sql
-- Phase 21: observability heartbeat + alert dedupe. Additive + idempotent.
-- NON-CANONICAL: nothing here moves money or mutates a business record. These tables
-- are operational only; losing them loses history, never business state. NOT on an
-- always-on business read path, so this can migrate anytime (dark) — but apply it
-- before the monitor Worker deploy so recordJobRun writes land.

CREATE TABLE IF NOT EXISTS job_runs (
  job_name             TEXT PRIMARY KEY NOT NULL,
  last_run_at          TEXT,
  last_success_at      TEXT,
  last_status          TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL
);

-- Immediate-alert dedupe: fire a CRITICAL email ONCE per condition instance, re-arm on clear.
CREATE TABLE IF NOT EXISTS health_alerts (
  alert_key    TEXT PRIMARY KEY NOT NULL,  -- e.g. 'critical:refund_stuck:<initiationId>'
  severity     TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_sent_at TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_alerts_unresolved ON health_alerts(resolved_at);
```

### 3.2 `src/db/client.ts` inline idempotent block

Append after the 0091 block (~line 852), same style — a `database.exec()` with the two
`CREATE TABLE IF NOT EXISTS` + index statements above.

### 3.3 `src/db/schema.ts`

Add `export const jobRuns = sqliteTable("job_runs", {...})` and
`export const healthAlerts = sqliteTable("health_alerts", {...})` mirroring the columns
(pattern: `stripeWebhookEvents` / `refundInitiations` at lines 553 / 600).

### 3.4 Optional heartbeat endpoint for out-of-Worker jobs (backup on the Mac)

`POST /api/cron/heartbeat` — bearer-authed on `CRON_SECRET` (constant-time compare, 503 unset
/ 401 wrong — identical shape to the existing cron routes), body `{job, ok, error?}`, calls
`recordJobRun`. This is the mechanism for jobs that run **outside** the Worker (the launchd
backup script POSTs it after a successful `backup:data`). It writes **only** `job_runs` (a
non-canonical operational row), so it is safe to place in the origin-guard bypass list next to
the other cron entries. **Optional** — ship it, but the backup-script wiring is a Tyler
enablement follow-up; until then `job_runs['backup-d1']` is simply absent → rendered
`not-configured` (INFO), never a false alarm.

---

## 4. Daily digest + immediate critical alert

### 4.1 One health-computation module (maximal reuse)

New `src/lib/system-health.ts` — a single read-only `computeSystemHealth()` that assembles the
§1 catalog into a typed report:

```
type HealthSignal = { key; label; severity: 'ok'|'info'|'warn'|'critical'; detail; value? }
type SystemHealthReport = { generatedAt; overall: 'green'|'warn'|'critical'; signals: HealthSignal[] }
```

It reads: `job_runs` (staleness + consecutive_failures vs the §1 thresholds),
`getRefundInitiationReconciliation()` (stuck / not-recorded), `getFinanceReport(...)
.reconciliation` **or** the underlying `paymentLedgerNeedsReconciliation` query, and direct
counts over `sequence_sends` (`claimed`/`failed`) and `project_communications`
(failed delivery). **No new queries invented** where an existing one exists. Pure read; no
writes; no flag (always callable). This single module feeds the digest, the immediate-alert
scan, `/api/agent/health`, and the `/system-status` page.

**Required-cadence missing-row branch (per §1).** `computeSystemHealth` carries a small
`REQUIRED_JOBS` map — `scheduler-reminders`, `sequence-runner`, `systems-monitor` — each with its
enablement timestamp. For a required job, **`job_runs` row absent OR `last_success_at` NULL** is
evaluated as *maximally stale*, clocked from that enablement timestamp against the same §1
WARN→CRITICAL thresholds (so a broken-from-day-one trigger or a restored/empty table surfaces
instead of rendering green). Non-required jobs (webhook/inbound handlers, `backup-d1`) keep the
opposite default: absent row → `not-configured` (INFO). A required job whose latest recorded run is
a FAILURE (e.g. reminders' "due>0, sent=0", or a post-verify Stripe processing failure) is evaluated
on `last_status`/`consecutive_failures`, not just staleness. For reminders specifically, a run with
`failed > 0 && sent > 0` (transient blips, self-healing next hour) is surfaced as **WARN** rather
than a hard failure.

### 4.2 The monitor cron worker (fail-loud pattern, reused verbatim)

Rather than two Workers, one **hourly** `reese-systems-monitor` Worker does both cadences —
fewer moving parts for a solo owner:

- **Every hour:** evaluate CRITICAL signals; email immediately **only on a newly-seen**
  critical condition (dedupe via `health_alerts`, §4.4).
- **Once per day** (when ET hour == the configured digest hour): also send the full
  green/amber daily digest.

Files (copy `workers/scheduler-reminders.ts` + `wrangler.scheduler-reminders.jsonc` exactly):

- `workers/systems-monitor.ts` — `scheduled()` → `fetch(env.MONITOR_ENDPOINT, {method:'POST',
  headers:{Authorization:'Bearer '+env.CRON_SECRET}, redirect:'manual'})`; throw on
  `opaqueredirect` / status `<200||≥300`. `MONITOR_ENDPOINT` = the **workers.dev origin**
  `.../api/cron/systems-monitor` (never the login-walled proxy host).
- `wrangler.systems-monitor.jsonc` — `triggers.crons: ["0 * * * *"]`, `observability.enabled:
  true`, `MONITOR_ENDPOINT` var. **Ships un-wired** (see §5).
- `src/app/api/cron/systems-monitor/route.ts` — bearer-auth (503 unset / 401 wrong,
  constant-time, `CRON_SECRET`); if `!monitorEnabled()` return `{skipped:'flag_off'}` (no
  email); else `computeSystemHealth()` → run the immediate-critical scan → maybe daily digest →
  `recordJobRun('systems-monitor', ok)` → return summary.
- Add `/api/cron/systems-monitor` (and `/api/cron/heartbeat` if shipped) to
  `PUBLIC_API_PREFIXES` in `src/lib/origin-guard.ts`, with the same justification comment as
  `/api/cron/sequences`: bearer secret at the origin is the trust boundary; read-only +
  non-canonical heartbeat writes only; **not** a canonical mutation endpoint (respects the
  Active-Learning-Log rule against adding *mutation* endpoints to the bypass list).

### 4.3 Who watches the watcher — the dead-man's-switch

If the monitor Worker itself dies, its own `job_runs['systems-monitor']` heartbeat goes stale
but there is nobody left to notice. Two layers:

1. **The daily digest email is the liveness signal.** A green digest arrives every day.
   Document loudly (in this spec + the deploy record + the digest footer): **"If you did not
   get the daily Systems email, that itself is the alarm — investigate."** A missing email = a
   dead monitor. This is zero-infrastructure and owner-appropriate.
2. **Recommended external uptime ping (true dead-man's-switch).** At the end of a successful run
   the monitor route POSTs an **outbound** ping to a Tyler-configured `DEADMAN_PING_URL`
   (e.g. a free healthchecks.io / UptimeRobot "expect a ping every 24h" check). If the ping
   stops, the *external* service — which survives the whole CRM being down — emails/SMSes
   Tyler. This is the **only layer that survives a full-stack death** (layer 1 rests entirely on
   Tyler *noticing an absent email* — the exact bet that lost two months), so it is **promoted
   from optional to a RECOMMENDED enablement step**: it is free and ~5 minutes on
   healthchecks.io. Until it is armed the gap stays **visible**, not silent:
   - the daily digest **footer** states whether the external ping is armed
     (`external dead-man ping: armed` vs `NOT armed — recommended, see §4.3`);
   - `/system-status` renders `deadman: not-configured (WARN-level advice)` while
     `DEADMAN_PING_URL` is unset, so the unclosed gap is surfaced every time Tyler looks.

   This is **outbound only**: we expose **no** inbound public health endpoint (verified — no new
   attack surface; Active-Learning-Log: no unauthenticated surfaces). Configurable, off when
   `DEADMAN_PING_URL` is unset (in which case the ping simply does not fire, but the
   footer/`/system-status` advisory above keeps the gap in view).

### 4.4 Immediate critical alert + dedupe

For each CRITICAL signal, form a stable `alert_key` (e.g.
`critical:refund_stuck:<initiationId>`, `critical:reminders_stale`,
`critical:stripe_webhook_failing`). `INSERT ... ON CONFLICT(alert_key) DO NOTHING` into
`health_alerts`; **email only when the insert actually created the row** (first sighting) —
so the same stuck refund does not re-email every hour. When the condition clears (no longer in
the computed report), mark `resolved_at` so a future recurrence re-arms. This reuses the
per-object-convergence idempotency pattern the codebase already relies on.

### 4.5 Delivering the email (Resend, owner address only)

`src/lib/email.ts` today has no generic owner-notification sender (`sendResendEmail` is
private; `sendSequenceEmail` attaches a marketing unsubscribe footer — wrong for ops mail).
Add **one** exported helper:

```
sendAdminAlertEmail({ subject, text }): Promise<boolean>
  - recipient = process.env.ALERT_EMAIL (Tyler's own address). NEVER a client-derived address.
  - uses the private resendRequest (returns false, never throws, when RESEND_API_KEY unset).
  - NO List-Unsubscribe footer (transactional ops mail to the owner, not bulk mail).
  - fail-closed on config: ALERT_EMAIL unset → return false + record the miss; the digest is
    considered un-wired until Tyler sets it (enablement).
```

The recipient is a **fixed config value**, never anything derived from client data — this is
the structural guarantee that the monitor cannot email a client or leak data outward.

Digest body is built **only** from whitelisted report fields (labels, statuses, counts, ISO
timestamps, cleaned error messages). It must never interpolate `process.env` (secret-redaction
test, §7).

---

## 5. Admin health page + `/api/agent/health`

- **Admin page — extend the existing `/system-status`** rather than add a new page (maximal
  reuse of `getStudioSystemStatus` + `StatusGrid` in `src/app/system-status/page.tsx`). Add an
  "Autonomous jobs" / "Systems health" section fed by `computeSystemHealth()`, rendered with
  the existing `StatusGrid` (tone map `ok→emerald`, `warn→amber`, add a `critical→red` tone).
  The page is already admin-only (behind the Pages-proxy Google gate; `force-dynamic`). A
  `/admin/health` alias route is optional and not required.
- **Machine `/api/agent/health`** — new route returning `computeSystemHealth()` as JSON.
  **Path matters: it MUST live under `/api/agent/` so it is reachable in prod with zero proxy
  changes.** The Pages proxy already treats `/api/agent/*` as `isStudioTrustedAgentApiPath`
  (`_worker.js:204-205`, folded into `isStudioPublicPath` at `:208`), so it passes through the
  studio host **without** a `303 → /admin/login`; it inherits the `agentApi` rate bucket and the
  `STUDIO_AGENT_API_TOKEN` bearer guard (`guardAgentApiRequest`, `agent-api.ts:14`; 401 on
  missing/bad, 503 if token unset). A bare `/api/health` would ship **dead**: not in
  `isStudioPublicPath` → `303` login via the studio host, and not in origin-guard
  `PUBLIC_API_PREFIXES` → `404` via `*.workers.dev`, so the §8 smoke could never pass. Read-only,
  no flag. **Not** exported as an agent MCP tool (per §2.2 — no agent/MCP surface for monitoring
  internals); it is only an authenticated JSON route the smoke and on-demand checks hit. It is
  **not** public — external liveness is the outbound ping (§4.3), so no operational detail is
  exposed unauthenticated.

Both surfaces are always-on reads; only the autonomous **email** is flag-gated.

---

## 6. Flags, rollout, and Tyler enablement

**Off-by-default flags (three-state where it changes runtime):**

- `MONITOR_ENABLED` (default off; `"1"` on) — gates the monitor route's **email + ping**
  behavior only. Off → route returns `{skipped:'flag_off'}`, no email. Reads (`/api/agent/health`,
  `/system-status`) are unaffected.
- `ALERT_EMAIL` — Tyler's address. Unset → digest un-wired (cannot deliver).
- `DEADMAN_PING_URL` — **recommended** external uptime ping (§4.3; off when unset, but the
  digest footer + `/system-status` flag it as an open gap until set).
- `CRON_SECRET` — already exists; reused for the monitor + heartbeat routes (fail-closed 503).

**Ships dark:** migration 0092 applied (additive), `recordJobRun` wired into the six existing
job entry points (writes heartbeats but changes no behavior), `system-health.ts`,
`/api/agent/health`, and the `/system-status` section all deployed. `workers/systems-monitor.ts` +
`wrangler.systems-monitor.jsonc` are committed **but the Worker is not deployed/scheduled** and
`MONITOR_ENABLED` is off — zero autonomous email until Tyler enables.

**Tyler enablement runbook (queued, not autonomous — per loop Guardrail 2):**

1. Set `ALERT_EMAIL` (his inbox) + `MONITOR_ENABLED=1` as Worker secrets/vars.
2. Deploy the monitor Worker: `wrangler deploy --config wrangler.systems-monitor.jsonc`; set
   its `CRON_SECRET` secret; confirm the cron schedule + `MONITOR_ENDPOINT` = workers.dev
   origin.
3. **(Recommended — the only layer that survives a full-stack death, §4.3)** create a
   healthchecks.io/UptimeRobot "expect a ping every 24h" check, set `DEADMAN_PING_URL`. Free,
   ~5 min. Until done, the digest footer + `/system-status` flag it as an open gap.
4. (Optional) wire the launchd backup script to POST `/api/cron/heartbeat` after
   `backup:data`.
5. Watch for the first daily green digest; confirm a deliberately-staled job (e.g. pause the
   reminders cron for >6h in a test window) produces a CRITICAL email, then re-enable.

---

## 7. Reuse map (reuse, don't reinvent)

| Need | Reuse |
|---|---|
| Cron worker (fail-loud, workers.dev origin, bearer, `redirect:'manual'`, throw on non-2xx) | `workers/scheduler-reminders.ts` + `wrangler.scheduler-reminders.jsonc` |
| Bearer-auth cron route (503 unset / 401 wrong, constant-time) | `src/app/api/cron/sequences/route.ts` |
| Origin-guard bypass entry for a bearer-authed cron origin path | `PUBLIC_API_PREFIXES` in `src/lib/origin-guard.ts` (the `/api/cron/sequences` entry + comment) |
| Email delivery | `src/lib/email.ts` (`resendRequest`); add `sendAdminAlertEmail` |
| Refund tripwires (stuck / not-recorded) | `getRefundInitiationReconciliation` (`src/lib/stripe-refund-initiation.ts`) |
| Payment evidence reconciliation | `getFinanceReport().reconciliation` / `paymentLedgerNeedsReconciliation` (`src/lib/agent-finance.ts`, `src/lib/sales.ts`) |
| Sequence stuck/failed surfacing | `sequence_sends` + `surfaceStuckSends` (`src/lib/sequences.ts`) |
| Health rendering (admin) | `getStudioSystemStatus` + `StatusGrid` (`src/lib/system-status.ts`, `src/app/system-status/page.tsx`) |
| Migration 3-place mirror | migrations 0088/0089/0091 + `src/db/client.ts` inline block + `src/db/schema.ts` |
| Idempotency (no D1 transactions) | `INSERT ... ON CONFLICT DO NOTHING/UPDATE`, set-to-authoritative (per-object convergence) |
| Config-verification companion | extend `scripts/production-smoke.mjs` (see §8) |

**Relationship to provider-config verification (separate recommendation #2):** that work is a
**one-shot preflight** ("is `RESEND_API_KEY`/`STRIPE_WEBHOOK_SECRET`/`CRON_SECRET` set, are the
webhooks subscribed"). This phase is the **runtime heartbeat** ("did the jobs actually run and
succeed today"). They meet at `/api/agent/health`: config-verification can assert the endpoint
returns 200 + green structure; the runtime digest is what catches a job that was configured
correctly and then silently broke (the reminders scenario). Keep them distinct; do not fold
config checks into the digest.

---

## 8. Test plan (tsx unit tests + `npm run build` exit code)

Build gate: `npm run build` and assert **exit code 0** (a type error prints after "Compiled
successfully" and exits 1; tsx tests don't type-check). `npm run lint`. `npm test`.

Unit tests (tsx, local better-sqlite3):

1. **`recordJobRun` upsert semantics** — first `ok` inserts with `consecutive_failures=0` +
   `last_success_at` set; a `fail` sets `last_status='error'`, increments
   `consecutive_failures`, sets `last_error`; a following `ok` resets failures to 0 and clears
   `last_error`. `last_success_at` is unchanged by a `fail`.
2. **Stale job → digest flags it, AND a missing required-job row is not green** — seed
   `job_runs['scheduler-reminders']` with `last_success_at` 7h ago → `computeSystemHealth()`
   marks it CRITICAL; 3h ago → WARN; 30 min ago → ok (green). **Missing-row case (new):** with
   **no** `job_runs` row at all for a REQUIRED job (`scheduler-reminders` / `sequence-runner` /
   `systems-monitor`) and an enablement timestamp > the CRITICAL window ago → `computeSystemHealth()`
   marks it maximally stale (CRITICAL / WARN per threshold), **not** green and **not**
   `not-configured`. Contrast: a missing row for a non-required job (`stripe-webhook`, `backup-d1`)
   → `not-configured` (INFO), no alarm.
2b. **Reminders "ran but sent nothing" → FAILURE, transient blip → WARN (MEDIUM 5)** — with a
   heartbeat recorded from a `{due>0, sent:0}` run, `computeSystemHealth()` treats reminders as
   failing (escalating via `consecutive_failures`), even though `last_run_at` is fresh; a
   `{due:2, sent:1, failed:1}` run surfaces as WARN only (self-healing). Guards the original
   incident class (persistent Resend breakage keeps the job "running" but silent).
2c. **Stripe signature-reject does not poison the CRITICAL counter (MAJOR 1)** — three
   pre-verification rejects (invalid/missing signature → `verifyStripeWebhookPayload` throws → 400)
   leave `job_runs['stripe-webhook'].consecutive_failures` unchanged (or increment only a separate
   non-alerting key), so no CRITICAL "money state drift" email fires; a verified-event-then-
   processing-throws failure DOES increment `consecutive_failures` and can escalate.
3. **Healthy run → green** — all heartbeats fresh + zero reconciliation rows →
   `overall === 'green'`, digest subject is the all-green line.
4. **Alert on CRITICAL** — a `stuckSubmitting` refund fixture → a `critical` signal present;
   the immediate-alert selector emails it. A `>24h succeeded-not-recorded` → WARN only (no
   immediate email).
5. **Immediate-alert dedupe** — same critical condition evaluated twice → email sent once
   (`health_alerts` ON CONFLICT); after `resolved_at` set, a recurrence re-arms and emails
   again.
6. **Digest never sends secrets** — build the digest body from a report whose `last_error`
   contains a fake secret-shaped string; assert the rendered body contains none of the process
   env secret values (`RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `CRON_SECRET`,
   `STUDIO_AGENT_API_TOKEN`) and that the builder interpolates only whitelisted fields.
7. **Heartbeat write is non-canonical** (guard test, mirrors the sequences/inbound guards) —
   running `recordJobRun` (and the whole monitor route) writes rows to `job_runs`/`health_alerts`
   **only**; asserts zero rows written to any canonical table (projects, clients, invoices,
   invoice_payments, payment_refunds, refund_initiations, sequence_sends). Assert `recordJobRun`
   / monitor internals are **not** exported to any agent/MCP surface.
8. **Fail-loud preserved** — when the monitored lib throws, the cron route records a failure
   **and still returns the same non-2xx** (assert the status code is unchanged vs today); i.e.
   monitoring never converts a failure into a 2xx.
9. **Flag-off** — `MONITOR_ENABLED` unset → monitor route returns `{skipped:'flag_off'}` and
   `sendAdminAlertEmail` is **not** called (no email on a dark deploy).
10. **`sendAdminAlertEmail` targeting** — recipient is always `ALERT_EMAIL`; a report carrying
    a client email in a detail field never becomes the `to:`. Unset `ALERT_EMAIL` → returns
    false, no send.

Extend `scripts/production-smoke.mjs` (config-verification companion): add a check that
`GET /api/agent/health` returns 200 with the `STUDIO_AGENT_API_TOKEN` bearer and an `overall`
field in `{green,warn,critical}` (do not fail the smoke on `warn`/`critical` — that's a real
signal, not a smoke failure; assert only that the endpoint is live + shaped). The `/api/agent/`
path is what makes this reachable through the proxy at all (§5); a bare `/api/health` would
`303`/`404` and the smoke could never pass. Follows the existing `fetchJson` +
`evaluateProductionSmoke` pattern.

---

## 9. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
|---|---|---|---|---|
| 1 | Migration 0092 (3-place mirror: SQL + `client.ts` block + `schema.ts`) | S | Low | Additive, non-canonical; migrate anytime dark |
| 2 | `src/lib/job-runs.ts` — `recordJobRun` + reader, swallow-on-write-fail | S | Low | D1-safe upsert, no transaction |
| 3 | Wire `recordJobRun` into the 6 existing job routes | M | **Med** | Must preserve fail-loud status + await before return; don't mask failures |
| 4 | `src/lib/system-health.ts` — `computeSystemHealth()` over §1 signals (reuse existing queries) | M | Low | Pure read; thresholds live here |
| 5 | `sendAdminAlertEmail` in `email.ts` (owner-only, no unsubscribe footer, fail-closed) | S | Low | Reuses `resendRequest` |
| 6 | Monitor route `/api/cron/systems-monitor` (bearer, flag-gated email, digest + critical scan + dedupe + self-heartbeat + recommended dead-man ping, §4.3) | M | Med | Off-by-default; origin-guard bypass entry; digest footer + `/system-status` flag an unset `DEADMAN_PING_URL` |
| 7 | `workers/systems-monitor.ts` + `wrangler.systems-monitor.jsonc` (fail-loud copy) | S | Low | Ships un-wired |
| 8 | Extend `/system-status` page with the health section + `critical` tone; add `/api/agent/health` (agent bearer, `/api/agent/` path → zero proxy changes; NOT an MCP tool) | M | Low | Reuse `StatusGrid` |
| 9 | (Optional) `/api/cron/heartbeat` + backup-script wiring | S | Low | Enablement follow-up |
| 10 | Tests §7 + extend `production-smoke.mjs` | M | Low | Build exit-code gate |
| 11 | Deploy dark (backup → capture versions → deploy → smoke → rollback-ready); write deploy record; queue Tyler enablement runbook | M | Med | Guardrails 1/2/4 |

---

## 10. Active-Learning-Log pitfalls — pre-empted

- **Fail-loud crons.** The monitor worker copies the fixed `redirect:'manual'` + throw-on-non-2xx
  shape; `MONITOR_ENDPOINT` is the **workers.dev origin**, never the login-walled proxy host.
  `recordJobRun` in the existing crons **preserves** their non-2xx on failure (it never converts
  a failure into a 2xx).
- **Fail-closed secrets.** Monitor + heartbeat routes 503 when `CRON_SECRET` is unset, 401 on
  mismatch (constant-time). `sendAdminAlertEmail` returns false (no false success) when
  `RESEND_API_KEY`/`ALERT_EMAIL` are unset.
- **Off-by-default.** `MONITOR_ENABLED` gates all autonomous email; the monitor Worker ships
  un-wired. Dark deploy = zero behavior change.
- **No canonical mutation from monitoring.** Monitoring writes only `job_runs`/`health_alerts`
  (operational, non-canonical) and reads everything else. A guard test asserts zero canonical
  writes; no agent/MCP export.
- **No D1 transactions.** Heartbeat + dedupe use `INSERT ... ON CONFLICT` per-object
  convergence, never `db.transaction()`/`db.batch()`.
- **Proxy composition for any new endpoint.** `/api/cron/systems-monitor` (+ optional
  `/api/cron/heartbeat`) are added to `origin-guard` `PUBLIC_API_PREFIXES` with the bearer
  secret as the trust boundary — Fable-review the new routes against the **live**
  proxy/origin-guard/admin-proof boundary, not just their own files. `/api/agent/health` needs
  **no** proxy/origin-guard edit: the `/api/agent/` prefix already passes the proxy
  (`isStudioTrustedAgentApiPath`, `_worker.js:204`) under the `STUDIO_AGENT_API_TOKEN` bearer
  guard. A bare `/api/health` would have shipped dead (studio host `303`, workers.dev `404`).
  External liveness is an **outbound** ping (no inbound public surface).
- **Workers deferred-work cancellation.** All heartbeat/email writes are `await`ed inside the
  request, not fired-and-forgotten after the response.
- **Migration ordering.** 0092 is additive + non-canonical + not on an always-on business read
  path, so it can migrate dark; still apply it before the monitor Worker deploy so heartbeat
  writes land. Apply via idempotent `CREATE TABLE IF NOT EXISTS` `d1 execute --file`, not a
  blanket `migrations apply --remote`.
- **Secret redaction.** The digest body is built only from whitelisted fields and cleaned,
  capped error messages; a test asserts no env secret value ever appears in a rendered digest.
  The cap + redaction run **inside `recordJobRun`** (defense-in-depth; the helper does not trust
  each caller to pre-clean).

---

## 11. Changelog

### Rev 2 (Fable spec-review) — 2026-07-06

Five review findings folded in (all localized; no architecture change). Each verified against the
cited code before editing.

| Finding | Severity | Fix (where) | Verified against |
|---|---|---|---|
| Stripe signature-reject poisons the CRITICAL counter (attacker-triggerable / cry-wolf) | MAJOR 1 | §2.3 stripe row + new "signature-reject carve-out": record a `stripe-webhook` FAILURE **only for errors raised after `verifyStripeWebhookPayload` succeeds** (split-the-try, or classify the thrown error); pre-verify rejects unrecorded or under a separate non-alerting key. Added §8 test 2c. Noted the Twilio wiring is already correct. | `/api/stripe/webhook` in `PUBLIC_API_PREFIXES` (`origin-guard.ts:24`); `verifyStripeWebhookPayload` runs first (`stripe-checkout.ts:693`); route catch → 400 (`route.ts:9-15`); Twilio 403 gates return before the recorded catch (`twilio/status/route.ts:35,50` vs catch `:58`; `twilio/inbound/route.ts:40,57`) |
| `/api/health` as spec'd is unreachable in prod (dead endpoint; §8 smoke can never pass) | MAJOR 2 | Renamed to **`/api/agent/health`** throughout (§5, §8 smoke, §9 task 8, §10, plus §2/§4.1/§6 mentions). Inherits `isStudioTrustedAgentApiPath` proxy pass-through, the `agentApi` bucket, and the `STUDIO_AGENT_API_TOKEN` guard with ZERO proxy changes; kept OUT of the agent MCP tool export. | proxy: `isStudioPublicPath`/`isStudioTrustedAgentApiPath` (`_worker.js:204-214`); guard: `STUDIO_AGENT_API_TOKEN` (`agent-api.ts:14`) |
| Missing `job_runs` row for a required-cadence job renders green ("never ran at all" is invisible) | MEDIUM 3 | §1 + §4.1: defined a **REQUIRED set** (`scheduler-reminders`, `sequence-runner`, `systems-monitor`) for which **missing row OR NULL `last_success_at` = maximally stale** (WARN→CRITICAL, clocked from deploy/enablement timestamp). Event-driven webhooks + `backup-d1` stay INFO when absent. Added §8 test 2 missing-row case. | `backup-d1` was the only prior missing-row semantics (§1 backup row) |
| Watcher-liveness rests on Tyler noticing an ABSENT email (the exact 2-month bet), marked "Optional" | MEDIUM 4 | §4.3: promoted `DEADMAN_PING_URL` from optional to **RECOMMENDED** (free, ~5 min, healthchecks.io). Digest footer states whether the ping is armed; `/system-status` renders `deadman: not-configured (WARN-level advice)` until set. Updated §6 flags + runbook step 3 + §9 task 6. Outbound-only, no inbound surface. | §4.3 dead-man's-switch is the only layer surviving a full-stack death |
| `scheduler-reminders` records ok when it "ran but sent nothing" (the spec's OWN motivating sub-class) | MEDIUM 5 | §2.3 "ran but sent nothing" rule + §1 reminders row + §4.1: extend `sendDueSchedulerReminders` return to `{checked, due, sent, failed}`; record **FAILURE when `due>0 && sent===0`**; surface `failed>0 && sent>0` transient blips as WARN (self-healing). Added §8 test 2b. | `sendDueSchedulerReminders` swallows send failures (`if (!emailed) continue;`) and returns `{checked, sent}` (`scheduler.ts:1246-1275`); `resendRequest` returns `delivered:false` without throwing on missing `RESEND_API_KEY` |

Build-hardening (non-blocking, from the review's "clean" section): the secret-redaction + ≤500-char
cap now lives **inside `recordJobRun`** (§2.2, §10 — not trusting each caller); the
record-then-preserve-status rule (§2.2) is retained so the heartbeat never masks a fail-loud
outcome.
