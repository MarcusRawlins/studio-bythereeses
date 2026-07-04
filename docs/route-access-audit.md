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
