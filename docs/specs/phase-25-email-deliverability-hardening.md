# Phase 25 — Email deliverability hardening (confidence backlog closer)

Status: spec (build-ready). No code in this document.
Scope owner: autonomous build loop. Enablement: **Tyler** (DNS records are his to add; every new
flag stays off until he flips it).

This is the last open item in the confidence backlog (`docs/handoff-build-state.md` §4: "golden-path
e2e — built, config-verification preflight — built, staged log→enforce enablement, **email
deliverability hardening**"). It is explicitly a **low-risk hardening pass**, not a rebuild: the
audit (`docs/email-deliverability.md`) already found the sending stack "architecturally solid," and
Phase 24 (`docs/specs/phase-24-resend-bounce-webhook.md`, already built — see §1 below) already
closed the two real *code* gaps the audit flagged (bounce/complaint webhook, the
`sendInquiryReplyEmail` suppression bypass). What's left is DNS runbook completeness, a couple of
regression guards that pin already-correct behavior so it can't silently drift, one new safety
backstop (a daily send cap), and one new observability signal (bounce/complaint rate). Most of this
phase is config-at-rest + docs; the code surface is intentionally small.

All line numbers are current as of this commit; re-verify if the cited files change shape before
build.

---

## 0. Why this exists

`docs/email-deliverability.md` (audit, dated 2026-07-07) named five prioritized fixes. Fixes #2 and
#3 (the bounce/complaint webhook and the `sendInquiryReplyEmail` suppression bypass) are **already
shipped** — Phase 24 built `src/lib/resend-webhook.ts`, `src/app/api/resend/webhook/route.ts`, wired
`WEBHOOK_JOBS["resend-webhook"]` + the `resend-webhook-signature` misconfiguration WARN into
`src/lib/system-health.ts`, and `src/lib/email.ts:172-181`'s `sendInquiryReplyEmail` now checks
`isEmailSuppressed` before any Resend call. The audit's List-Unsubscribe scoping (fix context, §1b)
and From-domain consistency (§1a) were already correct as designed and remain so today — confirmed
against the live code in §2 below, not re-audited from scratch.

What's actually left, mapped 1:1 to the audit's remaining open items and the task brief:

1. **Fix #1 (DNS/auth posture)** — SPF/DKIM/DMARC still live entirely in the Resend dashboard and
   Cloudflare DNS zone; this repo cannot see them. `docs/email-deliverability.md` §3 already has a
   thorough manual runbook. What's missing: (a) a *concrete graduation criterion* for the
   `p=none → p=quarantine` DMARC glide path (the existing doc says "a multi-week-to-multi-month
   glide path" but never names the gate), and (b) a live, independently-queryable check —
   `scripts/config-preflight.mjs` today only asks Resend's own API "is this domain verified" (which
   reflects Resend's view of SPF+DKIM), never queries DNS directly, and never checks DMARC at all
   (DMARC is entirely outside Resend's remit — nothing in the pipeline verifies it exists).
2. **Fix #4 context (List-Unsubscribe scoping) — already correct, needs a regression guard, not a
   fix.** The classification (sequence email carries RFC 8058 headers; every transactional sender
   does not) is exactly right today. The risk is a *future* sender being added without anyone
   re-reading the audit. This phase adds a guard test that pins the classification so an
   unclassified new sender fails CI, not a silent audit-drift.
3. **From-domain alignment — already consistent, same regression-guard treatment.** One shared
   resolution point (`resendRequest`, `src/lib/email.ts:52`) already backs every sender. Phase 24
   already closed the one path that used to drift (`sendInquiryReplyEmail`'s old raw `fetch`). This
   phase adds a guard that keeps it that way.
4. **New: a daily send-volume backstop for sequences.** Nothing in `src/lib/sequences.ts` today caps
   *total* auto-send volume across a run — only a per-client weekly cap
   (`SEQUENCES_MAX_PER_CLIENT_PER_WEEK`, `sequences.ts:61-63`) exists. A misconfiguration (a bug that
   defeats the per-client cap, or a future refactor that raises the `active`/`failed` query limits)
   has no independent backstop. This phase adds one, off by default.
5. **New: a bounce/complaint-rate signal on `/system-status`.** Phase 24 already added a lifetime
   suppression-count INFO signal (`system-health.ts:340-368`, `key: "email-suppressions"`). It never
   escalates and has no time window. This phase adds a trailing-7-day rate-style WARN signal
   alongside it (additive; the existing signal is untouched).
6. **Explicitly out of scope** (task brief, confirmed as correctly out of scope for a
   solo-photographer volume CRM — see `docs/email-deliverability.md` §3.5 for the dedicated-IP/
   dedicated-subdomain reasoning this phase inherits): a dedicated sending IP, an ESP migration,
   flipping DMARC straight to enforcement, and open/click tracking (which would also require an
   `html` email body — none exist yet, §1c of the audit).

---

## 1. Invariants

- **I1 — DNS check is read-only and secret-free.** The new `config-preflight` DNS check is a plain
  `GET` against a public DNS-over-HTTPS resolver (no API key, no auth header, no write). It never
  touches Resend/Cloudflare credentials and never prints anything but public DNS record content —
  consistent with the existing script's "never print a secret value" doctrine
  (`scripts/config-preflight.mjs:13-15`).
- **I2 — List-Unsubscribe classification is guarded, not re-implemented.** The new guard test
  enumerates every exported sender in `src/lib/email.ts` against a maintained allowlist of which
  senders must/must-not carry `List-Unsubscribe`; it fails loudly if a new sender is added without an
  explicit entry. It changes no sender's behavior.
- **I3 — Single-transport invariant is guarded.** A grep-style guard test asserts no file under
  `src/` other than `src/lib/email.ts` contains a literal `api.resend.com` — the exact class of drift
  Phase 24 already fixed once (`sendInquiryReplyEmail`'s old duplicated `fetch`,
  `docs/specs/phase-24-resend-bounce-webhook.md` §5). This is a permanent regression guard, not a new
  feature.
- **I4 — The daily send cap defaults OFF and is a strict zero-behavior-change no-op while off.**
  Reads `process.env.SEQUENCES_DAILY_SEND_CAP_ENABLED === "1"` (matches the existing sibling family's
  idiom, `flagOn()` at `sequences.ts:46-48`, used by every other `SEQUENCES_*` flag). Unset or any
  value other than the literal string `"1"` → the cap check is skipped entirely; `runDueSequences`
  behaves byte-for-byte as it does today.
- **I5 — The cap fails toward under-send, never toward a crash or a false send.** When tripped, the
  affected step is skipped exactly the way `autoSendStep` already skips on an unconfigured unsubscribe
  secret (`sequences.ts:608-610`) — no claim row inserted, no Resend call, the step remains due and is
  re-evaluated on the next run. The cap can only ever *reduce* send volume, never increase it, and
  never converts an auto-send decision into a silent failure elsewhere in the ledger state machine.
- **I6 — A tripped cap is visible, not silently swallowed.** Every run that trips the cap at least
  once records it via the existing `job_runs` heartbeat mechanism (`src/lib/job-runs.ts`), under a
  dedicated, non-money `JobName` — mirroring the existing `lead-form-global-flood` visibility-counter
  pattern (`job-runs.ts:92-98`), not the money-critical `REQUIRED_JOBS` pattern.
- **I7 — The new bounce/complaint-rate signal is WARN-at-most, never CRITICAL.** It degrades
  deliverability hygiene visibility, not money state or canonical data integrity — same posture as
  the existing `resend-webhook` WEBHOOK_JOBS entry (`system-health.ts:122-124`, "should never page").
  It never gains an `alertKey` and is never wired into the immediate-critical-alert path.
- **I8 — No migration.** `email_suppressions` (`src/db/schema.ts:815-820`) and `sequence_sends`
  already carry every column this phase reads (`suppressed_at`, `source`, `firedAt`, `status`,
  `mode`). Verified in §6.
- **I9 — Nothing here ships as a live send-behavior change without Tyler's flag flip.** Per
  `AGENTS.md` guardrail 1 ("everything ships DARK"): the daily-cap flag off is the default and the
  guard tests/DNS check/health signal are all either pure reads or CI-time guards — none of them can
  alter what gets sent to a real client inbox on a dark deploy.

---

## 2. Ground truth (current code, re-verified for this spec)

| Claim | File:line | Confirms |
| --- | --- | --- |
| `resendRequest` — single Resend transport, single `RESEND_FROM_EMAIL` resolution | `src/lib/email.ts:32-74`, default at `:52` | From-domain consistency (item 3) |
| `sendSequenceEmail` — the only sender carrying `List-Unsubscribe`/`List-Unsubscribe-Post` | `src/lib/email.ts:128-163`, headers at `:145-148` | List-Unsubscribe scoping (item 2) is already correct |
| `sendInquiryReplyEmail` now suppression-gated (Phase 24 fix #3 landed) | `src/lib/email.ts:172-181` | The audit's fix #3 is closed; no residual gap here |
| `sendAdminAlertEmail`, `sendPortalMagicLinkEmail`, `sendBookingEmails`, `sendBookingReminderEmail`, `sendBookingCancellationEmail` — no `List-Unsubscribe`, transactional | `src/lib/email.ts:190-336` | Correctly exempt from one-click unsubscribe |
| `sendProjectEmail` — Phase 14, transactional (reply-driven), no `List-Unsubscribe` | `src/lib/email.ts:81-88` | Correctly exempt |
| Unsubscribe route: confirm-then-`POST`, writes `email_suppressions` + voids queued sequence drafts | `src/app/api/email/unsubscribe/route.ts:87-135` | The one-click flow this phase's header work feeds is live and correct |
| Per-client weekly send cap (the only volume guardrail that exists today) | `src/lib/sequences.ts:61-63,363-374` | Confirms no *daily/global* cap exists yet — item 4's gap |
| `runDueSequences` cadence: **once daily**, 14:00 UTC | `wrangler.sequence-runner.jsonc:11` | The daily cap's natural window is one cron tick, not a rolling clock |
| `active` enrollment loop bound to `limit(100)`; `retryFailedSends` bound to `limit(100)` | `sequences.ts:937-940,691-694` | Today's soft ceiling on worst-case per-run auto-send volume — the new cap is a backstop *independent* of these limits, not a replacement (a future refactor could raise them without anyone noticing) |
| `email_suppressions` schema: `email` PK, `suppressed_at`, `source` (`"unsubscribe_link" \| "admin" \| "bounce" \| "complaint"`), `note` | `src/db/schema.ts:810-820` | No migration needed for the new bounce-rate read (item 5) |
| Existing lifetime suppression-count INFO signal (Phase 24 §6) | `src/lib/system-health.ts:340-368`, `key: "email-suppressions"` | The new 7-day signal is additive alongside this, not a replacement |
| `WEBHOOK_JOBS["resend-webhook"]` — WARN-only, `criticalFailures: Number.POSITIVE_INFINITY` | `system-health.ts:117-125` | The pattern this phase's new health signal mirrors (I7) |
| `resend-webhook-signature` misconfiguration WARN (recent+repeated rejects, no recent success) | `system-health.ts:127-138,325-337` | The pattern the daily-cap-tripped heartbeat mirrors (I6) |
| `lead-form-global-flood` — non-alerting visibility counter, deliberately excluded from any health catalog | `job-runs.ts:92-98` | The exact shape for the new cap-tripped `JobName` |
| `SECRET_ENV_NAMES` redaction list | `job-runs.ts:29-43` | No new secret is introduced by this phase; nothing to add here |
| `config-preflight.mjs` — Resend check is `/v1/domains` only (Resend's own verified-status opinion), never a direct DNS query, never DMARC | `scripts/config-preflight.mjs:422-438` | The exact gap item 1's new check closes |
| `config-preflight.mjs` network layer — injectable `fetchJsonWithTimeout`, per-provider try/catch, non-network eval functions kept pure/testable | `config-preflight.mjs:357-420,540-593` | The pattern the new DMARC check must mirror |
| `resendSendingDomain()` — derives the sending domain from `RESEND_FROM_EMAIL` | `config-preflight.mjs:228-232` | Reused as-is to target the DMARC lookup at the same domain (no new domain-derivation logic) |
| Migration numbering: `0098` is the latest landed; `0099` is claimed by the (separate, in-flight) autopay phase | `migrations/0098_meeting_notes_booking_link.sql`; `docs/specs/phase-13-autopay-card-on-file.md:135-139` | Confirms this phase's "no migration" claim doesn't need a slot; if a future revision ever needs one, it is **not** `0099` |

---

## 3. Design decisions

### 3.1 DNS/auth posture — runbook + config-preflight DNS check

**Runbook (Tyler-owned, this section is the authoritative copy for this phase — no other doc is
edited):**

The exact record shapes (SPF at Resend's `send.` subdomain, DKIM CNAMEs, DMARC at `_dmarc.<apex>`)
are already fully documented in `docs/email-deliverability.md` §3.1–§3.4 and are **not repeated or
forked here** — that document remains the canonical copy-the-exact-value-from-the-dashboard
reference. What this phase adds is the one thing that document didn't name: **a concrete graduation
gate** for the DMARC glide path.

> **DMARC graduation criteria (fills the gap in `docs/email-deliverability.md` §3.3):**
> 1. Start at `p=none; rua=mailto:<address>; pct=100` (already specified).
> 2. **Move to `p=quarantine`** only once the `rua` aggregate reports have shown **100% SPF+DKIM
>    alignment for every real Reese Photography sending source, for at least 4 consecutive weekly
>    report cycles**, with zero unexplained third-party sending sources appearing in the reports (a
>    third-party source would mean something else is sending as `bythereeses.com` — investigate
>    before tightening, don't tighten through it).
> 3. **Move to `p=reject`** only after `p=quarantine` has likewise run clean (no legitimate mail
>    misclassified, confirmed by Tyler checking his own spam folder and spot-checking client
>    complaints) for **at least another 4 weeks**.
> 4. This is a Tyler-paced, manual decision — no code in this phase or any other automatically
>    changes the DMARC record. `npm run config:preflight` (§3.1.2 below) only ever *reports* the
>    current policy value; it never writes DNS.

**Config-preflight extension (`scripts/config-preflight.mjs`) — new, read-only DMARC check:**

- **Why DMARC specifically, and not a guessed-hostname SPF/DKIM check.** SPF and DKIM record names
  are Resend-account-specific and explicitly *not* guessable from this repo (the audit says "copy the
  exact name Resend shows you" for both — `docs/email-deliverability.md` §3.1–§3.2). A hardcoded
  guess (`send.<domain>` for SPF, `resend._domainkey.<domain>` for DKIM) would silently stop working
  the moment Resend's own convention shifts, producing a **false FAIL** that looks like a real
  deliverability break — worse than no check at all. Resend's existing `/v1/domains` check
  (`config-preflight.mjs:422-438`, already live) already reports SPF+DKIM verification status from
  the authoritative source (Resend's own view of its records) — that remains the SPF/DKIM check.
  DMARC, by contrast, is **always** at the fixed, universally-standardized location
  `_dmarc.<apex-domain>` regardless of ESP — a live DNS lookup there is reliable and adds real,
  independently-verified information Resend's API does not report at all (DMARC isn't Resend's
  record to manage).
- **Mechanism:** a new pure evaluator `evaluateDmarcRecord(txtRecords: string[])` (unit-testable, no
  network) that: finds a record starting with `v=DMARC1`, parses the `p=` and `rua=` tags, and
  returns `{ pass, policy, hasRua, detail }`. `pass` is true whenever a syntactically valid DMARC
  record exists — this check is about *presence and readability*, not about policy strictness (moving
  to `p=quarantine`/`p=reject` is a Tyler-paced business decision per the graduation criteria above,
  never something this script should fail on).
- **Network call:** a new `checkDmarc(env, deps)` function, injectable exactly like `checkStripe`/
  `checkResend`/`checkTwilio` (`config-preflight.mjs:385-480`), using the same
  `deps.fetchJson`/`fetchJsonWithTimeout` helper (no new HTTP client). Target: Google's public DNS-
  over-HTTPS JSON endpoint, `GET https://dns.google/resolve?name=_dmarc.<domain>&type=TXT` (no auth
  header required, unlike Cloudflare's DoH which needs an `Accept: application/dns-json` header —
  fewer moving parts). `<domain>` reuses the existing `resendSendingDomain(env)` helper
  (`config-preflight.mjs:228-232`) so the two checks always target the same domain by construction.
  Runs **unconditionally** (unlike the Resend/Stripe/Twilio checks, it needs no API key — DNS is
  public) — the only reason to skip it is a network failure, which degrades to `FAIL` with a network-
  error detail exactly like every other provider check's own `catch` branch.
- **Report integration:** one new row under a new `"DNS (DMARC)"` section in `buildReport`
  (`config-preflight.mjs:542-593` already groups `providerRows` by `section` — no structural change
  to the report builder, just one more section key).
- **What this does NOT do:** no SPF/DKIM DNS lookup (reasoned above), no automatic remediation, no
  write of any kind, no new dependency (reuses `fetch`, same as every other check in this file).

### 3.2 List-Unsubscribe / List-Unsubscribe-Post — guard, not a fix

Current state is correct (§2 table) and unchanged by this phase. The one code touch is a new,
narrowly-scoped guard test — `src/lib/email-deliverability-guard.test.ts` — that:

1. Imports every exported sender function from `src/lib/email.ts` (or, more robustly, a maintained
   `const SENDER_CLASSIFICATION` map co-located in that file listing each exported sender name against
   `"transactional" | "sequence"`) and asserts the map's membership stays in sync with the module's
   actual exports (a new exported sender with no entry fails the test with a clear message: "classify
   this sender as transactional or sequence before merging").
2. For each entry classified `"sequence"`, drives a real call and asserts the outbound Resend request
   body's `headers` include both `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-
   Click` (RFC 8058).
3. For each entry classified `"transactional"`, asserts the outbound request has **no**
   `List-Unsubscribe` header at all.

This test changes no runtime behavior — it only pins the classification the audit already validated,
so a future sender addition either gets explicitly classified or fails CI loudly (never a silent
drift back into the state the audit originally flagged).

### 3.3 From-domain alignment — guard, not a fix

Same treatment as §3.2: one new assertion (can live in the same
`email-deliverability-guard.test.ts` file) that greps `src/` for the literal substring
`api.resend.com` and asserts it appears in **exactly one** file, `src/lib/email.ts` — mirroring the
narrower single-file version of this same guard Phase 24 already wrote for one file pair
(`docs/specs/phase-24-resend-bounce-webhook.md` §10 test 10: "assert `inbound-inquiry.ts` no longer
contains a literal `api.resend.com`"). This phase generalizes that one-off assertion into a permanent,
repo-wide regression guard so the *next* accidental duplicate transport (wherever it appears) fails
CI instead of silently drifting the From-address/header logic out of sync with `email.ts`.

### 3.4 Daily send-volume backstop for sequences

**New flags** (read in `src/lib/sequences.ts`, alongside the existing `flagOn()`/`intEnv()` helpers
at `sequences.ts:46-59`):

- `SEQUENCES_DAILY_SEND_CAP_ENABLED` — `=== "1"` (matches the `flagOn()` idiom every sibling
  `SEQUENCES_*` flag already uses). Default OFF.
- `SEQUENCES_DAILY_SEND_CAP` — `intEnv(..., 50)` (same helper as `SEQUENCES_MAX_PER_CLIENT_PER_WEEK`,
  `sequences.ts:54-59`). Only consulted when the enabled flag above is `"1"`; a misconfigured value
  (non-numeric, negative) falls back to the default exactly like every other `intEnv` tunable already
  does.

**What it counts:** total **auto-sent** (`mode = "auto_send"`, `status = "done"`) rows in
`sequence_sends` with `firedAt` in the trailing 24 hours — i.e. actual Resend dispatches, not drafts
(a drafted-for-review email never leaves the CRM without Tyler's click, so it carries no
deliverability risk and should not consume the cap) and not "claimed"/"failed" rows (those are
retried or abandoned, not confirmed sends). This mirrors the existing `overFrequencyCap` query shape
(`sequences.ts:363-374`) almost exactly — same table, same trailing-24h window pattern, one more
`WHERE` clause (global instead of per-`clientId`).

**Enforcement points** — both existing auto-send call sites gain the same one-line check
`autoSendStep` already uses for the unsubscribe-secret gate (`sequences.ts:608-610`, "Never auto-send
… skip (no claim, no send)"):

- `autoSendStep` (`sequences.ts:596-672`): before the claim-then-send sequence, if the cap is enabled
  and already at/over threshold, return without claiming or sending — the step stays due and
  re-evaluates next run (I5).
- `retryFailedSends` (`sequences.ts:688-765`): same check before the compare-and-swap claim
  (`sequences.ts:723-728`) — a retry attempt also counts against, and is blocked by, the same daily
  ceiling.

**Why a global backstop, not a smarter one:** the task brief calls for "a simple daily send-cap...
so a misconfigured sequence can't burst-send" — this is explicitly a blunt circuit breaker, not a
per-sequence-type or adaptive-throttling system. The existing per-client weekly cap
(`SEQUENCES_MAX_PER_CLIENT_PER_WEEK`) already bounds *repeat* mail to one address; this phase's cap
bounds *aggregate* volume across all clients in a single run — the failure mode it defends against is
categorically different (a bug or future refactor that defeats/bypasses the per-client cap, or raises
the `active`/`failed` query `limit(100)` ceilings without anyone revisiting the volume implications).

**Visibility when tripped (I6):** the first time in a run that the cap check causes a skip,
`runDueSequences` calls `recordJobRun("sequences-daily-cap-tripped", false, "<n> auto-sends in the
trailing 24h reached the SEQUENCES_DAILY_SEND_CAP of <cap>")` — a **new, non-money** `JobName`
appended to the union in `job-runs.ts:69-98`, deliberately modeled on `lead-form-global-flood`
(`job-runs.ts:92-98`: "a visibility counter... NON-ALERTING... a raw counter/heartbeat"), not on any
`REQUIRED_JOBS`/money-critical pattern. A run that completes **without** tripping the cap calls
`recordJobRun("sequences-daily-cap-tripped", true)` once, so the signal self-resets to `ok` the next
day the cap isn't hit (mirrors `resend-webhook`'s per-event ok/fail recording, not a one-way ratchet).
One new `computeSystemHealth` entry surfaces this on `/system-status`, in the same
`WEBHOOK_JOBS`-style shape as `resend-webhook` (`system-health.ts:117-125`): WARN at 1+ recent trip,
never CRITICAL (`criticalFailures: Number.POSITIVE_INFINITY`) — a tripped cap means the backstop
*worked*, not that anything is broken; it's worth Tyler's attention (maybe the cap needs raising for
legitimate volume growth, or maybe something really is misbehaving), never a page.

### 3.5 Bounce/complaint-rate signal on `/system-status`

Additive alongside the existing lifetime `email-suppressions` INFO signal
(`system-health.ts:340-368`) — that signal is untouched. New signal, same function
(`computeSystemHealth`), same best-effort try/catch wrapping style already used throughout that
function:

- **Data source:** `email_suppressions` rows where `suppressed_at >= now - 7 days`, grouped by
  `source` (only `bounce` and `complaint` are relevant here — `unsubscribe_link`/`admin` rows are a
  client's own choice, not a deliverability-health indicator, and stay out of this signal).
- **Why a count, not a true percentage rate.** A genuine bounce *rate* (bounces ÷ total sends) would
  need a reliable total-send denominator across every sender in §2's table — sequence auto-sends,
  admin-approved sequence-draft sends, project-thread sends, and transactional booking/portal mail —
  several of which (booking confirmations, portal magic links) aren't ledgered anywhere at all today.
  Building that cross-source denominator is a real project of its own and is **not** what the task
  brief's parenthetical "(from suppression timestamps)" calls for — it names the suppression table as
  the *sole* data source, which only supports a count. This phase ships the honest, cheaply-computed
  version: a **trailing-7-day incident count**, explicitly labeled as a count (not "%"), with a
  documented note in the signal's own `detail` string that it is a proxy, not a true volume-normalized
  rate. A future phase could add real denominators once a unified send-ledger exists across all
  senders; that is out of scope here.
- **Threshold (WARN, never CRITICAL — I7):** WARN if `bounceCount7d + complaintCount7d >= 5`, **or**
  if `complaintCount7d >= 1` alone — a single spam complaint is treated as independently
  attention-worthy regardless of bounce volume, consistent with Phase 24's framing of a complaint as
  "an unambiguous, permanent opt-out signal" (`docs/specs/phase-24-resend-bounce-webhook.md` §4.1),
  which is a materially worse signal than a hard bounce (an address someone has actively flagged as
  unwanted mail, versus one that's merely undeliverable). Both thresholds are named constants
  (`EMAIL_INCIDENT_WARN_COUNT = 5`, `EMAIL_COMPLAINT_WARN_COUNT = 1`) alongside the file's existing
  named constants (`RESEND_REJECT_FRESH_MS`/`RESEND_REJECT_MIN_COUNT`, `system-health.ts:140-141`) —
  not environment-configurable; there is no operational reason Tyler would need to retune this per-
  deploy, and an env-configurable threshold would be one more thing config-preflight would need to
  validate for nothing gained.
- **Signal shape:**
  ```
  { key: "email-bounce-complaint-rate-7d",
    label: "Email bounce/complaint rate (7d)",
    severity: "warn" | "ok",
    detail: "<bounceCount7d> bounce(s), <complaintCount7d> complaint(s) in the trailing 7 days
             (count-based proxy, not a true send-volume rate — see phase-25 spec §3.5).",
    value: bounceCount7d + complaintCount7d }
  ```
- **No new query surface for agents** — same boundary Phase 24 already drew for the suppression-count
  signal (`docs/specs/phase-24-resend-bounce-webhook.md` §6: "deliberately *not* exposed as an
  agent/MCP tool"). This signal flows through the same `computeSystemHealth` → `/system-status` +
  digest pipeline and nowhere else.

### 3.6 Out of scope (explicit, per task brief)

- **Dedicated sending IP** — not justified at current volume; unchanged from the audit's own
  conclusion (`docs/email-deliverability.md` §3.5).
- **ESP migration** (away from Resend) — no motivating problem exists; not evaluated in this phase.
- **DMARC enforcement on day one** — the graduation criteria in §3.1 are the explicit alternative;
  `p=quarantine`/`p=reject` are multi-week-paced decisions, never a same-phase flip.
- **Open/click tracking** — would require an `html` email body (none exist today, audit §1c) and
  reintroduces tracking-pixel/link-rewriting deliverability tradeoffs of its own; a separate phase's
  decision if/when HTML email is ever built.

---

## 4. Flags / enablement runbook

| Flag | Default | Effect when off | Who flips it |
| --- | --- | --- | --- |
| `SEQUENCES_DAILY_SEND_CAP_ENABLED` | unset (OFF) | Zero behavior change — `runDueSequences` sends exactly as it does today, no cap consulted | Tyler, only after confirming `SEQUENCES_DAILY_SEND_CAP` is set to a sane value for his real volume |
| `SEQUENCES_DAILY_SEND_CAP` | `50` (code default) | Only read when the flag above is `"1"` | Tyler, tune upward only if legitimate volume growth trips it |

**Enablement runbook (Tyler):**

1. Run `npm run config:preflight` after this phase deploys; confirm the new `DNS (DMARC)` section
   shows `PASS` (a DMARC record exists and parses) before relying on any of the DNS-facing claims in
   this doc. If it shows `FAIL`, add the `_dmarc.bythereeses.com` TXT record per
   `docs/email-deliverability.md` §3.3 first — nothing else in this phase depends on that record
   existing, but deliverability itself does.
2. Leave `SEQUENCES_DAILY_SEND_CAP_ENABLED` off until sequences (`SEQUENCES_DUNNING_AUTOSEND` /
   `SEQUENCES_PREEVENT_AUTOSEND`) are already live and Tyler has a sense of real daily auto-send
   volume from `/system-status` or the daily digest.
3. When ready: set `SEQUENCES_DAILY_SEND_CAP_ENABLED="1"` and (optionally) `SEQUENCES_DAILY_SEND_CAP`
   to a value comfortably above observed real volume (the code default of `50` is a conservative
   starting guess for a solo-photographer volume CRM, not a measured number — Tyler should confirm it
   against his own `/system-status` history before enabling, per the runbook step above).
4. Watch `/system-status` → "Sequences daily send cap" (new WARN-only signal, §3.4) and "Email
   bounce/complaint rate (7d)" (new WARN-only signal, §3.5) going forward — both are visible
   immediately on deploy regardless of the cap flag (the bounce/complaint-rate signal is a pure read,
   not gated by any flag; the cap-tripped signal only ever fires once the cap flag above is on).
5. Follow the DMARC graduation criteria in §3.1 at Tyler's own pace — no code or flag in this repo
   changes DMARC enforcement; that stays a manual DNS edit on his own timeline.

---

## 5. Migration

**None.** Confirmed in §2's ground-truth table: `email_suppressions` already has every column this
phase reads (`src/db/schema.ts:815-820`); `sequence_sends` already has `firedAt`/`status`/`mode` for
both the existing per-client cap query and the new daily-cap query (same table, same columns, one
more `WHERE` clause, no new index needed at this phase's volume). `job_runs`
(`src/db/schema.ts`, keyed by `job_name`) already accepts any new `JobName` string with no schema
change (Phase 24's `resend-webhook`/`resend-webhook-rejected` additions needed none either). If a
future revision of this phase ever needs a migration, the next free slot is **not** `0099`
(claimed by the in-flight autopay phase, `docs/specs/phase-13-autopay-card-on-file.md:135-139`) — it
is whatever is free after that at build time; re-check, don't assume.

---

## 6. Tests

1. **DMARC evaluator — valid record.** `evaluateDmarcRecord(["v=DMARC1; p=none; rua=mailto:hello@bythereeses.com; pct=100"])` → `pass: true`, `policy: "none"`, `hasRua: true`.
2. **DMARC evaluator — missing record.** Empty TXT array → `pass: false`, detail names the missing
   record and its expected location (`_dmarc.<domain>`).
3. **DMARC evaluator — malformed record.** A TXT value that doesn't start with `v=DMARC1` (e.g. an
   unrelated TXT record at the same name) → `pass: false`, not a throw.
4. **`checkDmarc` — network layer.** Injected `deps.fetchJson` stub returns a Google DoH-shaped
   `{ Answer: [{ data: '"v=DMARC1; p=none; ..."' }] }` body → one `PASS` row in the `DNS (DMARC)`
   section; a network error (thrown/rejected) → one `FAIL` row with the network-error detail,
   never an uncaught throw (mirrors `checkStripe`'s/`checkResend`'s own try/catch, `config-
   preflight.mjs:395-417,427-437`).
5. **`checkDmarc` runs unconditionally.** Unlike Stripe/Resend/Twilio (each individually skippable on
   a missing API key), the DMARC check has no `SKIP` branch for missing config — assert it always
   produces exactly one row regardless of which other env vars are set/unset.
6. **List-Unsubscribe guard — sequence senders carry both RFC 8058 headers.** Drive `sendSequenceEmail`
   (with a stubbed `fetch`) and assert the outbound request's `headers` include `List-Unsubscribe`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
7. **List-Unsubscribe guard — every transactional sender omits both headers.** Drive each of
   `sendAdminAlertEmail`, `sendPortalMagicLinkEmail`, `sendBookingEmails`, `sendBookingReminderEmail`,
   `sendBookingCancellationEmail`, `sendInquiryReplyEmail`, `sendProjectEmail` and assert none of their
   outbound request bodies include a `headers.List-Unsubscribe` key.
8. **List-Unsubscribe guard — unclassified sender fails loudly.** A test-only fixture that adds a
   function name to `email.ts`'s exports without a corresponding classification-map entry causes the
   guard's membership-sync assertion to fail with an actionable message (this can be asserted by
   testing the classification-sync helper directly against a synthetic export list, without needing to
   actually add an unclassified export to the real module).
9. **Single-transport guard.** Repo-wide grep for the literal substring `api.resend.com` under `src/`
   returns matches in **exactly one** file, `src/lib/email.ts`.
10. **Daily cap — flag off is a no-op.** With `SEQUENCES_DAILY_SEND_CAP_ENABLED` unset, seed
    `sequence_sends` with `SEQUENCES_DAILY_SEND_CAP` (default 50) + 10 auto-sent rows in the trailing
    24h and drive one more eligible auto-send step through `autoSendStep` — assert it sends normally
    (cap never consulted).
11. **Daily cap — trips and skips.** With the flag on and `SEQUENCES_DAILY_SEND_CAP=2`, seed 2
    auto-sent rows in the trailing 24h, then drive a 3rd eligible step through `autoSendStep` — assert
    zero Resend calls, no ledger row claimed, and the step remains eligible (re-evaluates) on a
    simulated next run.
12. **Daily cap — trailing-24h window, not calendar-day.** A row fired 25 hours ago does not count
    toward the cap; a row fired 23 hours ago does (mirrors the existing per-client cap's own window
    test coverage for `overFrequencyCap`).
13. **Daily cap — retry path also respects the cap.** With the cap tripped, drive `retryFailedSends`
    over a `status="failed"` row — assert it is not claimed/sent while the cap holds.
14. **Daily cap — heartbeat on trip vs. no-trip.** A run that trips the cap records
    `sequences-daily-cap-tripped` with `ok:false` and a detail naming the count/cap; a run that does
    not trip it records `ok:true` (self-resetting the WARN back to healthy the next clean day).
15. **`/system-status` — cap-tripped signal severity.** With a recorded `ok:false` cap-tripped
    heartbeat, `computeSystemHealth` surfaces a `warn` signal, never `critical`; with no heartbeat row
    at all, it surfaces as not-configured (`info`), mirroring the existing `WEBHOOK_JOBS` missing-row
    branch (`system-health.ts:250-258`).
16. **Bounce/complaint-rate signal — below threshold.** Seed 2 bounce rows and 0 complaint rows in the
    trailing 7 days → signal severity `ok`, `value: 2`.
17. **Bounce/complaint-rate signal — bounce+complaint combined threshold.** Seed 3 bounce + 2
    complaint rows (combined 5) in the trailing 7 days → signal severity `warn`.
18. **Bounce/complaint-rate signal — single complaint alone trips WARN.** Seed 0 bounce + 1 complaint
    row → signal severity `warn` (the complaint-alone threshold, independent of the combined count).
19. **Bounce/complaint-rate signal — window boundary.** A suppression row `suppressed_at` exactly 8
    days old is excluded; one 6 days old is included.
20. **Bounce/complaint-rate signal — read failure degrades to signal-skipped, not a thrown page.**
    Stub the `email_suppressions` read to throw — assert `computeSystemHealth` still returns a report
    (the signal is simply absent that cycle), mirroring the existing best-effort wrapping already used
    for every other block in that function.
21. **Existing lifetime `email-suppressions` signal is unchanged.** A regression check that the
    Phase-24 signal's `key`, `severity` (`"info"`), and detail shape are byte-identical to before this
    phase (this phase is additive, not a rewrite of that signal).

New/edited test files: `scripts/config-preflight.test.mjs` (extend, tests 1-5),
`src/lib/email-deliverability-guard.test.ts` (new, tests 6-9), `src/lib/sequences.test.ts` (extend,
tests 10-14), `src/lib/system-health.test.ts` (extend, tests 15-21).

---

## 7. Ordered tasks (with effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | `scripts/config-preflight.mjs`: `evaluateDmarcRecord`, `checkDmarc`, wire into `main()`'s check list + report section | S | Low | Pure-function evaluator is the only tricky bit (TXT tag parsing); network layer reuses existing `fetchJsonWithTimeout` |
| 2 | `src/lib/email-deliverability-guard.test.ts`: sender-classification map + List-Unsubscribe assertions + single-transport grep guard | S | Low | No production code changes — pins existing, already-correct behavior |
| 3 | `src/lib/sequences.ts`: `SEQUENCES_DAILY_SEND_CAP_ENABLED`/`SEQUENCES_DAILY_SEND_CAP` flags, cap-check query, wire into `autoSendStep` + `retryFailedSends`, `sequences-daily-cap-tripped` heartbeat call in `runDueSequences` | M | Low-Med | The one genuinely new runtime code path this phase ships; mirror `overFrequencyCap`'s existing query shape closely to avoid a second, drifted volume-counting implementation |
| 4 | `src/lib/job-runs.ts`: add `"sequences-daily-cap-tripped"` to the `JobName` union | XS | Low | No `SECRET_ENV_NAMES` change needed — no new secret |
| 5 | `src/lib/system-health.ts`: new `WEBHOOK_JOBS`-style entry for the cap-tripped signal; new bounce/complaint-rate-7d signal (own try/catch block, alongside but not replacing the existing suppression-count block) | S | Low | Both are pure reads; both WARN-only, never CRITICAL, no `alertKey` |
| 6 | This spec's §3.1 DMARC graduation-criteria text is the runbook deliverable — no separate doc edit | XS | Low | Deliberately not forked into `docs/email-deliverability.md`; this spec is the authoritative copy per the task's "docs/specs only" scope |
| 7 | Tests (§6, 21 tests across 4 files) | M | Low | Extend existing standalone-runner test files where they already exist; one new small guard-test file |

Overall: **low** effort and risk, as expected for a hardening pass — the only task with any real
design risk is #3 (the daily cap), and it deliberately mirrors an existing, already-reviewed query
pattern (`overFrequencyCap`) rather than inventing a new one.

---

## 8. Changelog

### Rev 1 — 2026-07-08

Initial build-ready spec. Written against a fresh read of: `docs/handoff-build-state.md` §4
(confidence backlog); `docs/email-deliverability.md` (the full audit, confirming which of its five
fixes Phase 24 already closed and which remain open); `docs/specs/phase-24-resend-bounce-webhook.md`
(confirming the already-built webhook, suppression-bypass fix, and the `WEBHOOK_JOBS`/`job_runs`
patterns this phase's new signals mirror); `src/lib/email.ts` (full sender inventory, current
List-Unsubscribe/suppression/From-domain state — all already correct, confirmed line-by-line);
`src/lib/sequences.ts` (confirmed no daily/global send cap exists today, only the per-client weekly
cap; confirmed the daily cron cadence via `wrangler.sequence-runner.jsonc`); `src/app/api/email/
unsubscribe/route.ts` (confirmed the one-click flow the List-Unsubscribe headers feed is live and
correct); `scripts/config-preflight.mjs` (confirmed the exact shape of the existing Resend/Stripe/
Twilio checks, and confirmed no DNS-direct or DMARC check exists yet); `src/lib/system-health.ts`
(confirmed the existing lifetime suppression-count signal, the `resend-webhook`/`resend-webhook-
signature` WARN patterns this phase's new signals mirror); `src/lib/job-runs.ts` (confirmed the
`lead-form-global-flood` non-alerting-counter pattern this phase's cap-tripped heartbeat mirrors, and
that no new secret requires a `SECRET_ENV_NAMES` addition); `src/db/schema.ts` + migration directory
listing (confirmed no migration is needed and that slot `0099` is claimed by the separate autopay
phase). Not yet Fable-reviewed.

Re-verify all cited line numbers if the underlying files change shape before build.
