# Phase 8 (slice C): Automated communication sequences — Design Spec

Status: **design only, not built.** Master flag `SEQUENCES_ENABLED` OFF by default; every sequence individually OFF; auto-send individually OFF. No implementation code in this document.

Owner approval doctrine: **agents draft, Tyler sends** — with one narrow, deliberately-bounded exception (§1) for *templated transactional* messages, gated behind an explicit per-sequence opt-in that is OFF by default. Sequences are **config + schedule driven, never agent driven**: the runner reads canonical DB state and renders **code-constant templates**. No agent, LLM, inbound handler, or other untrusted input chooses a recipient, composes a body, or triggers a send. This is a *stronger* guarantee than 8b's draft path, where the draft body was agent-authored; here even the draft content is a fixed template.

Legal/compliance doctrine: **every send is consent- and suppression-gated.** Email sends carry a one-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`) and consult a new `email_suppressions` list. SMS sequence steps **only ever produce drafts** and reuse the 8b `sendProjectSms` consent+suppression gate at send time — 8c adds **no** new SMS send path and **no** SMS auto-send. A global per-client automated-comms **frequency cap** prevents spam across all sequences. Dunning is money-adjacent: never for paid/void/draft invoices, gentle templated tone, hard frequency ceiling, stop-on-paid.

## 0. Goal and scope

Add scheduled, automated **sequences** on the existing scheduling/cron + workflow + communications rails:

1. **Invoice dunning** — overdue-invoice reminders (stop on paid/void).
2. **Pre-event timeline nudges** — questionnaire-not-filled / timeline-call-not-booked reminders as the event date approaches.
3. **Post-delivery review request** — after the gallery-delivery workflow step completes, plus a delay.

Built **dark**: `SEQUENCES_ENABLED` off; each sequence off; auto-send off; the cron trigger is not registered until Tyler enables it (guardrail #2 — enablement flips are not autonomous). Reuse email (`src/lib/email.ts` → Resend), SMS (Phase 8b `sendProjectSms`/`sendApprovedProjectSms`), the `project_communications` draft/send model (`src/lib/project-communications.ts`), and the scheduled-cron precedent (`workers/scheduler-reminders.ts` → `src/app/api/cron/scheduler-reminders/route.ts` → `sendDueSchedulerReminders` in `src/lib/scheduler.ts`).

### In scope
- `src/lib/sequences.ts` — fixed sequence + step **definitions** (code constants, mirroring `sixFigureAutomationSteps` in `project-workflow-automation.ts`), the trigger evaluators, the render-from-template functions, and `runDueSequences(now)` (the idempotent evaluator, mirroring `sendDueSchedulerReminders`).
- Migration `0088` (next after `0087`): `sequence_enrollments`, `sequence_sends` (the at-most-once ledger), `email_suppressions`. All **additive + dark** (read/written only by the flag-gated runner and the unsubscribe endpoint — NOT an always-on read path, so unlike `0087` it need not precede the Worker deploy; §5.2).
- One-click email unsubscribe: `sendSequenceEmail` wrapper adding `List-Unsubscribe`/`List-Unsubscribe-Post` headers + a signed token; a public `POST/GET /api/email/unsubscribe` endpoint; suppression enforced on every sequence email.
- New split worker `workers/sequence-runner.ts` + `wrangler.sequence-runner.jsonc` (cron) → `POST /api/cron/sequences` (bearer-secret, constant-time, fail-closed) → `runDueSequences()`. Mirrors the scheduler-reminders split-worker + bearer pattern exactly.
- Admin enroll/unenroll (stop) action + a status badge on the project page; flags; enable runbook.

### Explicitly OUT of scope
- **Marketing campaigns / blasts / bulk sends.** One templated message per due step per enrolled project.
- **A/B testing** of subject/body/timing.
- **Arbitrary user-defined sequences.** The set is **fixed in code** (three sequences); no builder UI, no DB-authored step logic.
- **Two-way conversation / reply handling.** Inbound is 8b's concern; sequences only *emit*.
- **New SMS send path or SMS auto-send.** SMS steps draft only; the send stays Tyler's 8b admin action.

---

## 1. Auto-send vs draft-queue policy — THE crux

### 1.0 The apparent contradiction

The house doctrine is "agents draft, Tyler sends" (8a inquiry intake, 8b SMS — both draft-only). **But** `sendDueSchedulerReminders` (`scheduler.ts:1246`) already **auto-sends** a transactional booking-reminder *email* from a cron, with no human in the loop. Phase 8c must not casually widen that into "automation emails clients whatever it wants." So we must define *precisely* what made the scheduler reminder safe to auto-send, and permit auto-send only for messages that clear the same bar.

### 1.1 Why the scheduler reminder is safe to auto-send (the precedent, decomposed)

`sendDueSchedulerReminders` auto-sends because it satisfies **all** of:

1. **Purely transactional, live relationship + implied consent.** The recipient *personally booked* the meeting minutes-to-days earlier and gave their email at booking; a reminder about *their own upcoming appointment* is expected, not solicited marketing.
2. **Fully templated, zero free text.** `sendBookingReminderEmail` (`email.ts:126`) interpolates a **fixed code string** from booking fields (name, time, location). No agent, no LLM, no user-supplied body.
3. **Config + schedule driven.** A cron reads DB rows in a time window and fires; nothing agent-authored decides recipient or content.
4. **Idempotent.** `reminderSentAt` guarantees at-most-once (`scheduler.ts:1260,1267`).
5. **Bounded blast radius.** `limit: 25`, one message per booking, no fan-out.

### 1.2 Per-sequence-type policy

Every sequence step declares a `channel` (`email` | `sms`) and an `autoSendEligible` boolean in its **code** definition. Runtime behaviour:

| Sequence | Channel | Default action | Auto-send eligible? | Rationale |
| --- | --- | --- | --- | --- |
| Dunning | email | **Draft** | Yes (opt-in, off by default) | Transactional (a real balance the client owes on a live invoice), fully templated, one-click unsubscribe, idempotent — clears the §1.1 bar. Still defaults to draft because it is *money-adjacent* (tone/timing risk) and Tyler may want eyes on it. |
| Pre-event nudge | email | **Draft** | Yes (opt-in, off by default) | Transactional (their own upcoming event; questionnaire/timeline are things *they* owe *us*), templated. Defaults to draft. |
| Post-delivery review | email | **Draft** | No | A review *ask* is closer to solicitation than a transactional notice; leave it draft-only so Tyler personalises. |
| Any sequence | **sms** | **Draft** | **Never** | SMS reuses 8b's draft-only doctrine verbatim. 8c adds no SMS auto-send. A sequence SMS step produces a `project_communications` draft; Tyler sends it via `sendApprovedProjectSms` (which re-checks consent + suppression). |

**Conservative default (recommended, and what the runner ships with):** *every* step produces a **draft** unless (a) the step is `autoSendEligible` **and** (b) the per-sequence auto-send flag is explicitly ON (`SEQUENCES_<NAME>_AUTOSEND=1`, default unset) **and** (c) the channel is `email`. Absent all three, the step drafts. So the deployed, dark default is **100% draft-for-approval**; auto-send is a deliberate, per-sequence, email-only opt-in Tyler flips after watching drafts for a while.

### 1.3 What a "draft" step does vs what an "auto-send" step does

- **Draft step** → insert a `project_communications` row (`channel`, `status="draft"`, `direction="outbound"`, `createdBy="system"`, `sourceType="sequence_step"`, `sourceId=<sequenceKey:stepKey>`), body = rendered template. Then write the `sequence_sends` ledger row (§3). No email/SMS leaves. Tyler reviews in the existing comms UI and sends (email via existing comm-send, SMS via `sendApprovedProjectSms`). This reuses `createProjectCommunication` with a new **`systemActor`** (see §1.5).
- **Auto-send step** (email only, opt-in) → §3's claim-first ledger insert, then `sendSequenceEmail` (suppression + unsubscribe header), then patch a `project_communications` row to `status="sent"`. Mirrors `sendDueSchedulerReminders` but with the ledger + suppression + frequency-cap gates layered on.

### 1.4 The no-agent-path invariant (hard guarantee)

- The runner is invoked **only** by the cron endpoint (bearer-secret authed) — never by any MCP tool, agent, or inbound handler.
- Templates are **code constants** in `sequences.ts`. There is no field, no DB column, no tool argument through which an agent or prompt-injection can inject body text, a recipient, or a "send now" signal.
- `runDueSequences` and `sendSequenceEmail` are **not exported to any MCP/agent surface** (mirroring `sendProjectSms`'s isolation, `sms.ts:147`). A grep-guarded invariant + guard test (§6.2) asserts no `studio-mcp` tool imports them.
- Sequences never call `sendProjectSms` (SMS is draft-only here), so no automation can auto-send an SMS — closing the exact hole 8b guards.

### 1.5 The `systemActor` on the shared comm path

`project-communications.ts` has `agentActor` and `studioActor` (lines 50–64). Add a **`systemActor`** (`createdBy:"system"`, `actorType:"system"`, actions `project.communication.created_by_sequence` / `…updated_by_sequence`). The B1(b) narrowing already added in 8b (`actor.actorType === "agent" && channel === "sms" ? "draft"`, `project-communications.ts:141,203`) is **agent-scoped**; the system actor is trusted config-driven code, not untrusted agent input, so it is not subject to that clamp — but by policy the runner only ever passes `status:"draft"` for drafts and only the auto-send path (never the agent) marks `sent`. No change to the agent clamp; we *add* an actor, we do not widen the agent's authority.

---

## 2. Consent / compliance for every send

### 2.1 Email one-click unsubscribe + suppression (new)

There is **no** email unsubscribe/suppression today (`sendResendEmail`, `email.ts:22`, sends unconditionally). 8c adds it, scoped to **sequence** email (transactional one-offs like booking confirmations are unchanged):

- **`email_suppressions` table (0088):**
  ```
  export const emailSuppressions = sqliteTable("email_suppressions", {
    email:         text("email").primaryKey(),        // lowercased; PRIMARY KEY = dedupe
    suppressedAt:  text("suppressed_at").notNull(),
    source:        text("source"),                     // "unsubscribe_link" | "admin" | "bounce"
    note:          text("note"),
  });
  ```
- **`sendSequenceEmail(input)`** (new, in `email.ts`) wraps `sendResendEmail` and, **before send**:
  1. lowercases the recipient; if present in `email_suppressions` → refuse (`{ ok:false, reason:"suppressed" }`), no Resend call, no false success.
  2. adds headers `List-Unsubscribe: <https://studio.bythereeses.com/api/email/unsubscribe?t=TOKEN>, <mailto:...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Requires extending `sendResendEmail` to pass a `headers` map through to the Resend `headers` field.
  3. appends a visible unsubscribe footer line to the text body (belt-and-suspenders for clients whose MUA hides the header).
  - `TOKEN` = a signed, self-verifying token (HMAC-SHA256 over `email|purpose`, keyed by a dedicated `UNSUBSCRIBE_SECRET`; constant-time verify). No DB token row needed — stateless, like a signed magic value; matches the "sign against a secret, verify constant-time" Active-Learning pattern. Scope the token to `purpose="sequences"` so it only suppresses sequence email, not transactional booking mail.
- **`POST/GET /api/email/unsubscribe`** — RFC 8058 one-click POST (and a GET fallback landing page):
  - verify the token (fail closed 400 on bad/absent token; constant-time compare).
  - `INSERT ... ON CONFLICT(email) DO NOTHING` into `email_suppressions` (idempotent; attacker-chosen input → insert-not-update, per Active-Learning Log). Even a replayed/forged POST can only ever *suppress* (fail-safe direction), and the token binds the email so one client cannot unsubscribe another.
  - respond with a neutral 200 confirmation (uniform, no enumeration).
  - `logActivity({ action:"email.unsubscribed", actorType:"client" })`.
- Enforcement point: `runDueSequences` consults `email_suppressions` for **both** draft and auto-send email steps — a suppressed client gets **no draft either** (drafting a message Tyler cannot compliantly send is pointless and risks an accidental send). SMS steps are gated by the 8b suppression store at send time.

### 2.2 SMS — reuse 8b, no bypass

- A sequence SMS step **only drafts** (`project_communications`, `channel="sms"`, `status="draft"`). The **only** SMS send remains `sendApprovedProjectSms` (Tyler, admin) → `sendProjectSms`, which enforces client-level opt-in (`sms.ts:163`), E.164 (`:170`), the `sms_suppressions` gate (`:174`), and `SMS_ENABLED` (`:177`). 8c imports **nothing** from `sms.ts` except (optionally) `toE164` for display; it never calls `sendProjectSms`. There is no code path by which a sequence auto-sends SMS.

### 2.3 Global per-client comms-frequency cap

Before drafting or auto-sending **any** sequence step, the runner enforces a rolling cap so a client enrolled in multiple sequences (e.g. overdue invoice *and* pre-event) is not spammed:

- Config `SEQUENCES_MAX_PER_CLIENT_PER_WEEK` (default `3`). Count `sequence_sends` rows for the client's projects in the trailing 7 days (the ledger is the authoritative count; it records drafts and auto-sends alike). If at/over the cap → **skip** this step this run (do not consume the ledger slot; it re-evaluates next run once the window rolls). Log a `sequence.capped` activity for observability.
- Per-sequence step spacing is separately enforced by the step schedule (§4), so the global cap is a backstop against *cross-sequence* pile-up, not intra-sequence pacing.

### 2.4 Dunning-specific care (money-adjacent)

- **Never** enroll or fire for an invoice that is `paid`, `void`, or `draft`, or whose client-payable balance ≤ 0. Compute status/balance from the canonical helpers already in `sales.ts`: `reconciledInvoicePaymentStatus` (`sales.ts:84`) and `invoiceClientPayableBalanceCents` (re-exported `sales.ts:17`). Treat `paid`/`partially_paid` transition-to-zero as **stop**.
- **Stop-on-paid is re-checked at fire time**, not just at enrollment: each run re-reads the invoice; if it is no longer overdue-with-balance, the enrollment is marked `completed` and no further step fires (prevents a "you owe us" message going out minutes after payment).
- Hard ceiling: dunning has **exactly three** steps (§4.1); there is no infinite nagging. Templated, courteous, no shaming language, no threats.

---

## 3. Scheduling + idempotency

### 3.1 The split worker + cron endpoint (mirror scheduler-reminders)

- **`workers/sequence-runner.ts`** — byte-for-byte the shape of `scheduler-reminders.ts`: a `scheduled()` handler that `fetch`es `env.SEQUENCES_ENDPOINT` with `Authorization: Bearer ${env.CRON_SECRET}`.
- **`wrangler.sequence-runner.jsonc`** — mirrors `wrangler.scheduler-reminders.jsonc`: own worker name (`reese-sequence-runner`), `triggers.crons` (recommend **daily at a quiet hour**, e.g. `"0 14 * * *"` = 10am ET, so day-offset schedules and quiet-hours are naturally satisfied; hourly is unnecessary — sequence granularity is days), `vars.SEQUENCES_ENDPOINT = "https://studio.bythereeses.com/api/cron/sequences"`.
- **`POST /api/cron/sequences`** (`src/app/api/cron/sequences/route.ts`) — copy `scheduler-reminders/route.ts` verbatim in structure: `export const dynamic = "force-dynamic"`, read `CRON_SECRET` (fail-closed **503** when unset — never run on an unconfigured secret), constant-time bearer compare via `node:crypto` `timingSafeEqual` (`route.ts:7`), **401** on mismatch, else `return NextResponse.json(await runDueSequences())`. Also **short-circuit 200 `{skipped:"flag_off"}` when `SEQUENCES_ENABLED` is not `"1"`** so a registered cron on a dark deploy is a guaranteed no-op.

### 3.2 Proxy composition for the cron endpoint (decision + justification)

**Decision: reuse the `/api/cron/` prefix and mirror scheduler-reminders' reach exactly — no new proxy-classifier edit for the cron path.** Justification:

- `adminProofRequired` already returns `false` for `/api/cron/` (`admin-proxy-auth.ts:196`), so `ADMIN_PROOF_ENFORCE` will not 404 it.
- The existing, working `/api/cron/scheduler-reminders` is **not** in `isStudioPublicPath` (`_worker.js:206`) yet runs in production — i.e. cron reaches the origin the same way that endpoint does today. The correct, low-risk move is to **match the proven precedent bit-for-bit** (same host, same bearer, same prefix), not to invent a new classification.
- **Verification item (must be confirmed by the builder before deploy, per the REJECT-class Active-Learning rule):** confirm *how* `/api/cron/scheduler-reminders` actually reaches the origin in prod (origin-direct vs. proxy) and replicate that path for `/api/cron/sequences`. If — and only if — it turns out the reminders cron is silently login-walled (a 303 to the `/admin/login` 200 page that the reminder worker misreads as success), then **both** cron endpoints need an `isStudioPublicPath` entry + drift-test pin; fix them together. Do **not** add the cron path to the origin-guard bypass. The bearer secret at the origin is the trust boundary; the endpoint is a mutation surface and must not be reachable unauthenticated via `*.workers.dev`.
- Unlike the cron, the **`/api/email/unsubscribe`** endpoint is genuinely client-facing and proxy-fronted, so it **does** get the full treatment (like `/api/portal/request-link`, `_worker.js:216`): add to `isStudioPublicPath`, add `adminProofRequired(...) === false`, and pin both in the drift test (`admin-surface-classification.test.ts`). Otherwise a client's one-click unsubscribe POST is 303'd to the login page and silently dropped — a compliance failure.

### 3.3 The at-most-once ledger — `sequence_sends` (0088)

```
export const sequenceSends = sqliteTable("sequence_sends", {
  id:           text("id").primaryKey(),
  projectId:    text("project_id").notNull(),
  clientId:     text("client_id"),
  sequenceKey:  text("sequence_key").notNull(),   // "dunning" | "pre_event" | "post_delivery_review"
  stepKey:      text("step_key").notNull(),        // e.g. "dunning-day-7"
  dedupeKey:    text("dedupe_key").notNull(),      // canonical uniqueness key (see below)
  channel:      text("channel").notNull(),          // "email" | "sms"
  mode:         text("mode").notNull(),             // "draft" | "auto_send"
  status:       text("status").notNull().default("claimed"), // "claimed" | "done" | "failed"
  communicationId: text("communication_id"),        // the project_communications row produced
  attempts:     integer("attempts").notNull().default(0),
  firedAt:      text("fired_at").notNull(),
  note:         text("note"),
}, (t) => ({ dedupe: uniqueIndex("uq_sequence_sends_dedupe").on(t.dedupeKey) }));
```

- **`dedupeKey`** is the at-most-once guarantee. For dunning it binds the **invoice** so a *re-enrollment* after a new overdue invoice is a distinct row: `"dunning:{invoiceId}:{stepKey}"`. For pre-event: `"pre_event:{projectId}:{eventDateISO}:{stepKey}"` (event re-scheduling ⇒ new key, intentional). For review: `"post_delivery_review:{projectId}:{workflowStepId}"`. A `UNIQUE` index on `dedupeKey` makes a double-fire a DB-level impossibility.

### 3.4 Crash-safe, no-double-send algorithm

Mirrors `sendDueSchedulerReminders`' **mark-only-after-success** discipline (`scheduler.ts:1266–1271`), with a channel-appropriate ordering:

- **Draft steps (mark-after-success):** render → `INSERT` the `project_communications` draft → `INSERT sequence_sends(status:"done") ON CONFLICT(dedupeKey) DO NOTHING`. If two runs race, the second `ON CONFLICT` no-ops; a crash before the ledger insert at worst re-drafts next run — but the `project_communications` insert is also guarded because we check the ledger first (`SELECT dedupeKey`) and skip if present. A duplicate *draft* is benign (Tyler deletes it); we still make it near-impossible.
- **Auto-send steps (claim-first, the deliberate hardening over `reminderSentAt`):** because a duplicate *send* is a real harm (double dunning email), we **claim before sending**:
  1. `INSERT sequence_sends(status:"claimed", attempts:1) ON CONFLICT(dedupeKey) DO NOTHING`. If it did **not** insert (conflict) → another run owns this step → **skip**. If it inserted → we own it.
  2. `sendSequenceEmail(...)` (suppression + unsubscribe).
  3. On success → `UPDATE ... status:"done", communicationId`. On failure → `UPDATE ... status:"failed"` (a later run may retry `failed` rows up to `SEQUENCES_MAX_ATTEMPTS`=2, then give up + log). 
  - The claim row is the lock. Worst case on a crash *between claim and send* is a **missed** send (status stuck `claimed`), never a double — the fail-safe direction for money/compliance. A janitor branch retries `claimed` rows older than one run interval, bounded by `attempts`.
- **Single-flight:** the endpoint is bearer-only and the cron is daily; concurrent runs are not expected, but the `UNIQUE(dedupeKey)` claim makes concurrency safe regardless. Batch `limit` per run (e.g. 100 enrollments) mirrors the reminder job's bounded blast radius.

### 3.5 Quiet hours / backoff

- **Auto-send email** only fires when the run's local time (America/New_York) is within business hours (default 9:00–18:00). A daily cron at 10am ET satisfies this by construction; the guard is defensive if the cron time changes.
- **SMS is draft-only in 8c**, so TCPA quiet-hours (8pm–8am) are enforced by Tyler's manual send timing + the 8b gate; no automated SMS quiet-hours logic is needed here. (Documented so a future SMS-auto-send slice knows to add it.)
- **Backoff:** failed auto-sends retry at most `SEQUENCES_MAX_ATTEMPTS` times across subsequent daily runs (natural 24h backoff); after that the enrollment step is abandoned + logged, never hot-looped.

---

## 4. Sequence definitions + triggers

**Where config lives:** sequence + step **definitions are code constants** in `src/lib/sequences.ts` (a `SEQUENCES` array, each with `key`, `enableFlag`, `autoSendFlag`, and ordered `steps[]` — each step `{ stepKey, offset, channel, autoSendEligible, render(ctx) }`). This mirrors `sixFigureAutomationSteps` (`project-workflow-automation.ts:29`) and satisfies the "fixed set only" scope guard. **Enrollment state** lives in `sequence_enrollments` (0088); **firing state** in `sequence_sends` (§3.3).

```
export const sequenceEnrollments = sqliteTable("sequence_enrollments", {
  id:          text("id").primaryKey(),
  projectId:   text("project_id").notNull(),
  clientId:    text("client_id"),
  sequenceKey: text("sequence_key").notNull(),
  anchorKey:   text("anchor_key").notNull(),   // invoiceId | eventDateISO | workflowStepId — what this enrollment tracks
  status:      text("status").notNull().default("active"),  // "active" | "stopped" | "completed"
  enrolledBy:  text("enrolled_by").notNull().default("system"), // "system" (auto) | "Tyler"
  enrolledAt:  text("enrolled_at").notNull(),
  stoppedAt:   text("stopped_at"),
  stopReason:  text("stop_reason"),
}, (t) => ({ uq: uniqueIndex("uq_sequence_enrollment").on(t.sequenceKey, t.anchorKey) }));
```

`runDueSequences(now)` each run: (a) **auto-enroll** — evaluate each sequence's trigger over canonical tables and `INSERT ON CONFLICT DO NOTHING` an `active` enrollment; (b) **re-check stop conditions** and mark `completed`/`stopped`; (c) for each `active` enrollment, compute which steps are **due** (offset reached) and **not yet in `sequence_sends`**, apply the frequency cap (§2.3) + suppression (§2.1), then draft or auto-send (§3.4).

### 4.1 Dunning
- **Trigger / enroll:** an `invoices` row with reconciled status `overdue` and client-payable balance > 0 (`sales.ts:84`, `:17`). `anchorKey = invoiceId`.
- **Steps (email):** `dunning-day-1`, `dunning-day-7`, `dunning-day-14`, offsets measured in **days past `invoices.dueDate`**. Three steps, then stop.
- **Stop:** invoice becomes `paid`/`partially_paid`-to-zero/`void`, or balance ≤ 0 → enrollment `completed`, no further step. Re-checked at fire time (§2.4).
- **`autoSendEligible: true`** (but auto-send only if `SEQUENCES_DUNNING_AUTOSEND=1`; default draft).

### 4.2 Pre-event nudges
- **Trigger / enroll:** a `projects` (or `project_events`) row with `eventDate` in the future. `anchorKey = eventDateISO`.
- **Steps (email), each conditional on live state at fire time:**
  - `pre-event-45` / `pre-event-14` **questionnaire-not-filled** — fire only if **no** `questionnaireResponses` row exists for the project (`schema.ts:260`). Skip (and don't consume the step) if a response exists.
  - `pre-event-30` / `pre-event-7` **timeline-call-not-booked** — fire only if **no** confirmed `schedulerBookings` for the project of the timeline/planning meeting type (`schema.ts:168`, `status="confirmed"`).
  - Offsets measured in **days before `eventDate`**.
- **Stop:** the condition resolves (questionnaire submitted / call booked), or the event date passes → `completed`.
- **`autoSendEligible: true`** (auto-send only if `SEQUENCES_PREEVENT_AUTOSEND=1`; default draft).

### 4.3 Post-delivery review
- **Trigger / enroll:** the `gallery-delivery` workflow step (`postWeddingDeliveryStepKeys`, `project-workflow-automation.ts:19`) reaches a terminal `done`/`completed` status in `project_workflow_steps` (`schema.ts:339`). `anchorKey = workflowStepId`.
- **Step (email):** `review-request-delay`, offset = **N days after** the step completed (default 3). Single step.
- **Stop:** n/a (single step; completes after firing).
- **`autoSendEligible: false`** → always a draft (a review ask should be personal; §1.2).

### 4.4 Enroll / unenroll
- **Auto-enroll** by the runner (idempotent `ON CONFLICT`).
- **Explicit admin control:** `setSequenceEnrollmentAction(projectId, sequenceKey, action)` server action (admin session + Phase-6 admin proof) to `stop` (unenroll — sets `status:"stopped"`, no further steps) or re-`activate`. A project-page badge shows active sequences + last fired step. No agent/MCP surface for enroll/unenroll (config authority stays with Tyler + the runner).

---

## 5. Flag + rollout

### 5.1 Flags (all OFF by default)
- `SEQUENCES_ENABLED` — master. Unset/≠`"1"` ⇒ the cron endpoint returns `{skipped:"flag_off"}` and `runDueSequences` is a no-op. Read in the function body (not an `env=process.env` default param — TS2559, Active-Learning Log).
- Per-sequence enable: `SEQUENCES_DUNNING`, `SEQUENCES_PREEVENT`, `SEQUENCES_REVIEW` — each must be `"1"` for that sequence to enroll/fire. A sequence off ⇒ its enrollments are neither created nor advanced.
- Per-sequence auto-send opt-in: `SEQUENCES_DUNNING_AUTOSEND`, `SEQUENCES_PREEVENT_AUTOSEND` — default unset ⇒ **draft**. Only when ON (and the step is `autoSendEligible` and channel `email`) does a step auto-send. `SEQUENCES_REVIEW` has no auto-send flag (draft-only by design).
- Tunables: `SEQUENCES_MAX_PER_CLIENT_PER_WEEK` (3), `SEQUENCES_MAX_ATTEMPTS` (2). Centralize all flag reads in `sequences.ts` so they can grow to three-state like `ADMIN_PROOF_ENFORCE`/`CSP_MODE` if ever wanted.

### 5.2 Additive migration + dark ship
- `0088` adds `sequence_enrollments`, `sequence_sends`, `email_suppressions` — **all new tables**, no column changes to existing tables. Because these are read/written **only** by the flag-gated runner and the unsubscribe endpoint (not an always-on query surface like `0087`'s `clients` columns were), the migration is **not** deploy-order-critical; it can be applied dark anytime. Still apply via the repo's idempotent `CREATE TABLE IF NOT EXISTS` direct `d1 execute --file` pattern (do **not** blanket `migrations apply --remote`; the `d1_migrations` tracker is out of sync — Active-Learning Log). Reconcile the tracker separately.
- Ship order: (1) apply `0088`; (2) deploy the app Worker (`sequences.ts`, cron route, unsubscribe endpoint, admin action) with all flags unset; (3) deploy the Pages-proxy with the `/api/email/unsubscribe` classifier edits + drift test (the cron path is unchanged pending the §3.2 verification); (4) — Tyler steps, §5.4.

### 5.3 Rollback
- **Flag-only + un-register-cron**, instant and non-destructive:
  - Unset/`0` `SEQUENCES_ENABLED` ⇒ runner no-ops; nothing enrolls, drafts, or sends.
  - Delete the cron trigger (or the `reese-sequence-runner` worker) ⇒ the evaluator never runs.
- `0088` tables are additive and inert when the flags are off; no down-migration. **Do not drop `email_suppressions` on rollback** — a client's unsubscribe must survive a feature toggle (same rule as `sms_suppressions`, 8b §5.3).
- Normal deploy gate: `npm run lint` / `build` **exit code** / `deploy:preflight` + source-drift; backup → capture rollback version → deploy → health-check → rollback-on-failure.

### 5.4 Enable runbook (Tyler steps — not automated, guardrail #2)
1. Confirm `RESEND_API_KEY`/`RESEND_FROM_EMAIL` set (already live for existing email). Set `UNSUBSCRIBE_SECRET`, `CRON_SECRET` (reuse the existing reminders `CRON_SECRET` if the endpoints share the bearer, or set a dedicated one).
2. Register the `reese-sequence-runner` cron (`wrangler deploy -c wrangler.sequence-runner.jsonc`).
3. Set `SEQUENCES_ENABLED=1` and **one** sequence flag (e.g. `SEQUENCES_REVIEW=1`) → watch the **drafts** appear for a cycle. Auto-send flags stay OFF.
4. Only after observing drafts read correctly, optionally flip a single `SEQUENCES_<NAME>_AUTOSEND=1` for an email sequence.
5. Send a test: enroll a fixture project, run the cron manually (bearer POST), confirm a draft/suppression/ledger row appears and the unsubscribe link suppresses.

---

## 6. Config / secrets, test plan, tasks

### 6.1 Config / secrets (add to the "Who Has Access" inventory in `docs/studio-agent-access.md`)

| Name | Store | Consumer | Notes |
| --- | --- | --- | --- |
| `SEQUENCES_ENABLED` | app Worker var | `sequences.ts` runner gate | New. Master flag, default OFF. |
| `SEQUENCES_DUNNING` / `_PREEVENT` / `_REVIEW` | app Worker var | per-sequence gate | New. Default OFF. |
| `SEQUENCES_DUNNING_AUTOSEND` / `_PREEVENT_AUTOSEND` | app Worker var | auto-send opt-in | New. Default OFF ⇒ draft. |
| `SEQUENCES_MAX_PER_CLIENT_PER_WEEK` / `SEQUENCES_MAX_ATTEMPTS` | app Worker var | frequency cap / retry bound | New. Defaults 3 / 2. |
| `UNSUBSCRIBE_SECRET` | app Worker secret | unsubscribe token HMAC | New. Fail-closed 400 if unset (verify fails). Never log. |
| `CRON_SECRET` | app Worker secret | `/api/cron/sequences` bearer | Existing (reused from reminders) or dedicated. Fail-closed 503 if unset. |
| `SEQUENCES_ENDPOINT` | `sequence-runner` worker var | split worker → app | New. `https://studio.bythereeses.com/api/cron/sequences`. |

### 6.2 Test plan (per file)
- **`src/lib/sequences.test.ts`** — (a) **idempotency / no-double-send:** two consecutive `runDueSequences` runs over the same fixtures produce exactly one `sequence_sends` row per due step and exactly one `project_communications` draft (the `UNIQUE(dedupeKey)` + ledger check hold); a simulated crash *after* draft insert but *before* ledger insert does **not** double-draft on re-run; an auto-send claim conflict skips (no second send — spy on `sendSequenceEmail`). (b) **auto-send-vs-draft:** with all autosend flags off, every eligible step yields a `status:"draft"` comm and **zero** `sendSequenceEmail` calls; with `SEQUENCES_DUNNING_AUTOSEND=1`, an eligible dunning email auto-sends (claim→send→done) while pre-event/review still draft; an **sms** step never auto-sends regardless of flags. (c) **flag-off:** `SEQUENCES_ENABLED` unset ⇒ zero enrollments, zero comms, zero sends. (d) **dunning-stops-on-paid:** an enrolled invoice flipped to `paid`/`void`/zero-balance between runs marks the enrollment `completed` and fires **no** further step. (e) **frequency cap:** a client at `SEQUENCES_MAX_PER_CLIENT_PER_WEEK` is skipped (no ledger row consumed). (f) **pre-event conditionals:** questionnaire-response present ⇒ questionnaire steps skip; confirmed timeline booking present ⇒ call steps skip.
- **`src/lib/email-suppression.test.ts`** — `sendSequenceEmail` to a suppressed address returns `suppressed` + **zero** Resend calls; a non-suppressed send includes `List-Unsubscribe` + `List-Unsubscribe-Post` headers (assert against a fetch spy); unsubscribe token verifies constant-time and is scoped to `purpose="sequences"`.
- **`src/app/api/cron/sequences/route.test.ts`** — `503` when `CRON_SECRET` unset; `401` on wrong bearer; `200 {skipped:"flag_off"}` when `SEQUENCES_ENABLED` off even with a valid bearer; valid bearer + flag on invokes `runDueSequences` once; constant-time compare used (not `===`).
- **`src/app/api/email/unsubscribe/route.test.ts`** — bad/absent token ⇒ 400 (fail closed); valid one-click POST ⇒ `email_suppressions` row (`INSERT ON CONFLICT DO NOTHING`, replay is idempotent, no UPDATE); a token for email A cannot suppress email B; neutral 200 (no enumeration).
- **`src/lib/admin-surface-classification.test.ts`** (drift) — `adminProofRequired("/api/email/unsubscribe") === false` and it is an `isStudioPublicPath` member, pinned against the proxy predicates.
- **No-agent-path guard** (in `sequences.test.ts` or `studio-mcp.test.ts`) — assert no `studio-mcp` tool imports/exposes `runDueSequences`/`sendSequenceEmail`; a hostile agent body cannot enroll, draft, or send a sequence message (mirrors the 8b `sms-guard` posture).
- **Manual/staging** — enroll a fixture project per sequence, POST the cron with the real bearer, verify drafts + ledger + suppression + a real unsubscribe round-trip.

### 6.3 Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk |
| --- | --- | --- | --- |
| 1 | Migration `0088` + Drizzle models: `sequence_enrollments`, `sequence_sends` (UNIQUE dedupe), `email_suppressions`. Additive/dark (no deploy-order constraint) | S | Low |
| 2 | `src/lib/sequences.ts`: fixed `SEQUENCES` definitions + templates, trigger evaluators (dunning via `sales.ts` helpers; pre-event via questionnaire/booking state; review via workflow step), `runDueSequences` (enroll → stop-check → due-step → cap → suppression → draft/auto-send), the claim-first ledger algorithm | **L** | **High** (idempotency + auto-send correctness; the crux) |
| 3 | Email unsubscribe: `sendSequenceEmail` wrapper (suppression check + `List-Unsubscribe` headers), `sendResendEmail` `headers` pass-through, signed-token helper, `POST/GET /api/email/unsubscribe` | M | **High** (compliance; one-click must not drop) |
| 4 | `systemActor` on `project-communications.ts` + wiring draft steps through `createProjectCommunication` (no widening of the agent clamp) | S | Med |
| 5 | Split worker `workers/sequence-runner.ts` + `wrangler.sequence-runner.jsonc` + `POST /api/cron/sequences` route (bearer, fail-closed, flag short-circuit). **Verify cron reach vs. scheduler-reminders precedent (§3.2) before deploy** | M | **High** (silent-drop if the cron reach is misjudged) |
| 6 | Proxy composition for `/api/email/unsubscribe` (`isStudioPublicPath` + `adminProofRequired` exemption) + drift test | S | Med |
| 7 | Admin enroll/unenroll action + project-page sequence badge | S | Low |
| 8 | Flags + tunables (centralized reads), enable runbook, "Who Has Access" doc update, dark rollout then Tyler flag-flip | S | Low |
| 9 | Tests: `sequences.test.ts` (idempotency/no-double-send, auto-send-vs-draft, flag-off, dunning-stops-on-paid, cap, pre-event conditionals), suppression test, cron-route test, unsubscribe-route test, drift test, no-agent-path guard | M | Med |

Highest-risk items: **#2** (the idempotent runner + claim-first auto-send — a bug here means a double dunning email or a spam loop), **#3** (one-click unsubscribe compliance + no silent drop), and **#5** (cron reach — mis-judging the proxy composition silently drops every run). The canonical-safety guarantee rests on: sequences being config+template driven with **no agent/prompt-injection path** to a recipient, body, or send (§1.4); auto-send being an email-only, per-sequence, default-off opt-in that clears the scheduler-reminders bar (§1.1–1.2); SMS staying draft-only via the untouched 8b gate (§2.2); every send being suppression- and frequency-capped (§2.1, §2.3); dunning never firing on paid/void and stopping at fire time (§2.4); and at-most-once enforced by `UNIQUE(dedupeKey)` with mark-after-success (drafts) / claim-before-send (auto-send) (§3.4). The `sequences.test.ts` idempotency + auto-send-vs-draft assertions and the unsubscribe/suppression tests must pass before any `SEQUENCES_*` flag is flipped.
