# Route Access Audit

Last reviewed: 2026-07-04 (booking hardening landed on branch `claude/reese-crm-production-qa-4caxz0`, not yet deployed: `POST /api/scheduler/bookings` now rejects inactive meeting types, caps input lengths, and does not overwrite an existing client's phone).

## Enforcement Layers

- `studio.bythereeses.com` is the private Studio front door. Browser admin routes require the Pages proxy Google session for the configured admin email before requests reach the Worker.
- `schedule.bythereeses.com` is the public scheduler front door. The Pages proxy only allows booking, scheduler API, public questionnaire response, public proposal package, and static asset paths on this host.
- Direct `*.workers.dev` access is blocked by `ORIGIN_PROXY_SECRET` for non-public routes. A small set of public scheduler, token, webhook, and callback paths intentionally bypasses the raw-origin block because those routes need external or client access.
- `/api/agent/*` and `/api/mcp` require `Authorization: Bearer <STUDIO_AGENT_API_TOKEN>` in the app route handlers. The Pages proxy forwards these paths without a Studio browser session so agents can authenticate by bearer token.
- `/proposal/:token`, `/api/proposal/:token/*`, `/p/:token`, `/portal`, and `/portal/proposals/:proposalId` are token/session-scoped client surfaces, not admin surfaces.

## Admin-Only Browser Routes

These routes are private Studio UI and should only be reachable through `studio.bythereeses.com` after the Pages proxy validates the admin Google session:

- `/`
- `/activity`
- `/agenda`
- `/clients`, `/clients/:id`, `/clients/:id/edit`
- `/data-health`
- `/finance`
- `/inbox`
- `/invoices`, `/invoices/new`, `/invoices/:id`
- `/projects`, `/projects/new`, `/projects/:id`, `/projects/:id/edit`
- `/proposals`, `/proposals/new`, `/proposals/:id`
- `/questionnaires`, `/questionnaires/:id`, `/questionnaires/:id/edit`, `/questionnaires/:id/send`, `/questionnaires/:id/responses`, `/questionnaires/:id/responses/:responseId`, `/questionnaires/:id/responses/:responseId/edit`
- `/scheduler`, `/scheduler/bookings/:id`
- `/settings`
- `/system-status`
- `/shooting-locations`
- `/templates`

## Admin-Only Studio APIs

These APIs expose Studio CRM data or mutate Studio records. They should only be reachable through the authenticated Studio front door, except direct Worker access with the origin proxy secret:

- `/api/clients/*`
- `/api/finance/*`
- `/api/invoices/*`
- `/api/projects/*`
- `/api/proposals`, `/api/proposals/:id`, `/api/proposals/:id/link`, `/api/proposals/:id/workflow`
- `/api/questionnaires/:id/responses`
- `/api/search`
- `/api/settings`
- `/api/shooting-locations`
- `/api/templates`
- `/api/scheduler/meeting-types`
- `/api/scheduler/settings`

## Agent and MCP APIs

These routes are intentionally public at the Studio proxy layer but protected inside the app by `STUDIO_AGENT_API_TOKEN`:

- `/api/mcp`
- `/api/agent/*`

Current residual risk: this is one shared bearer token. Keep it secret-only in deployment config and rotate it after suspected exposure. Upgrade to scoped, rotatable agent credentials before adding more agents or any external client access.

## Public Scheduler and Questionnaire Routes

These routes are intentionally public on `schedule.bythereeses.com`:

- `/book/:slug`
- `/book/:slug/confirmed`
- `/book/:slug/manage`
- `/api/scheduler/bookings`
- `/questionnaires/:id/preview`
- `/questionnaires/:id/confirmed`
- `/api/questionnaires/:id/responses`

Mutation routes are rate-limited by the Pages proxy. Booking and questionnaire handlers must continue validating canonical IDs, expected state, and write shape server-side.

## Tokenized Client Routes

These routes are intentionally public/token/session-based. The token is the credential and must stay long, random, scoped, expiring, revocable, and stored only as a hash:

- `/proposal/:token`
- `/api/proposal/:token/accept`
- `/p/:token`
- `/portal`
- `/portal/proposals/:proposalId`
- `/portal` autopay server actions (Phase 13, §4.1/§4.3): turning autopay on/off is done via Next.js **server actions** posting to `/portal` (public, portal-session-bound), NOT standalone API routes. Each action resolves the project ONLY from the portal session (`requirePortalProject`), never from a request body (no IDOR), and no-ops when `AUTOPAY_ENABLED` is dark (I1). The single mutation path is the server action; there is deliberately no `/api/portal/autopay/*` route (dropped at diff review, MEDIUM-1).

Current implementation status:

- Proposal and portal tokens are generated from 32 random bytes.
- Token hashes are stored with SHA-256; plaintext tokens are not stored.
- Proposal links are scoped to proposal, project, and optional client.
- Portal links are scoped to project and optional client.
- Proposal links expire and revoke earlier matching active links.
- Portal links expire and can be revoked.
- Portal sessions use HTTP-only cookies containing project/token IDs, not plaintext token values.
- The Pages proxy rate-limits tokenized link access by client IP.

## Webhooks, OAuth, and Cron

These routes are non-browser integration surfaces and must remain explicitly guarded in their handlers:

- `/api/stripe/webhook`: Stripe signature verification required.
- `/api/google/auth`: starts admin Google OAuth.
- `/api/google/callback`: completes admin Google OAuth.
- `/api/cron/scheduler-reminders`: bearer secret required.
- `/api/cron/sequences` (Phase 8c): **bearer-secret required, fail-closed.** `503` when `CRON_SECRET` unset, `401` on constant-time mismatch, and a `200 {skipped:"flag_off"}` short-circuit when `SEQUENCES_ENABLED != "1"` (a registered cron on a dark deploy is a guaranteed no-op). Reached DIRECTLY over the `*.workers.dev` origin by the `reese-sequence-runner` split worker (`redirect:"manual"` + throw on any redirect/non-2xx), bearer-authed — the same trust shape as `/api/cron/scheduler-reminders`. It IS in the origin-guard `PUBLIC_API_PREFIXES` bypass (the bearer secret at the origin is the trust boundary; no side effects before the bearer check), and admin-proof-exempt via the `/api/cron/` prefix. Deliberately NOT on the proxy public path — the runner never points at `studio.bythereeses.com`, which login-walls `/api/cron/*` (303 → `/admin/login` 200 = silent drop). The runner (`src/lib/sequences.ts`) is config+template driven with NO agent/MCP surface: templates are code constants and no untrusted input can choose a recipient, body, or send.
- `/api/cron/autopay-charge` (Phase 13): **bearer-secret required, fail-closed.** `503` when `CRON_SECRET` (fallback `SCHEDULER_LINK_SECRET`) unset, timing-safe `401` on mismatch, and a `200 {skipped:"flag_off"}` short-circuit when `AUTOPAY_ENABLED != "1"` (a registered cron on a dark deploy is a guaranteed money-safe no-op — it selects nothing and calls no Stripe endpoint). Reached DIRECTLY over the `*.workers.dev` origin by the `reese-autopay-charge` split worker (`redirect:"manual"` + throw on any redirect/non-2xx), bearer-authed — identical trust shape to `/api/cron/sequences`. It IS in the origin-guard `PUBLIC_API_PREFIXES` bypass (the bearer secret at the origin is the trust boundary) and admin-proof-exempt via the `/api/cron/` prefix. Deliberately NOT on the proxy public path — the runner never points at `studio.bythereeses.com`, which login-walls `/api/cron/*` (303 → `/admin/login` 200 = silent drop, a money-relevant outage here). The engine (`src/lib/autopay-charge.ts`) derives every charge server-side from consented rows; no untrusted input picks which installment to charge (I5). The split worker ships UN-WIRED/dark until Tyler's enablement runbook (§7). Consent capture + revoke are NOT API routes — they are portal server actions on the public `/portal` surface (see Tokenized Client Routes); the standalone `/api/portal/autopay/{setup,revoke}` routes were dropped at diff review as unreachable duplicate surface (MEDIUM-1).
- `/api/email/unsubscribe` (Phase 8c): **public, client-facing, self-authed by a signed token in the URL.** RFC 8058 one-click unsubscribe. **GET renders a confirm page and writes NOTHING** (mail-scanner-prefetch guard); **only POST writes** — verifies the HMAC token constant-time (`UNSUBSCRIBE_SECRET`; fail-closed `400` on bad/absent token), then `INSERT ... ON CONFLICT(email) DO NOTHING` into `email_suppressions` (idempotent; a replayed/forged POST can only ever SUPPRESS — fail-safe direction) and voids open `sequence_step` email drafts for that recipient. The token binds the email, so one client cannot unsubscribe another; scoped to `purpose="sequences"` so it never suppresses transactional booking mail. Real browsers/mail-scanners hit the public `studio.bythereeses.com` host, so it IS proxy-fronted: `isStudioPublicPath` + `adminProofRequired`-exempt + a `publicMutation` rate-limit kind for the POST, pinned in the drift test. Deliberately NOT in the origin-guard bypass — it belongs on the proxy path, not origin-direct.
- `/api/inbound/inquiry-email` (Phase 8a): **public-but-bearer-authed.** Dedicated `INBOUND_INTAKE_SECRET` bearer required (fail-closed: `503` when unset, `401` when wrong, `503` when `INQUIRY_INTAKE_ENABLED != "true"`). The `reese-inquiry-intake` Email Routing Worker is the only caller. It is proxy-public (`isStudioPublicPath`) and admin-proof-exempt (`adminProofRequired` → `false`) so the Worker's unauthenticated-to-the-proxy POST is not 303'd to `/admin/login` (which would be a silent lead drop); it is authenticated by its own secret, NOT the admin session. It is deliberately NOT in the origin-guard bypass, so it is reachable only through the proxy (which stamps the origin secret), never directly on `*.workers.dev`. Authority is write-triage-only: it can insert an `inbound_inquiries` staging row + an authority-less review task, and can never create a project, move money, or send email.
- `/api/twilio/inbound` and `/api/twilio/status` (Phase 8b): **public-but-signature-authed.** Each verifies **X-Twilio-Signature** (HMAC-SHA1 over its OWN configured URL constant + sorted decoded params, constant-time via `timingSafeEqual` on the Node runtime). Per-route URLs (B2): the inbound route verifies against `TWILIO_PUBLIC_WEBHOOK_URL_INBOUND`, the status route against `TWILIO_PUBLIC_WEBHOOK_URL_STATUS` — a single shared constant would 403 one route permanently. **Fail-closed:** `503` when `TWILIO_AUTH_TOKEN` **or** the route's own URL constant is unset; `403` on missing/bad signature. The signed URL is the stored constant, never reconstructed from `Host`/`X-Forwarded-Host` (attacker-influenceable — a spoofed `X-Forwarded-Host` does not change the verified base; test-pinned). Both are proxy-public (`isStudioPublicPath`) and admin-proof-exempt (`adminProofRequired` → `false`) so Twilio's POST is not 303'd to `/admin/login` (a silent STOP/status drop). They get a **dedicated, generous `twilioWebhook` rate-limit kind** in the proxy (NOT `publicMutation`, which would 429 a genuine `STOP`). Deliberately NOT in the origin-guard bypass — reachable only through the proxy. Authority is consent-state + logging ONLY: insert/delete `sms_suppressions`, flip `clients.smsOptIn` on matched clients, insert an inbound comm row / activity record, advance `deliveryStatus` on an already-owned row (INSERT-ON-CONFLICT, never UPDATE canonical rows from inbound). It can never create projects/clients, move money, or send anything (no outbound Twilio call from the webhook — HELP is answered Twilio-side).

## Static Assets

These routes are intentionally public:

- `/_next/static/*`
- `/favicon.ico`
- `/icon.png`
- `/apple-icon.png`
- `/brand/*`
- `/fonts/*`

## Known Follow-Ups

- Move front-door rate limits from in-memory Pages proxy buckets to Cloudflare WAF, Turnstile, or another durable edge control if public abuse appears.
- Replace shared agent bearer auth with scoped credentials before any external agent/client access.
- Internal security status page lives at `/system-status` and reports proxy guard, agent auth, backup/deploy policy, npm audit state, token-link policy, data-health counts, and last review date without exposing secret values.
- Keep the scoped Next/PostCSS npm override until a stable Next release ships with patched PostCSS directly, then remove the override after audit, build, and tests pass.
