# Phase 25 — Email deliverability hardening (confidence backlog closer)

Status: spec rev 2 (Fable adversarial spec review returned APPROVE WITH CHANGES; all findings folded
in below — see §8 changelog). No code in this document.
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
  enumerates every export of `src/lib/email.ts` (senders AND non-sender helpers, MINOR 10 — §3.2)
  against a maintained allowlist of which senders must/must-not carry `List-Unsubscribe`; it fails
  loudly if a new export is added without an explicit classification entry. It changes no sender's
  behavior.
- **I3 — Single-transport invariant is guarded, scoped to non-test (production) sources.** A
  grep-style guard test asserts that no *non-test* file under `src/` other than `src/lib/email.ts`
  contains a literal `api.resend.com` — the exact class of drift Phase 24 already fixed once
  (`sendInquiryReplyEmail`'s old duplicated `fetch`, `docs/specs/phase-24-resend-bounce-webhook.md`
  §5). The grep excludes `*.test.ts`/`*.test.mjs` files: **8 existing test files already contain the
  literal** as part of the standard fetch-stub idiom (`if (String(url).includes("api.resend.com"))
  ...`) — `src/lib/sequences.test.ts:24`, `src/lib/email-suppression.test.ts:16`,
  `src/lib/resend-webhook.test.ts:507,562`, `src/lib/email-send-guard.test.ts:24`,
  `src/lib/scheduler-meet-links.test.ts:48`, `src/lib/portal-magic-link-email.test.ts:38`,
  `src/app/api/cron/systems-monitor/route.test.ts:58`, `src/app/api/cron/systems-monitor/
  daily-brief-digest.test.ts:81` — and the new `email-deliverability-guard.test.ts` (§3.2) would make
  a ninth, since it drives real sender calls through that same stub idiom. An unscoped, repo-wide grep
  is **red on arrival**; scoping to non-test sources is what makes the guard assert something true.
  This is a permanent regression guard, not a new feature.
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
- **I6 — A tripped cap is visible, not silently swallowed, and stays gated by the flag (I4).** Every
  run that trips the cap at least once records it via the existing `job_runs` heartbeat mechanism
  (`src/lib/job-runs.ts`), under a dedicated, non-money `JobName` — mirroring the existing
  `lead-form-global-flood` visibility-counter pattern (`job-runs.ts:92-98`), not the money-critical
  `REQUIRED_JOBS` pattern. **This heartbeat write — both the `ok:false` trip and the `ok:true`
  clean-run reset — only happens when `SEQUENCES_DAILY_SEND_CAP_ENABLED === "1"` (I4).** With the flag
  off, `recordJobRun("sequences-daily-cap-tripped", ...)` is never called at all: no new `job_runs`
  row is written on a dark run. This is what makes I4's "byte-for-byte no-op while off" claim true —
  if the `ok:true` reset fired unconditionally, a flag-off run would still write a new row every day,
  which is itself a behavior change (and would falsely surface a "configured" signal on
  `/system-status` before Tyler has ever turned the cap on). Test 19 (§6)'s not-configured branch
  depends on this: with the flag off, no heartbeat row of this `JobName` ever exists, so
  `computeSystemHealth` must keep surfacing the `info`/"not yet configured" branch indefinitely, not
  just on a fresh install.
- **I7 — The new bounce/complaint-rate signal is WARN-at-most, never CRITICAL.** It degrades
  deliverability hygiene visibility, not money state or canonical data integrity — same posture as
  the existing `resend-webhook` WEBHOOK_JOBS entry (`system-health.ts:122-124`, "should never page").
  It never gains an `alertKey` and is never wired into the immediate-critical-alert path.
- **I8 — No migration.** `email_suppressions` (`src/db/schema.ts:875-880`) and `sequence_sends`
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
| `isEmailSuppressed` — an exported `email.ts` function that is neither a transactional sender nor a sequence sender; a **helper** the classification map must have a third bucket for | `src/lib/email.ts:121-126` | MINOR 10: the guard test's export-sync assertion (test 10, §6) must classify this export as `"helper"` (or otherwise explicitly excluded), not force a `"transactional" \| "sequence"` choice onto it |
| Unsubscribe route: confirm-then-`POST`, writes `email_suppressions` + voids queued sequence drafts | `src/app/api/email/unsubscribe/route.ts:87-135` | The one-click flow this phase's header work feeds is live and correct |
| Per-client weekly send cap (the only volume guardrail that exists today) | `src/lib/sequences.ts:61-63,363-374` | Confirms no *daily/global* cap exists yet — item 4's gap |
| `runDueSequences` cadence: **once daily**, 14:00 UTC | `wrangler.sequence-runner.jsonc:11` | The daily cap's natural window is one cron tick, not a rolling clock |
| `active` enrollment loop bound to `limit(100)`; `retryFailedSends` bound to `limit(100)` | `sequences.ts:937-940,691-694` | Today's soft ceiling on worst-case per-run auto-send volume — the new cap is a backstop *independent* of these limits, not a replacement (a future refactor could raise them without anyone noticing) |
| `email_suppressions` schema: `email` PK, `suppressed_at`, `source` (`"unsubscribe_link" \| "admin" \| "bounce" \| "complaint"`), `note` | `src/db/schema.ts:875-880` | No migration needed for the new bounce-rate read (item 5) |
| `email_suppressions` writer: `INSERT ... ON CONFLICT DO NOTHING` keyed on the PK `email` — the ONLY writer today, and it already documents itself as "earliest-writer-wins" | `src/lib/resend-webhook.ts:202-215` (`insertSuppression`) | A repeat bounce/complaint for an address some other event already suppressed inserts NO row and returns `false` — the new 7d rate signal (item 5) undercounts by this amount too (MINOR 9) |
| `sendSequenceEmailDraft` — admin manual send of a queued, suppression-gated sequence draft; operates on `project_communications`, never touches `sequence_sends` | `src/lib/sequences.ts:1019-1049`, suppression check at `:1037`, send call at `:1049` | The THIRD `sendSequenceEmail` call site (alongside `autoSendStep` and `retryFailedSends`) — correctly outside the daily cap by the drafts-don't-count design (item 4; MINOR 13) |
| Existing lifetime suppression-count INFO signal (Phase 24 §6) | `src/lib/system-health.ts:340-368`, `key: "email-suppressions"` | The new 7-day signal is additive alongside this, not a replacement |
| `WEBHOOK_JOBS["resend-webhook"]` — WARN-only, `criticalFailures: Number.POSITIVE_INFINITY` | `system-health.ts:117-125` | The pattern this phase's new health signal mirrors (I7) |
| `resend-webhook-signature` misconfiguration WARN (recent+repeated rejects, no recent success) | `system-health.ts:127-138,325-337` | The pattern the daily-cap-tripped heartbeat mirrors (I6) |
| `lead-form-global-flood` — non-alerting visibility counter, deliberately excluded from any health catalog | `job-runs.ts:92-98` | The exact shape for the new cap-tripped `JobName` |
| `SECRET_ENV_NAMES` redaction list | `job-runs.ts:29-43` | No new secret is introduced by this phase; nothing to add here |
| `config-preflight.mjs` — Resend check hits `/domains` (not `/v1/domains` — the file's own §4 comment header says `/v1/domains`, but the live `fetch` call at `:428` is `https://api.resend.com/domains`; the comment is stale, the call is ground truth) only (Resend's own verified-status opinion), never a direct DNS query, never DMARC | `scripts/config-preflight.mjs:422-438`, fetch call at `:428` | The exact gap item 1's new check closes |
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
  deliverability break — worse than no check at all. Resend's existing domain-verification check
  (`config-preflight.mjs:422-438`, already live) already reports SPF+DKIM verification status from
  the authoritative source (Resend's own view of its records) — that remains the SPF/DKIM check. (The
  live `GET` there is `https://api.resend.com/domains`, `:428` — the file's own `/v1/domains` comment
  header at `:224` is stale relative to the actual call; don't copy that comment's path.)
  DMARC, by contrast, is **always** at the fixed, universally-standardized location
  `_dmarc.<apex-domain>` regardless of ESP — a live DNS lookup there is reliable and adds real,
  independently-verified information Resend's API does not report at all (DMARC isn't Resend's
  record to manage).
- **Mechanism:** a new pure evaluator `evaluateDmarcRecord(txtRecords: string[])` (unit-testable, no
  network) that: finds a record starting with `v=DMARC1`, parses the `p=` and `rua=` tags, and
  returns `{ pass, policy, hasRua, detail }`. `pass` is true whenever a syntactically valid, singular
  DMARC record exists — this check is about *presence and readability*, not about policy strictness
  (moving to `p=quarantine`/`p=reject` is a Tyler-paced business decision per the graduation criteria
  above, never something this script should fail on). Two malformed-but-present cases must NOT pass,
  per RFC 7489 §6.6.3 (MEDIUM 3):
  1. **Duplicate `v=DMARC1` records at `_dmarc`.** Per RFC 7489, a domain with more than one DMARC
     TXT record at the same name has **no effective policy at all** — receivers are required to
     treat multiple records as if none existed. `evaluateDmarcRecord` must count how many entries in
     `txtRecords` start with `v=DMARC1` and return `pass: false` (detail: "multiple DMARC records
     found; RFC 7489 treats this as no policy — remove the duplicate") when that count is `> 1`, even
     though each individual record may itself be syntactically valid.
  2. **Missing required `p=` tag.** `p=` is mandatory in a DMARC record (the receiver policy — none/
     quarantine/reject); a `v=DMARC1` record with no `p=` tag is not a usable DMARC record.
     `evaluateDmarcRecord` must return `pass: false` (detail names the missing `p=` tag) when exactly
     one `v=DMARC1` record is found but it has no parseable `p=` value.
- **Network call:** a new `checkDmarc(env, deps)` function, injectable exactly like `checkStripe`/
  `checkResend`/`checkTwilio` (`config-preflight.mjs:385-480`), using the same
  `deps.fetchJson`/`fetchJsonWithTimeout` helper (no new HTTP client). Target: Google's public DNS-
  over-HTTPS JSON endpoint, `GET https://dns.google/resolve?name=_dmarc.<domain>&type=TXT` (no auth
  header required, unlike Cloudflare's DoH which needs an `Accept: application/dns-json` header —
  fewer moving parts). `<domain>` reuses the existing `resendSendingDomain(env)` helper
  (`config-preflight.mjs:228-232`) so the two checks always target the same domain by construction.
  **`checkDmarc` (MINOR 11) is a deliberate, single deviation from the sibling pattern: unlike
  `checkStripe`/`checkResend`/`checkTwilio`, which are all unexported (`config-preflight.mjs:385,422`
  — module-private, called only from this file's own `main()`), `checkDmarc` must be `export`ed** so
  `scripts/config-preflight.test.mjs` can drive it directly for tests 6-7 (§6) without going through
  `main()`'s full env/report plumbing. Note this explicitly in the implementation so the builder
  doesn't "fix" the asymmetry by unexporting it or by exporting the others to match.
  **DoH response handling** (one sentence each, so there's no improvising at build time):
  - Strip the surrounding literal double-quotes DNS-over-HTTPS wraps each TXT string in (Google's
    `Answer[].data` renders a TXT value as `"v=DMARC1; p=none; ..."`, quotes included) before parsing
    tags.
  - A single DNS TXT record can be split across multiple quoted strings by the resolver; concatenate
    all such strings for one `Answer` entry into a single logical record before evaluating it (don't
    treat split-string continuations as separate/duplicate records — that would spuriously trigger
    the new duplicate-record FAIL above).
  - An absent or empty `Answer` array (Google's DoH shape for NXDOMAIN / no TXT records at that name)
    is a valid, well-formed "no DMARC record" response — pass an empty array through to
    `evaluateDmarcRecord`, which already returns `pass: false` for that case (test 2); it is not a
    network error and must not throw or produce a `FAIL`-by-exception.
  - Skip any `Answer` entry whose `type` is not TXT (e.g. a stray `CNAME` row Google's resolver can
    include) before looking for `v=DMARC1` — only TXT-type entries are DMARC candidates.
  Runs **unconditionally** (unlike the Resend/Stripe/Twilio checks, it needs no API key — DNS is
  public) — the only reason to skip it is a network failure, which degrades to `FAIL` with a network-
  error detail exactly like every other provider check's own `catch` branch.
- **Report integration:** one new row under a new `"DNS (DMARC)"` section in `buildReport`
  (`config-preflight.mjs:542-593` already groups `providerRows` by `section` — no structural change
  to the report builder, just one more section key).
- **What this does NOT do:** no SPF/DKIM DNS lookup (reasoned above), no automatic remediation, no
  write of any kind, no new dependency (reuses `fetch`, same as every other check in this file).

**MEDIUM 6 — owning the DMARC-missing → `FAIL` choice explicitly.** Every other Tyler-paced,
not-yet-enabled absence in `config-preflight.mjs` renders as `SKIP`/"not yet enabled" — the
`ENABLEMENT` tier's own status mapping is `"skip"` for an unset value, and its rendered line reads
"not yet enabled" rather than a failure (`config-preflight.mjs:153-167`). The new DMARC check
deliberately does **not** follow that convention: a missing or malformed DMARC record renders `FAIL`
(and `main()`'s overall exit code is non-zero — `npm run config:preflight` exits 1) on **every run**
until Tyler adds the DNS record, not `SKIP`. This is a conscious choice, not an inconsistency to
"fix" at build time, for three reasons this doc states outright rather than leaving implicit:

1. **Sending is live today, unconditionally.** Booking confirmations/reminders already send via
   Resend with no flag gate (§2 table, `RESEND_API_KEY` is a `REQUIRED` tier). A missing DMARC record
   is a real, present-tense deliverability gap on live mail — not a not-yet-launched feature waiting
   on Tyler's enablement, which is what the `SKIP`/"not yet enabled" convention exists to represent.
2. **The runbook (§3.1 above, §4 below) already tells Tyler exactly what to add and where**, so a
   `FAIL` is actionable, not merely alarming — it points at a concrete DNS edit, the same way a
   `REQUIRED`-tier missing secret's `FAIL` points at a concrete env var to set.
3. **This has low blast radius because `config:preflight` is a standalone script, not a deploy gate.**
   `npm run config:preflight` (`package.json:21`) is its own top-level script — it is not part of the
   `npm run deploy:preflight`/`npm run deploy` chain (`package.json:13,17`, which runs
   `check-source-drift.mjs` + `deploy-preflight.mjs` only). A `FAIL` here cannot block a deploy; it can
   only show up when Tyler runs the command himself or reads its output.

**Consequence to accept, not paper over:** until the `_dmarc.bythereeses.com` TXT record exists, this
check will exit non-zero **every single time** `config:preflight` runs (there is no snooze/ack
mechanism for an `ENABLEMENT`-style absence here, by design — see point 1). And because the check
"runs unconditionally" (no `SKIP` branch, §3.1 above), **this makes `config:preflight` unconditionally
network-dependent for the first time** — every other check in the script either has a `SKIP` path for
missing config or is itself gated behind a configured secret; this is the first check that always
makes a live network call regardless of what's set. A DNS resolver outage or an offline dev machine
now always produces at least one `FAIL` row (with a network-error detail, not a false "DMARC missing"
claim — §3.1's network-call bullet already specifies that degradation), which is an acceptable,
named tradeoff for a read-only public DNS lookup, not a hidden one.

### 3.2 List-Unsubscribe / List-Unsubscribe-Post — guard, not a fix

Current state is correct (§2 table) and unchanged by this phase. The one code touch is a new,
narrowly-scoped guard test — `src/lib/email-deliverability-guard.test.ts` — that:

1. Imports every exported function from `src/lib/email.ts` (or, more robustly, a maintained
   `const SENDER_CLASSIFICATION` map co-located in that file listing each export name against
   **`"transactional" | "sequence" | "helper"`** — a third bucket is required (MINOR 10) because not
   every export is a sender: `isEmailSuppressed` (`email.ts:121-126`) is an exported predicate used by
   both `sendSequenceEmail` and `sendSequenceEmailDraft`, not a mail sender at all, so it fits neither
   `"transactional"` nor `"sequence"`. Classify it `"helper"`) and asserts the map's membership stays
   in sync with the module's actual exports (a new exported sender with no entry fails the test with a
   clear message: "classify this export as transactional, sequence, or helper before merging").
2. For each entry classified `"sequence"`, drives a real call and asserts the outbound Resend request
   body's `headers` include both `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-
   Click` (RFC 8058).
3. For each entry classified `"transactional"`, asserts the outbound request has **no**
   `List-Unsubscribe` header at all.
4. Entries classified `"helper"` are exempt from both header assertions above (2-3) — they are not
   drivable as a mail send at all (`isEmailSuppressed` takes an email string and returns a boolean; it
   makes no Resend call and has no `headers`), so the guard only checks that they are present in the
   map, not that they carry or omit any header.

This test changes no runtime behavior — it only pins the classification the audit already validated,
so a future sender addition either gets explicitly classified or fails CI loudly (never a silent
drift back into the state the audit originally flagged).

### 3.3 From-domain alignment — guard, not a fix

Same treatment as §3.2: one new assertion (can live in the same
`email-deliverability-guard.test.ts` file) that greps `src/` for the literal substring
`api.resend.com`, **excluding `*.test.ts`/`*.test.mjs` files**, and asserts it appears in **exactly
one non-test file**, `src/lib/email.ts` — mirroring the narrower single-file version of this same
guard Phase 24 already wrote for one file pair (`docs/specs/phase-24-resend-bounce-webhook.md` §10
test 10: "assert `inbound-inquiry.ts` no longer contains a literal `api.resend.com`"). This phase
generalizes that one-off assertion into a permanent, repo-wide regression guard so the *next*
accidental duplicate transport (wherever it appears) fails CI instead of silently drifting the
From-address/header logic out of sync with `email.ts`.

**MAJOR 2 — why the test-file exclusion is load-bearing, not cosmetic.** An unscoped, repo-wide grep
for this literal is **red on arrival**: 8 existing test files already contain it as the standard
fetch-stub idiom (`if (String(url).includes("api.resend.com")) return new Response(...)`) —
`src/lib/sequences.test.ts:24`, `src/lib/email-suppression.test.ts:16`,
`src/lib/resend-webhook.test.ts:507,562`, `src/lib/email-send-guard.test.ts:24`,
`src/lib/scheduler-meet-links.test.ts:48`, `src/lib/portal-magic-link-email.test.ts:38`,
`src/app/api/cron/systems-monitor/route.test.ts:58`, `src/app/api/cron/systems-monitor/
daily-brief-digest.test.ts:81` — and this phase's own new `email-deliverability-guard.test.ts` (§3.2
test 2 drives real sender calls through the identical stub idiom) would make a ninth. None of these
are the transport drift this guard exists to catch; they are tests asserting behavior *of* the one
real transport. The grep must therefore filter to files whose basename does not end in `.test.ts` or
`.test.mjs` before counting matches, and the assertion is "exactly one **non-test** match" rather than
"exactly one match repo-wide."

### 3.4 Daily send-volume backstop for sequences

**New flags** (read in `src/lib/sequences.ts`, alongside the existing `flagOn()`/`intEnv()` helpers
at `sequences.ts:46-59`):

- `SEQUENCES_DAILY_SEND_CAP_ENABLED` — `=== "1"` (matches the `flagOn()` idiom every sibling
  `SEQUENCES_*` flag already uses). Default OFF.
- `SEQUENCES_DAILY_SEND_CAP` — `intEnv(..., 50)` (same helper as `SEQUENCES_MAX_PER_CLIENT_PER_WEEK`,
  `sequences.ts:54-59`). Only consulted when the enabled flag above is `"1"`; a misconfigured value
  (non-numeric, negative) falls back to the default exactly like every other `intEnv` tunable already
  does.

**What it counts (rev 2, MAJOR 1 — corrected from rev 1):** total **auto-sent** (`mode = "auto_send"`)
rows in `sequence_sends` with `status = "done"` **OR `status = "claimed"`**, with `firedAt` in the
trailing 24 hours. This is a deliberate change from rev 1, which counted `status = "done"` only and
explicitly excluded `claimed` — both of those were wrong:

1. **`claimed` must count.** `claimed` is TERMINAL-UNKNOWN, not "not yet sent": per the ledger's own
   schema comment, a `claimed` row means "a send may or may not have happened; NEVER auto-retried"
   (`src/db/schema.ts:900-902`), and the existing per-client weekly cap already treats `done` and
   `claimed` as equally consumed (`overFrequencyCap`'s own filter is `row.status === "done" ||
   row.status === "claimed"`, `sequences.ts:372`). A deliverability backstop exists to bound how much
   mail *may have reached an inbox* — a maybe-sent row is exactly the risk this cap must count, not
   exclude. Rev 1's exclusion of `claimed` meant the cap could never trip on the exact failure mode
   (ambiguous 5xx responses accumulating as `claimed`) that most looks like a runaway sender from the
   *inbox's* side.
2. **Retry dispatches must land inside the count window, so the retry CAS now also sets
   `firedAt = now`.** Rev 1 left `retryFailedSends`'s compare-and-swap claim
   (`sequences.ts:723-727`: `.set({ status: "claimed", attempts: row.attempts + 1 })`) untouched —
   it never touched `firedAt`. Combined with the retry eligibility gate requiring `firedAt` to be
   OLDER than the 24h backoff cutoff before a retry is even attempted (`sequences.ts:690,697`), every
   successful retry dispatch's ledger row carried a `firedAt` **outside** the very 24h window the new
   cap's `WHERE firedAt >= cutoff` counts. The row would be checked against the cap (correctly
   blocked while tripped) but, once past the block, its dispatch would **never itself be counted** by
   any future run's cap query — it is structurally invisible to the backstop it just fed through.
   Concretely: `SEQUENCES_DAILY_SEND_CAP=50` with 100 eligible `failed` rows sitting past their 24h
   backoff could produce up to 140 real Resend dispatches (50 fresh auto-sends + 100 retries) in a
   single run before the cap ever reads as tripped — the exact volume burst this cap exists to stop.
   **Fix: the retry CAS at `sequences.ts:723-727` now also sets `firedAt: now.toISOString()`** —
   "this row was attempted now" — alongside `status`/`attempts`. This is a deliberate, narrow, and
   semantically-consistent touch to existing retry behavior, not an accidental widening: it makes
   `firedAt` mean "last attempt time" consistently across both the per-client cap, the stuck-send
   cutoff (`surfaceStuckSends`, `sequences.ts:769-770`, itself keyed off `firedAt`-vs-24h), and this
   new daily cap — all three already read `firedAt` as "when did we last touch this row," and only
   the retry CAS was silently leaving it stale. A retried dispatch now lands inside the *next* run's
   trailing-24h count exactly like a fresh auto-send does.

Rows with `status = "failed"` are still excluded (provably not sent — no deliverability exposure),
and drafts (`mode = "draft"`) are still excluded (never leave the CRM without Tyler's click, per rev
1's original reasoning — unchanged). The query shape mirrors the existing `overFrequencyCap` query's
*shape* (`sequences.ts:363-374`) — same table, same `status IN (done, claimed)` filter, same
`firedAt`-cutoff comparison idiom — **not its window**: `overFrequencyCap` counts a **trailing 7-day**
window (MINOR 7 — rev 1 mis-described this as "the same trailing-24h window"; `sequences.ts:367`'s
cutoff is `addDays(now, -7)`, not `-1`); the new daily cap is its own, independently-chosen **trailing
24-hour** window, sized to `runDueSequences`'s once-daily cadence (`wrangler.sequence-runner.jsonc:11`).
The two queries share a query *pattern*, not a window value.

**Enforcement points** — both existing auto-send call sites gain the same one-line check
`autoSendStep` already uses for the unsubscribe-secret gate (`sequences.ts:608-610`, "Never auto-send
… skip (no claim, no send)"):

- `autoSendStep` (`sequences.ts:596-672`): before the claim-then-send sequence, if the cap is enabled
  and already at/over threshold, return without claiming or sending — the step stays due and
  re-evaluates next run (I5).
- `retryFailedSends` (`sequences.ts:688-765`): same check before the compare-and-swap claim
  (`sequences.ts:723-727`, now also touched per MAJOR 1 above) — a retry attempt also counts against,
  and is blocked by, the same daily ceiling.

**MEDIUM 4 — this is a blunt backstop, and its concurrency slop is intentional, not an oversight.**
The count-then-claim sequence (read the trailing-24h count, decide OK, THEN claim/send) is **not
atomic** — there is no transaction spanning the count query and the subsequent claim. Two overlapping
runs of `runDueSequences` (the daily cron at 14:00 UTC and a manual bearer-token `POST` triggering an
out-of-band run, `sequences.ts:682-687`'s own comment names exactly this overlap for the retry CAS)
can each read the count as "under cap," and each then claim/send, landing the true total at
`cap + N` rather than exactly `cap`. This is **acceptable** for what this cap is: a blunt, WARN-only
circuit breaker against a misconfiguration or future refactor that defeats the per-client cap or
raises the `active`/`failed` query limits — not a hard, provider-enforced rate limit, and not a
billing-accuracy or compliance boundary where exactness matters. The spec does not claim exactness
and this document should not be read as implying the cap is exact: "SEQUENCES_DAILY_SEND_CAP=50"
means "WARN once the trailing-24h count is at/over roughly 50," not "never more than 50 will ever
send in a day." Tyler should set the cap with headroom above his real observed volume (§4 runbook),
not as a precise ceiling.

**MEDIUM 5 — dunning (payment-reminder) auto-sends share the cap and can be delayed, not lost, by a
tripped cap.** `autoSendStep` serves every sequence type — dunning, pre-event, review — through the
same code path, so a cap tripped by (say) a burst of pre-event reminders also blocks a due dunning
step from firing that run. This is a real tradeoff: dunning mail is arguably higher-priority (it
protects revenue collection) than a pre-event reminder. This phase **accepts and documents the delay
rather than exempting or prioritizing dunning**, for two reasons: (1) I5 already guarantees the delay
is bounded and safe — a capped step is never lost, never marked failed, and never double-counted; it
"stays due and is re-evaluated next run" (the next daily cron tick, at most ~24h later), so the worst
case is a payment reminder landing one day later than scheduled, not a missed reminder; (2) at
`SEQUENCES_DAILY_SEND_CAP`'s code default of 50 against a solo-photographer volume CRM, tripping the
cap at all is already an edge case reserved for a genuine misconfiguration or volume spike — adding a
priority lane for one sequence type is real design complexity (an ordering guarantee across
`autoSendStep`'s per-enrollment loop) for a scenario Tyler can simply resolve by raising
`SEQUENCES_DAILY_SEND_CAP` (§4 runbook step 3) once he sees it happening on `/system-status`. A future
revision could add dunning-priority ordering if the trip-then-delay pattern is observed in practice
and Tyler decides it matters more than the cap-raise workaround; out of scope for this phase.

**Why a global backstop, not a smarter one:** the task brief calls for "a simple daily send-cap...
so a misconfigured sequence can't burst-send" — this is explicitly a blunt circuit breaker, not a
per-sequence-type or adaptive-throttling system. The existing per-client weekly cap
(`SEQUENCES_MAX_PER_CLIENT_PER_WEEK`) already bounds *repeat* mail to one address; this phase's cap
bounds *aggregate* volume across all clients in a single run — the failure mode it defends against is
categorically different (a bug or future refactor that defeats/bypasses the per-client cap, or raises
the `active`/`failed` query `limit(100)` ceilings without anyone revisiting the volume implications).

**Visibility when tripped (I6), gated by the same flag (rev 2 clarification, MINOR 8):** this entire
heartbeat block — both branches below — only runs when `SEQUENCES_DAILY_SEND_CAP_ENABLED === "1"`.
With the flag off, `runDueSequences` never calls `recordJobRun("sequences-daily-cap-tripped", ...)` at
all, in either direction. This is required for I4's "byte-for-byte no-op while off" claim to actually
hold: if the `ok:true` branch below fired unconditionally, a flag-off run would still write a new
`job_runs` row every day — a real behavior change on a dark deploy, and one that would make
`/system-status` report this signal as "configured" before Tyler has ever turned the cap on.

- The first time in a (flag-on) run that the cap check causes a skip, `runDueSequences` calls
  `recordJobRun("sequences-daily-cap-tripped", false, "<n> auto-sends in the trailing 24h reached the
  SEQUENCES_DAILY_SEND_CAP of <cap>")` — a **new, non-money** `JobName` appended to the union in
  `job-runs.ts:69-98`, deliberately modeled on `lead-form-global-flood` (`job-runs.ts:92-98`: "a
  visibility counter... NON-ALERTING... a raw counter/heartbeat"), not on any `REQUIRED_JOBS`/
  money-critical pattern.
- A (flag-on) run that completes **without** tripping the cap calls
  `recordJobRun("sequences-daily-cap-tripped", true)` once, so the signal self-resets to `ok` the next
  day the cap isn't hit (mirrors `resend-webhook`'s per-event ok/fail recording, not a one-way
  ratchet).

One new `computeSystemHealth` entry surfaces this on `/system-status`, in the same
`WEBHOOK_JOBS`-style shape as `resend-webhook` (`system-health.ts:117-125`): WARN at 1+ recent trip,
never CRITICAL (`criticalFailures: Number.POSITIVE_INFINITY`) — a tripped cap means the backstop
*worked*, not that anything is broken; it's worth Tyler's attention (maybe the cap needs raising for
legitimate volume growth, or maybe something really is misbehaving), never a page. With the flag off
(no heartbeat row ever written, per above), `computeSystemHealth` must keep surfacing this signal
through the existing `WEBHOOK_JOBS` **missing-row branch** — `info`/"not yet configured," never a
stale alarm (`system-health.ts:259-270`; MINOR 12 — rev 1 mis-cited this branch as `:250-258`, which
is a different block in the same function) — indefinitely, not just before the first-ever run. Test
19 (§6) pins this reachability.

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
- **A second, independent undercount source (MINOR 9), beyond the missing denominator above.** The
  count itself also undercounts *incidents*, not just the rate: `email_suppressions` writes are
  `INSERT ... ON CONFLICT DO NOTHING` keyed on the table's PRIMARY KEY, `email`
  (`src/lib/resend-webhook.ts:202-215`'s `insertSuppression`, whose own comment already calls this out
  as "earliest-writer-wins," I4 in that file). A second bounce or complaint for an address some
  earlier event already suppressed inserts **no new row** — `insertSuppression` returns `false` and
  (per Phase 24's own MEDIUM-5 fix) no activity-log row is written either. So a client whose address
  bounces once, gets suppressed, and then bounces again on a stale mailing five more times over the
  next week contributes exactly **one** row to this signal's count, not six. This is the same honest
  trade-off as the missing denominator above — a real per-event bounce ledger is out of scope for this
  phase — but it is worth stating as its own, additive reason the count is a floor, not a ceiling, on
  actual bounce/complaint volume.
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
   existing, but deliverability itself does. **Expect `FAIL` (and a non-zero exit) on every run until
   that record is added** — this is by design, not a bug (MEDIUM 6, §3.1): unlike every other
   not-yet-enabled check in this script, DMARC absence renders `FAIL` rather than `SKIP`, because
   sending is already live. It cannot block a deploy (`config:preflight` is standalone,
   `package.json:21` — not part of `npm run deploy`).
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
phase reads (`src/db/schema.ts:875-880`); `sequence_sends` already has `firedAt`/`status`/`mode` for
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
4. **DMARC evaluator — duplicate `v=DMARC1` records (MEDIUM 3).**
   `evaluateDmarcRecord(["v=DMARC1; p=none; rua=mailto:a@x.com", "v=DMARC1; p=reject"])` (two
   syntactically-valid-on-their-own `v=DMARC1` entries at the same name) → `pass: false`, detail names
   "multiple DMARC records" and cites RFC 7489's "no policy" rule — not a throw, and not a `pass:true`
   even though either record alone would pass.
5. **DMARC evaluator — missing required `p=` tag (MEDIUM 3).**
   `evaluateDmarcRecord(["v=DMARC1; rua=mailto:hello@bythereeses.com"])` (a single, otherwise-parseable
   `v=DMARC1` record with no `p=` tag) → `pass: false`, detail names the missing `p=` tag.
6. **`checkDmarc` — network layer.** Injected `deps.fetchJson` stub returns a Google DoH-shaped
   `{ Answer: [{ data: '"v=DMARC1; p=none; ..."' }] }` body → one `PASS` row in the `DNS (DMARC)`
   section; a network error (thrown/rejected) → one `FAIL` row with the network-error detail,
   never an uncaught throw (mirrors `checkStripe`'s/`checkResend`'s own try/catch, `config-
   preflight.mjs:395-417,427-437`). Also cover the DoH response-shape edge cases named in §3.1 (MINOR
   11): a quoted TXT value (`'"v=DMARC1; ..."'`) has its surrounding quotes stripped before parsing; a
   TXT value split across multiple `Answer` strings for the same record is concatenated, not treated
   as a second/duplicate record; an absent/empty `Answer` array (NXDOMAIN) degrades to the same
   `pass:false` "missing record" outcome as test 2, not a network `FAIL`; a `CNAME`-type `Answer` entry
   is skipped rather than inspected for `v=DMARC1`.
7. **`checkDmarc` runs unconditionally.** Unlike Stripe/Resend/Twilio (each individually skippable on
   a missing API key), the DMARC check has no `SKIP` branch for missing config — assert it always
   produces exactly one row regardless of which other env vars are set/unset. Also assert `checkDmarc`
   is an `export`ed function (MINOR 11) — unlike its unexported siblings `checkStripe`/`checkResend`
   (`config-preflight.mjs:385,422`), it must be importable directly by this test file.
8. **List-Unsubscribe guard — sequence senders carry both RFC 8058 headers.** Drive `sendSequenceEmail`
   (with a stubbed `fetch`) and assert the outbound request's `headers` include `List-Unsubscribe`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
9. **List-Unsubscribe guard — every transactional sender omits both headers.** Drive each of
   `sendAdminAlertEmail`, `sendPortalMagicLinkEmail`, `sendBookingEmails`, `sendBookingReminderEmail`,
   `sendBookingCancellationEmail`, `sendInquiryReplyEmail`, `sendProjectEmail` and assert none of their
   outbound request bodies include a `headers.List-Unsubscribe` key.
10. **List-Unsubscribe guard — unclassified sender fails loudly; helper exports are a distinct third
    bucket (MINOR 10).** A test-only fixture that adds a function name to `email.ts`'s exports without
    a corresponding classification-map entry causes the guard's membership-sync assertion to fail with
    an actionable message (this can be asserted by testing the classification-sync helper directly
    against a synthetic export list, without needing to actually add an unclassified export to the
    real module). Also assert the real map classifies `isEmailSuppressed` (`email.ts:121-126`) as
    `"helper"` — neither `"transactional"` nor `"sequence"` — and that the sync assertion accepts a
    `"helper"` entry without requiring it to pass or fail either header test (tests 8-9).
11. **Single-transport guard, scoped to non-test sources (MAJOR 2).** Grep for the literal substring
    `api.resend.com` under `src/`, **excluding any file matching `*.test.ts` or `*.test.mjs`**, returns
    matches in **exactly one** file, `src/lib/email.ts`. A companion assertion (or a code comment
    pinning the count) confirms the *unscoped* repo-wide grep would currently return 9 files (the 8
    pre-existing test-file stubs named in §3.3 plus this phase's own new guard test) — so the scoping
    is demonstrably load-bearing, not decorative.
12. **Daily cap — flag off is a no-op.** With `SEQUENCES_DAILY_SEND_CAP_ENABLED` unset, seed
    `sequence_sends` with `SEQUENCES_DAILY_SEND_CAP` (default 50) + 10 auto-sent rows in the trailing
    24h and drive one more eligible auto-send step through `autoSendStep` — assert it sends normally
    (cap never consulted).
13. **Daily cap — trips and skips.** With the flag on and `SEQUENCES_DAILY_SEND_CAP=2`, seed 2
    auto-sent (`status="done"`) rows in the trailing 24h, then drive a 3rd eligible step through
    `autoSendStep` — assert zero Resend calls, no ledger row claimed, and the step remains eligible
    (re-evaluates) on a simulated next run.
14. **Daily cap — trailing-24h window, not calendar-day.** A row fired 25 hours ago does not count
    toward the cap; a row fired 23 hours ago does (mirrors the existing per-client cap's own window
    test coverage for `overFrequencyCap`).
15. **Daily cap — retry path also respects the cap, and its dispatch refreshes `firedAt` (MAJOR 1).**
    With the cap tripped, drive `retryFailedSends` over a `status="failed"` row — assert it is not
    claimed/sent while the cap holds. Separately (cap not tripped), drive a successful retry dispatch
    and assert the resulting `sequence_sends` row's `firedAt` is updated to (approximately) now, not
    left at the original failed-send timestamp — this is what makes the row visible to the *next* run's
    trailing-24h count (test 17).
16. **Daily cap counts `done` OR `claimed`, never excludes ambiguous sends (MAJOR 1).** Seed
    `SEQUENCES_DAILY_SEND_CAP - 1` `status="done"` rows plus exactly one `status="claimed"` row (all
    `mode="auto_send"`, all `firedAt` in the trailing 24h) — assert the count reads as at-cap and the
    next eligible auto-send step is blocked. This is a direct regression guard against rev 1's bug,
    which excluded `claimed` and would have let this exact seed under-count by one and pass the send
    through.
17. **Daily cap — a burst of retries cannot exceed the cap by riding outside the count window (MAJOR
    1).** Seed the cap at a small value (e.g. `SEQUENCES_DAILY_SEND_CAP=5`), seed the per-client and
    global preconditions for 20 eligible `status="failed"` rows past their 24h backoff window, and
    drive `retryFailedSends` once. Assert no more than 5 total dispatches occur across the run (the
    cap check re-reads the count — now inclusive of each just-completed retry's refreshed `firedAt`,
    per test 15 — before allowing the next one), directly exercising the burst scenario MAJOR 1's fix
    closes (rev 1 would have allowed up to `cap + 100` dispatches here).
18. **Daily cap — heartbeat on trip vs. no-trip, gated by the flag (MINOR 8).** With the flag on: a run
    that trips the cap records `sequences-daily-cap-tripped` with `ok:false` and a detail naming the
    count/cap; a run that does not trip it records `ok:true` (self-resetting the WARN back to healthy
    the next clean day). With the flag OFF: assert `recordJobRun("sequences-daily-cap-tripped", ...)`
    is never called at all (no new `job_runs` row of this `JobName` appears), in either direction —
    this is the byte-for-byte-no-op claim (I4) applied to the heartbeat specifically.
19. **`/system-status` — cap-tripped signal severity, and the not-configured branch stays reachable
    (MINOR 8, MINOR 12).** With a recorded `ok:false` cap-tripped heartbeat, `computeSystemHealth`
    surfaces a `warn` signal, never `critical`; with no heartbeat row at all (the flag-off case, per
    test 18), it surfaces as not-configured (`info`), via the existing `WEBHOOK_JOBS` missing-row
    branch (`system-health.ts:259-270`). Assert this `info` branch is reachable indefinitely while the
    flag stays off — not merely on a fresh install before the first run.
20. **Bounce/complaint-rate signal — below threshold.** Seed 2 bounce rows and 0 complaint rows in the
    trailing 7 days → signal severity `ok`, `value: 2`.
21. **Bounce/complaint-rate signal — bounce+complaint combined threshold.** Seed 3 bounce + 2
    complaint rows (combined 5) in the trailing 7 days → signal severity `warn`.
22. **Bounce/complaint-rate signal — single complaint alone trips WARN.** Seed 0 bounce + 1 complaint
    row → signal severity `warn` (the complaint-alone threshold, independent of the combined count).
23. **Bounce/complaint-rate signal — window boundary.** A suppression row `suppressed_at` exactly 8
    days old is excluded; one 6 days old is included.
24. **Bounce/complaint-rate signal — read failure degrades to signal-skipped, not a thrown page.**
    Stub the `email_suppressions` read to throw — assert `computeSystemHealth` still returns a report
    (the signal is simply absent that cycle), mirroring the existing best-effort wrapping already used
    for every other block in that function.
25. **Existing lifetime `email-suppressions` signal is unchanged.** A regression check that the
    Phase-24 signal's `key`, `severity` (`"info"`), and detail shape are byte-identical to before this
    phase (this phase is additive, not a rewrite of that signal).

New/edited test files: `scripts/config-preflight.test.mjs` (extend, tests 1-7),
`src/lib/email-deliverability-guard.test.ts` (new, tests 8-11), `src/lib/sequences.test.ts` (extend,
tests 12-18), `src/lib/system-health.test.ts` (extend, tests 19-25).

---

## 7. Ordered tasks (with effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | `scripts/config-preflight.mjs`: `evaluateDmarcRecord`, `checkDmarc`, wire into `main()`'s check list + report section | S | Low | Pure-function evaluator is the only tricky bit (TXT tag parsing); network layer reuses existing `fetchJsonWithTimeout` |
| 2 | `src/lib/email-deliverability-guard.test.ts`: sender-classification map (3 buckets: transactional / sequence / helper) + List-Unsubscribe assertions + single-transport grep guard scoped to non-test sources | S | Low | No production code changes — pins existing, already-correct behavior |
| 3 | `src/lib/sequences.ts`: `SEQUENCES_DAILY_SEND_CAP_ENABLED`/`SEQUENCES_DAILY_SEND_CAP` flags, cap-check query counting `status IN (done, claimed)` for `mode="auto_send"` in the trailing 24h, wire into `autoSendStep` + `retryFailedSends`, `sequences-daily-cap-tripped` heartbeat call (both branches, flag-gated) in `runDueSequences`, **and set `firedAt: now` on the retry CAS at `sequences.ts:723-727`** (MAJOR 1) | M | Low-Med | The one genuinely new runtime code path this phase ships; mirror `overFrequencyCap`'s existing query shape closely to avoid a second, drifted volume-counting implementation. The `firedAt` touch on the retry CAS is a small, deliberate change to existing retry behavior — don't skip it, the cap's correctness depends on it (MAJOR 1) |
| 4 | `src/lib/job-runs.ts`: add `"sequences-daily-cap-tripped"` to the `JobName` union | XS | Low | No `SECRET_ENV_NAMES` change needed — no new secret |
| 5 | `src/lib/system-health.ts`: new `WEBHOOK_JOBS`-style entry for the cap-tripped signal; new bounce/complaint-rate-7d signal (own try/catch block, alongside but not replacing the existing suppression-count block) | S | Low | Both are pure reads; both WARN-only, never CRITICAL, no `alertKey` |
| 6 | This spec's §3.1 DMARC graduation-criteria text is the runbook deliverable — no separate doc edit | XS | Low | Deliberately not forked into `docs/email-deliverability.md`; this spec is the authoritative copy per the task's "docs/specs only" scope |
| 7 | Tests (§6, 25 tests across 4 files) | M | Low | Extend existing standalone-runner test files where they already exist; one new small guard-test file |

Overall: **low** effort and risk, as expected for a hardening pass — the only task with any real
design risk is #3 (the daily cap), and it deliberately mirrors an existing, already-reviewed query
pattern (`overFrequencyCap`) rather than inventing a new one.

---

## 8. Changelog

### Rev 2 (Fable spec review) — 2026-07-08

**Verdict: APPROVE WITH CHANGES.** All findings below were verified against the cited code before
being folded in — including re-deriving several line-number citations that had drifted from the file
shapes cited in rev 1 (`src/db/schema.ts` had grown by ~60 lines since rev 1's read; the DMARC-related
`system-health.ts`/`config-preflight.mjs` citations were checked line-by-line against the current
file). No finding was disagreed with or dropped. Every fix is spec-text only; no autopay file
(`docs/specs/phase-13-*`, `src/lib/autopay*`, `migrations/0099*`) was touched, and no code was written
or edited — this remains a build-ready spec, not an implementation.

| # | Severity | Finding | Fix (this rev) |
|---|---|---|---|
| MAJOR 1 | MAJOR | The daily cap never counted retry dispatches and wrongly excluded `claimed`: retry eligibility requires `firedAt` older than 24h (`sequences.ts:690,697`) but the retry CAS never updated `firedAt` (`sequences.ts:723-727`), so every retry dispatch's ledger row landed OUTSIDE the trailing-24h count window the new cap reads — checked against the cap, never consuming it. Combined with `claimed` being excluded from the count (contradicting `overFrequencyCap`'s own `done OR claimed` filter, `sequences.ts:372`, and the ledger's own "terminal-unknown, may-or-may-not-have-sent" semantics for `claimed`, `src/db/schema.ts:900-902`), `cap=50` + 100 eligible failed rows could produce up to 140 real dispatches in one run before the cap ever tripped — the exact burst the cap exists to stop. | §3.4 rewritten: the count now filters `status = "done" OR status = "claimed"` (matching `overFrequencyCap`'s own filter shape), and the retry CAS at `sequences.ts:723-727` now also sets `firedAt: now.toISOString()` — a deliberate, narrow, semantically-consistent touch to existing retry behavior ("this row was attempted now"), documented as intentional so the builder doesn't read it as scope creep. Test plan updated: test 15 now covers the `firedAt` refresh directly; new tests 16-17 regression-guard the `done OR claimed` count and the retry-burst scenario specifically. (§3.4, §6 tests 15-17, §7 task 3.) |
| MAJOR 2 | MAJOR | The single-transport grep guard (I3, §3.3, test 9) is red on arrival: the literal `api.resend.com` already appears in 8 existing test files under `src/` (the standard fetch-stub idiom), and the new guard test file itself would make a ninth — an unscoped repo-wide grep can never assert "exactly one file" today. | I3, §3.2/§3.3, and test 9 (now test 11) all rewritten to scope the grep to **non-test** sources (excluding `*.test.ts`/`*.test.mjs`) and assert **exactly one non-test file**, `src/lib/email.ts`. All 8 pre-existing test-file citations enumerated by file:line so the builder doesn't have to re-derive them. (§1 I3, §3.3, §6 test 11.) |
| MEDIUM 3 | MEDIUM | `evaluateDmarcRecord` as specified in rev 1 would pass a malformed-but-present DMARC configuration: (a) duplicate `v=DMARC1` records at `_dmarc` mean no effective policy per RFC 7489 §6.6.3, and (b) a record missing the required `p=` tag isn't usable — neither case was named as a required `pass:false`. | §3.1's "Mechanism" bullet now names both cases explicitly as required `pass:false` outcomes, with the RFC 7489 citation. New tests 4-5 added (renumbering the rest of §6 downward by 2). (§3.1, §6 tests 4-5.) |
| MEDIUM 4 | MEDIUM | The cap's concurrency slop (count-then-claim is not atomic; overlapping runs — the daily cron and a manual bearer-token `POST`, `sequences.ts:682-687` — can each read "under cap" and both send) was implicit, not stated; a reader could mistake the cap for an exact ceiling. | New paragraph in §3.4 states outright that this is a blunt, WARN-only backstop, not an exact or provider-enforced limit, and that `cap + N` is an accepted outcome of two overlapping runs — not a bug to fix in this phase. (§3.4.) |
| MEDIUM 5 | MEDIUM | Dunning (payment-reminder) auto-sends share the daily cap with every other sequence type and could be delayed by a tripped cap, with no discussion of whether that's acceptable. | New paragraph in §3.4 explicitly accepts and documents the delay (not loss — I5 already guarantees the step stays due and re-evaluates next run) rather than adding a priority lane, reasoning that at `cap=50` against solo-photographer volume this is an edge case Tyler can resolve by raising the cap (§4 runbook), and that dunning-priority ordering is real added complexity deferred to a future revision if the pattern is observed in practice. (§3.4.) |
| MEDIUM 6 | MEDIUM | The DMARC-missing → `FAIL` choice (rather than the `SKIP`/"not yet enabled" every other Tyler-paced absence renders, `config-preflight.mjs:153-167`) was implicit; needed to be owned explicitly, including its always-exit-1-until-DNS-added consequence and that it makes `config:preflight` unconditionally network-dependent for the first time. | New paragraph at the end of §3.1 states the choice, all three reasons for it (sending is live today; the runbook is actionable; `config:preflight` is a standalone script per `package.json:21`, not wired into any deploy gate), and the concrete consequence (exit 1 every run until the DNS record exists; the script becomes unconditionally network-dependent). §4 runbook step 1 cross-references it. (§3.1, §4.) |
| MINOR 7 | MINOR | Rev 1 described the new daily-cap query as mirroring `overFrequencyCap`'s "trailing-24h window" — but `overFrequencyCap`'s actual window is a **trailing 7 days** (`sequences.ts:367`, `addDays(now, -7)`). The pattern being mirrored is the query *shape*, not the window value. | §3.4 corrected: explicitly states `overFrequencyCap` is a 7-day window and the new cap is its own, independently-sized 24-hour window; they share a query pattern, not a duration. (§3.4.) |
| MINOR 8 | MINOR | The cap-tripped `ok:true` heartbeat, as specified in rev 1, would fire even with the flag off, writing a new `job_runs` row on every dark run — violating I4's byte-for-byte no-op claim and making test 15's (now test 19) not-configured branch unreachable after the first clean run. | §1 I6 and §3.4's "Visibility when tripped" paragraph rewritten: both the `ok:false` and `ok:true` heartbeat calls are gated behind `SEQUENCES_DAILY_SEND_CAP_ENABLED === "1"`; with the flag off, `recordJobRun` for this `JobName` is never called. Test 18 (heartbeat) and test 19 (`/system-status` signal) both updated to cover the flag-off no-heartbeat case explicitly. (§1 I6, §3.4, §6 tests 18-19.) |
| MINOR 9 | MINOR | The 7d bounce/complaint signal's honesty note (missing cross-sender denominator) didn't mention a second, independent undercount: `email_suppressions` writes are `INSERT ... ON CONFLICT DO NOTHING` keyed on the PK `email` (`src/lib/resend-webhook.ts:202-215`), so a repeat bounce/complaint for an already-suppressed address inserts no new row and isn't counted at all. | New bullet added to §3.5 stating this as an additive, independent undercount source, citing the writer's own "earliest-writer-wins" self-description. (§3.5.) |
| MINOR 10 | MINOR | The sender-classification map (§3.2, test 8) only had `"transactional" \| "sequence"` buckets, but `email.ts` exports `isEmailSuppressed` (`:121-126`), which is neither — a predicate helper, not a mail sender. The export-sync assertion as specified would force an artificial choice onto it. | §3.2 rewritten to add a third `"helper"` classification bucket, with `isEmailSuppressed` named as the motivating example and an explicit carve-out that `"helper"` entries are exempt from the header-presence/-absence assertions (tests 8-9). A new ground-truth row added in §2. Test 10 (was 8) updated accordingly. (§3.2, §2, §6 test 10.) |
| MINOR 11 | MINOR | `checkDmarc` needed to be `export`ed for tests 4-5 (now 6-7) to drive it directly, unlike its sibling `checkStripe`/`checkResend`, which are unexported (`config-preflight.mjs:385,422`) — this asymmetry needed to be stated as deliberate. The DoH response-handling edge cases (quote-stripping, multi-string concatenation, absent-`Answer` NXDOMAIN handling, CNAME-row skipping) also weren't specified, leaving room for the builder to improvise. | §3.1's "Network call" bullet now states the export deviation is deliberate, and adds one sentence each for the four DoH edge cases. Test 6 (was 4) and test 7 (was 5) updated to cover the export assertion and the DoH edge cases. (§3.1, §6 tests 6-7.) |
| MINOR 12 | MINOR | Three stale citations: the Resend preflight check actually hits `/domains`, not `/v1/domains` (the file's own `:224` comment is stale relative to the live call at `:428`); the `WEBHOOK_JOBS` missing-row branch is at `system-health.ts:259-270`, not `:250-258`; the Resend reject constants `RESEND_REJECT_FRESH_MS`/`RESEND_REJECT_MIN_COUNT` were re-verified at `system-health.ts:140-141` (already correct in rev 1 — confirmed, not changed). | §2 ground-truth table and §3.1 prose corrected for the `/domains` vs `/v1/domains` citation (both occurrences); §3.4's "Visibility when tripped" paragraph and test 19 corrected to `system-health.ts:259-270`. The reject-constants citation was re-verified against current code and left as-is (already accurate). (§2, §3.1, §3.4, §6 test 19.) |
| MINOR 13 | MINOR | The sender inventory (§2) named only two `sendSequenceEmail` call sites (`autoSendStep`, `retryFailedSends`); a third exists — `sendSequenceEmailDraft` (`sequences.ts:1019-1049`, the admin manual-send-of-a-queued-draft path) — and wasn't named, risking the builder "discovering" it mid-build and improvising its cap treatment. | New §2 ground-truth row names `sendSequenceEmailDraft` explicitly: suppression-gated (`:1037`), operates on `project_communications` (never touches `sequence_sends`), and is correctly outside the daily cap by the drafts-don't-count design already established in rev 1. (§2.) |

No findings were disagreed with or dropped — all thirteen are folded in as specified above.

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
