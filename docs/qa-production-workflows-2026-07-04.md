# Production Workflow QA + Security Pass — 2026-07-04

**Status:** PASS with findings (0 critical, 0 high, 9 medium/low hardening findings — 6 fixed on this branch, see Remediation Status)
**Auditor:** Claude (autonomous QA session)
**Base commit:** `42c9472` (`feat: add studio system status page`); `main == origin/main`
**Environment:** Fresh cloud clone at `/home/user/studio-bythereeses`. The canonical macOS working copy (`/Volumes/reeseai-memory/04_Code/reese-photography-crm`) is not mounted here; this container has **no Google admin session and no `STUDIO_AGENT_API_TOKEN`**, which bounds what could be exercised live (see "Areas not tested").

Related: [`qa-production-workflows.md`](qa-production-workflows.md) (2026-07-03 audit), [`security-model.md`](security-model.md), [`route-access-audit.md`](route-access-audit.md), [`deployment-live-testing.md`](deployment-live-testing.md).

## Overall Summary

Production is **healthy and correctly locked down** for every surface reachable without privileged credentials. Host split, origin blocking, agent/MCP auth, tokenized client links, Stripe webhook verification, and the finance approval guard are all enforced and match the documented model. Local verifiers are green.

No critical or high-severity exploitable defect was found. Nine hardening findings are listed below; the top three are unauthenticated-booking input-handling issues. _At audit time_ no code was changed and nothing was pushed or deployed; **six findings (M1–M3, L5, L6, L9) were subsequently fixed on this branch after Tyler's approval — see the Remediation Status section.** **No production test records were created** — the live booking mutation was intentionally held (rationale below).

| Gate | Result |
| --- | --- |
| `npm install` | ok (only `package-lock.json` churn, uncommitted) |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| `npm run test` | PASS — 172/172 |
| Live read-only production probes | PASS (all, see matrix) |
| Code + agent security review | PASS — 0 critical/high; 9 hardening items |

## Workflows Tested (live, read-only) — all PASS

| # | Check | Route | Result |
| --- | --- | --- | --- |
| 1 | Studio unauth redirect | `studio…/`, `/projects`, `/system-status` | 303 → `/admin/login?next=…` |
| 2 | Schedule host isolation | `schedule…/`, `/projects` | 303 → `/book/wedding-photography-discovery-call` |
| 3 | Security headers | all responses | HSTS(preload), CSP(min), `x-frame:DENY`, nosniff, referrer-policy, permissions-policy |
| 4 | Direct Worker origin block | `*.workers.dev` `/`, `/projects`, `/api/agent/*` | 404 |
| 5 | Agent REST auth | `/api/agent/projects` (no/bad token) | 401; unset → 503 (verified in code) |
| 6 | MCP auth | `POST /api/mcp` (no token), `GET /api/mcp` | 401; 405 |
| 7 | Agent surface not on public host | `schedule…/api/agent/projects` | 303 (not exposed) |
| 8 | Public booking page + cache | `/book/wedding-photography-discovery-call` | 200, `cache-control: public, max-age=60`; real 45-min slots bookable |
| 9 | Proposal token (invalid) | `/proposal/:bad`, `POST /api/proposal/:bad/accept` | 404; 404 generic (no info leak) |
| 10 | Portal (no session) | `studio…/portal` | 200, clean empty state, **no client data** |
| 11 | Questionnaire response method | `GET /api/questionnaires/:id/responses` | 405 (POST-only) |
| 12 | Booking manage (no token) | `/book/:slug/manage` | 404 |
| 13 | Admin APIs unauth | `POST /api/projects/:id/portal`, `/api/proposals`, `/api/settings`, `/api/search` | 303 → login (all gated by proxy) |
| 14 | Cron reminders unauth | `/api/cron/scheduler-reminders` | 303 (proxy-gated); handler also requires bearer secret |

Booking pipeline verified end-to-end up to the POST boundary: availability generation, calendar/slot rendering, and the form contract (`meetingTypeId`, `attendeeName`, `attendeeEmail`, `startAt`/`endAt`, invitee answers) are all correct and healthy.

## Code + Agent Security Review — verified strong

- **Pages proxy** (`pages-proxy/_worker.js`): HMAC-signed admin session cookie, OAuth `state` nonce CSRF check, email allowlist (`hello@bythereeses.com`), POST body buffering, origin-secret injection, Worker-origin redirect rewriting, and per-kind IP rate limits.
- **Stripe webhook** (`src/lib/stripe-checkout.ts`): HMAC-SHA256 + `timingSafeEqual` + 300s timestamp tolerance (replay protection). Payment recording is reachable **only** through the signature-verified webhook — not agent-forgeable.
- **Proposal/portal tokens**: 256-bit random, SHA-256 at rest (plaintext never stored), expiring, revocable, project/proposal-scoped. No IDOR found; `/p/:token` strips the credential from the URL into an httpOnly cookie.
- **Finance approval guard**: all six blocked finance mutations hard-fail as the first statement of their `*FromAgent` wrapper; all 37 `/api/agent/**` handlers and `/api/mcp` invoke `guardAgentApiRequest` before any parsing/mutation. No un-guarded route, no indirect bypass.
- **XSS**: no `dangerouslySetInnerHTML` anywhere; contract/proposal/notes bodies render as React-escaped plain text.
- **SQL injection**: all Drizzle `sql\`\`` usage is parameterized; no untrusted concatenation.
- **Email**: Resend JSON API — user input reaches only body/`to`, never headers/subject; no CRLF injection.

## Remediation Status (2026-07-04, approved by Tyler)

Six findings were fixed in this branch; verifiers re-run green (lint, build, **172/172 tests**). Changed files: `src/lib/scheduler.ts`, `src/lib/questionnaire-links.ts`, `src/lib/agent-api.ts`, `src/app/api/cron/scheduler-reminders/route.ts`.

| Finding | Status | Change |
| --- | --- | --- |
| M1 phone overwrite | **Fixed** | `findOrCreateSchedulerClient` now fills phone only when the existing record has none; never overwrites. |
| M2 inactive bookable | **Fixed** | `createSchedulerBookingFromForm` rejects `!meetingType.isActive`. |
| M3 unbounded input | **Fixed** | Length caps on name/email/phone/notes + per-answer and serialized-answers caps. |
| L5 fallback secrets | **Fixed** | `schedulerLinkSecret`/`questionnaireLinkSecret` throw in production when unset; dev/test fallback retained. |
| L6 cron fail-open | **Fixed** | Cron route returns 503 when no secret configured; constant-time compare. |
| L9 timing compare | **Fixed** | Agent bearer compare uses `timingSafeEqual` with length guard. |
| M4 single-layer admin authz | Open (design) | Needs signed proxy header; deferred. |
| L7 proposal token in URL | Open (proxy) | Add `Referrer-Policy` on `/proposal/**`; deferred (proxy redeploy). |
| L8 CSP no `script-src` | Open (proxy) | Needs Next.js nonce plumbing; deferred to avoid hydration breakage. |
| Info dead code | Open | Left as-is; low risk. |

## Findings (severity-ranked)

### Medium

**M1 — Unauthenticated overwrite of an existing client's phone via booking**
- Route: `POST /api/scheduler/bookings` → `findOrCreateSchedulerClient` (`src/lib/scheduler.ts:474-484`).
- Repro: submit a booking with a known/guessed existing client email and an attacker-supplied phone.
- Expected: an unauthenticated booker cannot mutate an existing CRM client record.
- Actual: the existing client's `phone` is overwritten (`phone || existing.phone`) and the booking is attached to that real client. Bounded — phone-only, no name/email overwrite, no data read back to attacker.
- Fix: change to fill-if-absent (`existing.phone || phone`), or skip the client update entirely on the unauthenticated path.

**M2 — Inactive meeting types remain publicly bookable**
- Route: `POST /api/scheduler/bookings`; lookup `src/lib/scheduler.ts:822` has no `isActive` filter (UI hides inactive via `notFound()` at `src/app/book/[slug]/page.tsx:116`, but the API does not).
- Repro: direct POST with a deactivated `meetingTypeId`.
- Expected: a deactivated meeting type rejects new bookings. Actual: booking is created.
- Fix: check `meetingType.isActive` in `createSchedulerBookingFromForm` before insert.

**M3 — No length caps on public booking inputs (storage/DoS)**
- Route: `POST /api/scheduler/bookings`; `attendeeName`, `notes`, invitee answers (`src/lib/scheduler.ts:808,813,886`) are stored with no size limit. The questionnaire route already caps (`MAX_ANSWER_LENGTH=5000`, serialized `100000`).
- Fix: enforce equivalent server-side length caps on the booking path.

**M4 — Admin authorization is single-layer (proxy only)**
- All Studio admin pages/APIs rely entirely on the Pages proxy Google session; the in-app `guardDirectWorkerApiRequest` is a no-op on the custom domain (it only blocks `*.workers.dev`). Verified enforced today (admin APIs 303→login; `workers.dev` 404-blocked), so **not currently exploitable** — but there is no in-app defense-in-depth if the proxy is bypassed or `ORIGIN_PROXY_SECRET` is unset. This matches the documented residual risk in `security-model.md`.
- Fix (hardening): have the proxy pass a signed header the app verifies for admin routes; keep the origin secret mandatory.

### Low / Informational

**L5 — Fallback HMAC link secrets.** `schedulerLinkSecret()` (`src/lib/scheduler.ts:348-350`) and `questionnaireLinkSecret()` (`src/lib/questionnaire-links.ts:15-17`) fall back to constant strings when env is unset → token forgery if prod ever runs without `SCHEDULER_LINK_SECRET`/`AUTH_SECRET`. Required in prod, so low real risk. Fix: fail closed in production.

**L6 — Cron route fails open if secret unset.** `src/app/api/cron/scheduler-reminders/route.ts:9` enforces the bearer only when a secret is configured. Fix: require the secret (fail closed), matching the agent guard.

**L7 — Proposal token persists in URL.** `/proposal/:token?accepted=1` leaves the token in history/referrer (portal already strips its token). Fix: add `Referrer-Policy: no-referrer`/`same-origin` on `/proposal/**`.

**L8 — CSP has no `script-src`/`default-src`.** The proxy strips the origin CSP and sets a minimal one (`pages-proxy/_worker.js:18`); XSS is mitigated by React escaping only. Fix: add `script-src 'self'` (+ any needed hashes) for defense-in-depth.

**L9 — Non-constant-time agent bearer compare.** `src/lib/agent-api.ts:24` uses `!==`. Impractical to exploit over the network against a high-entropy token, but inconsistent with the repo's own `timingSafeEqual` usage. Fix: length-guard + `crypto.timingSafeEqual`.

**Info — Dead code after finance kill-switch.** The six blocked finance functions keep their full original bodies as unreachable code after `return requireTyler…()`. Not exploitable, but a future refactor that makes the guard conditional would silently re-expose live mutation code. Fix: delete the dead bodies or gate behind an explicit, tested approval flag.

**Info — Unauthenticated orphan questionnaire-response creation** (`src/app/api/questionnaires/[id]/responses/route.ts`) is per-request size-capped but only IP-rate-limited at the proxy; low-value spam vector.

## Records / Test Data Created

**None.** No production booking, client, project, calendar event, or email was created. The live booking submission (checklist item 1) was **intentionally held**: this container cannot verify any downstream record (no admin session, no agent token), while a real POST would produce irreversible outward side effects — a Google Calendar event on `hello@bythereeses.com` and Resend confirmation emails to the attendee and admin. An unverifiable production mutation with outward side effects is not justified autonomously. See the ready-to-run repro below for Tyler.

### Ready-to-run live booking test (for Tyler, who can verify calendar + inbox)
1. Open `https://schedule.bythereeses.com/book/wedding-photography-discovery-call`.
2. Pick an available date/time (e.g. a 9:00 AM ET slot).
3. Enter clearly-named QA contact — e.g. Name `QA TEST — Reese CRM`, an email Tyler controls.
4. Submit; confirm: confirmed page, scheduler-admin booking row, client record, Google Calendar event on `hello@bythereeses.com`, slot removed from availability, Resend confirmation + admin notification.
5. Cancel via the manage link to clean up.

## Areas Not Tested (and why)

- **Studio admin CRM, questionnaire admin, proposal generation (admin), contract admin, invoice/payment states, Studio Inbox, agent/MCP live calls, portal with a real token** — all require the Google admin session or `STUDIO_AGENT_API_TOKEN`; neither exists in this container. Covered indirectly by the 172-test suite and by the code/agent security review above.
- **`npm run smoke:production` / `smoke:perf`** — need `STUDIO_AGENT_API_TOKEN` (env or macOS keychain); not available here. Last green in the 2026-07-03 audit.
- **Live Stripe payment** — not exercised (safety rule: no real charges). Signature verification reviewed statically and is correct.

## Recommended Next Steps

1. Have Tyler run the live booking test above (or provide the agent token so `smoke:production` can run here).
2. ~~Approve the scoped fixes for M1–M3~~ — **done** (fixed on this branch; verifiers green).
3. ~~L5/L6 fail-closed + L9 constant-time~~ — **done** (same batch).
4. Track M4 and L7/L8 (and the finance dead-code cleanup) as defense-in-depth hardening — scheduled as **Phase 6** in [`roadmap.md`](roadmap.md); design spec in `docs/specs/phase-6-hardening-r2.md`.
5. Deploy the branch to production (fixes are not live until deployed).

_Update: six fixes were applied and pushed after Tyler's approval; see Remediation Status. Not yet deployed._
