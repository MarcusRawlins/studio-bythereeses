# Autonomous Build Loop

A self-sustaining build engine that drives the remaining roadmap to completion with
per-phase **spec → Fable review → build → Fable review → verify → deploy** cycles and
**active learning** (recurring findings feed forward so they're pre-empted, not re-discovered).

Clock: primarily event-driven (each build/review subagent notifies on completion, which
resumes the loop); a `send_later` heartbeat is the stall safety-net. Every builder and
reviewer prompt is seeded with the **Active-Learning Log** below.

## Guardrails (hold even under full autonomy)

1. **Off-by-default.** Every runtime-changing feature ships behind an OFF flag (three-state
   like `ADMIN_PROOF_ENFORCE`/`CSP_MODE`). Deploy = zero behavior change until deliberately enabled.
2. **Enablement flips are NOT autonomous.** Turning enforcement/features ON (log→enforce,
   report→enforce, feature flags) needs an observation window fed by real traffic → queued for
   Tyler with a runbook. The loop builds and deploys *dark*; Tyler flips.
3. **Money-movement pause.** Before the *first* live deploy of any code that moves real money
   (Phase 9 refunds/disputes/charges), stop and confirm with Tyler. Everything else proceeds.
4. **Every deploy is reversible.** Real D1 backup → capture Worker rollback version → deploy →
   health-check → auto-rollback on failure.
5. **Fable gates everything.** No spec or code reaches the branch without an adversarial Fable
   review; no deploy without green build (exit code) + tests + health check.
6. **Milestone reporting.** Report at each phase deploy, not every sub-step. Tyler can interrupt anytime.

## Phase / module ledger

| # | Phase / module | Status |
| --- | --- | --- |
| 6 | Hardening + R2 private access | ✅ deployed 2026-07-05 (M4/CSP off, R2 dark) |
| 6.5 | Portal self-service magic-link | ✅ deployed 2026-07-05 (flag off) — Worker `b7c34f40`, proxy `821ed36f`, migration 0084 |
| 8a | Inquiry-email intake | 🔵 building (spec Fable-revised) |
| 7 | Client galleries (integrate) | ⏭️ spec → build |
| 8b | SMS (Twilio) | ⏭️ spec → build |
| 8c | Automated sequences (dunning/nudges/reviews) | ⏭️ spec → build |
| 9 | Financial completeness (refunds/disputes, QBO/Xero, tax/1099) | ⏭️ spec → build — money-movement pause |
| 10 | Intelligence + forecasting | ⏭️ spec → build |
| 11 | Multi-user + RBAC | ⏭️ deferred until a real 2nd user |
| — | Enablement flips (M4 log→enforce, CSP report→enforce, feature flags) | 🅣 Tyler runbook (deploy-record + per-phase) |
| — | Agent-token canonical-mutation authority review | ⏭️ standing hardening item (surfaced by 8a) |

## Per-phase cycle (repeats autonomously)

1. **Spec** (Opus) → Fable review → revise → commit.
2. **Build** (Sonnet for standard, Opus for security-sensitive) seeded with the Active-Learning Log →
   verify (`lint`; `build` + **exit code**; `test`) → adversarial Fable review → fix → commit.
3. **Deploy** (if the phase needs it): backup → deploy Worker + Pages-proxy → health-check → rollback-ready.
   Feature flag stays OFF.
4. **Learn**: append any new Fable finding class to the Active-Learning Log; update ledger + roadmap.
5. Advance to the next `⏭️` phase.

## Active-Learning Log (seed every agent prompt with this)

Patterns the Fable gate has caught repeatedly — pre-empt them:

- **Build gate:** check `npm run build` **exit code**, not a phrase. A type-check failure prints
  "Failed to type check" and exits 1 *after* "Compiled successfully"; tsx tests don't type-check.
  Avoid `env: {...} = process.env` default params (TS2559 weak-type) — read env in the body.
- **Off-by-default flag** for any runtime change; three-state (off/observe/enforce) like M4/CSP.
- **Workers/OpenNext runtime:** unawaited promises after response are CANCELED → use
  `getCloudflareContext().ctx.waitUntil(...)` for deferred work (else emails/side-effects silently drop).
- **Edge middleware:** no `node:crypto` → WebCrypto (`crypto.subtle`). Workers has no `timingSafeEqual`
  → constant-time byte-XOR compare. Use constant-time for ALL secret/token/signature compares.
- **Unauthenticated surfaces:** no enumeration (uniform response + defer all DB work past response commit,
  identical bytes/timing for match vs no-match). Rate limits MUST NOT be bypassable via direct
  `*.workers.dev` — do NOT add mutation endpoints to origin-guard bypass lists.
- **Untrusted input (email/webhook):** every field hostile. SPF/DKIM/DMARC = display signal, never authz.
  Attacker-chosen ids (Message-ID etc.) → `INSERT ON CONFLICT DO NOTHING`, never UPDATE from inbound.
  Never silent-drop (forward-to-human / non-2xx). Length caps on every stored field.
- **Agent authority:** the shared `STUDIO_AGENT_API_TOKEN` permits *unblocked* canonical mutations
  (only finance is enforced-blocked). Any untrusted-input-driven drafter must have ZERO canonical-write
  authority + a guard test asserting a hostile body writes zero canonical rows.
- **Secrets fail closed** in production when unset (throw), dev fallback only outside prod.
- **Proxy CSP:** don't clobber app CSP on miss OR cache-HIT; cacheable `/book/*` must OMIT `script-src`
  ('self' blocks Next's inline bootstrap). Nonces require dynamic rendering.
- **Classifier drift:** pin app classifiers against the proxy's real public-path predicates with a drift test.
- **Prod D1 migrations:** the `d1_migrations` tracker is out of sync with actual schema. Apply additive
  migrations via idempotent `CREATE TABLE IF NOT EXISTS` direct `d1 execute --file`; do NOT blanket
  `migrations apply --remote` (would error on already-existing tables). Reconcile the tracker separately.
- **Deploy rails:** real D1 backup → capture Worker rollback version → deploy → health-check
  (redirects, 401/405, security headers, referrer-policy) → rollback on failure.
- **Migration ordering:** a schema-dependent change that is NOT flag-gated (e.g. an always-on
  column filter) requires its migration applied to prod **before** the Worker deploy, or existing
  flows 500 on the missing column. Apply the migration first, verify the column + row sanity, then
  deploy the Worker. Flag-gated features can migrate anytime (dark).
- **PRG uniform response:** a POST that must not leak (match vs no-match, flag state) can answer with
  a 303 to a neutral confirmation (`?sent=1`) — verify the redirect target is the neutral page, NOT
  `/admin/login` (which would mean the proxy is login-walling a should-be-public endpoint).
