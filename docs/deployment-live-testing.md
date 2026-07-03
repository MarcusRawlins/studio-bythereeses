# Deployment Live Testing

Source-of-truth SOP: [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md). Ops stabilization checklist (gates, rollback, backup/MCP drills): [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md). Agent/MCP operating reference: [`studio-agent-access.md`](studio-agent-access.md).

## Targets

- Backoffice: `https://studio.bythereeses.com`
- Public scheduler: `https://schedule.bythereeses.com`
- Current live Worker: `https://reese-photography-crm.solitary-flower-c3ab.workers.dev`
- Pages front door / CNAME target: `studio-bythereeses.pages.dev`
- Cloudflare account: `hello@bythereeses.com`
- D1 database: `studio-bythereeses`
- R2 bucket: `studio-bythereeses`

## Required Production Variables

Set these as Cloudflare Worker secrets/variables before real client testing:

- `GOOGLE_CLIENT_ID` - set in Cloudflare on 2026-05-01
- `GOOGLE_CLIENT_SECRET` - set in Cloudflare on 2026-05-01
- `GOOGLE_REFRESH_TOKEN` - set in Cloudflare on 2026-05-01
- `GOOGLE_CALENDAR_IDS`
- `GOOGLE_CALENDAR_ID=hello@bythereeses.com`
- `NEXT_PUBLIC_APP_URL=https://studio.bythereeses.com`
- `NEXT_PUBLIC_SCHEDULE_URL=https://schedule.bythereeses.com`
- `SCHEDULER_LINK_SECRET`
- `STUDIO_AGENT_API_TOKEN` - Worker secret used by trusted agent REST and MCP calls through `Authorization: Bearer ...`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL=The Reeses <hello@bythereeses.com>`
- `SCHEDULER_ADMIN_EMAIL=hello@bythereeses.com`
- `STRIPE_SECRET_KEY` - Worker secret used to create hosted Checkout Sessions for invoice installments
- `STRIPE_WEBHOOK_SECRET` - Worker secret for verifying Stripe webhook signatures at `/api/stripe/webhook`

Do not commit secret values to the repo or Obsidian.

Google Calendar setup details live in `docs/google-calendar-setup.md`.

## Before First Deploy

1. Confirm Wrangler is authenticated to the `hello@bythereeses.com` Cloudflare account, not a different personal account.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm run backup:data` with a valid Cloudflare API token in the shell.
5. Run `npm run deploy:capture-versions` to snapshot current Worker/Pages deployment IDs + git HEAD into `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/manifests/latest-deploy-versions.json`.
6. Run `npm run check:source-drift` to confirm known local copies agree on origin URL and HEAD (warnings only for dirty worktree, absent copies, or ahead/behind upstream).
7. Run `npm run deploy:preflight` (includes source-drift check).
8. Confirm the remote D1 schema is current.
9. Confirm custom domains are attached to the Cloudflare Worker, then confirm DNS points to that accepted Cloudflare target.

`npm run deploy:preflight` checks the local deployment shape before upload. It fails when `CLOUDFLARE_API_TOKEN` is missing, when `src/middleware.ts` is missing, when `src/proxy.ts` exists, or when core Cloudflare config files are missing. Next.js 16 `proxy.ts` currently runs on Node.js, which OpenNext Cloudflare cannot deploy; keep the edge `middleware.ts` convention until Next/OpenNext support edge proxy for this target. It also warns when `studio.bythereeses.com` or `schedule.bythereeses.com` still appear to serve stale Alex/Tyler branding.

## Current Domain Status

As of 2026-05-01, the Worker deploy is live and healthy at the workers.dev URL, and a Cloudflare Pages front door is live at `studio-bythereeses.pages.dev`.

Squarespace / external DNS CNAME target:

- `studio.bythereeses.com` -> `studio-bythereeses.pages.dev`
- `schedule.bythereeses.com` -> `studio-bythereeses.pages.dev`

Cloudflare Pages custom domain status:

- `studio.bythereeses.com`: active
- `schedule.bythereeses.com`: active

Architecture note: the full dynamic Next.js app still runs on Cloudflare Workers through OpenNext. Pages acts as the external-DNS-compatible front door and proxies requests to the Worker. This preserves D1/R2/server-action support while allowing Squarespace CNAME records to point to a Pages hostname.

OAuth note: `studio.bythereeses.com/api/google/auth` is handled directly in the Pages front door as a 307 redirect to Google. The proxied Worker path hit Cloudflare 1102 resource limits for this redirect response, while normal dynamic app routes and the OAuth callback continue to proxy to the Worker.

Proxy form note: Pages buffers non-GET/non-HEAD request bodies before proxying them to the Worker and rewrites Worker-origin redirect locations back to the incoming custom domain. This keeps Studio admin POST forms reliable and prevents redirects to the internal workers.dev hostname.

Agent API note: `studio.bythereeses.com/api/agent/*` and `studio.bythereeses.com/api/mcp` intentionally pass through the Pages front door without a Google browser session so trusted agents can authenticate with their bearer-token headers. Browser admin pages remain Google-protected, and `schedule.bythereeses.com` does not expose Studio agent/admin routes.

## Deploy Commands

Use the OpenNext Cloudflare adapter:

```bash
npm run deploy:capture-versions
npm run deploy:preflight
npm run preview
npm run deploy
npm run deploy:pages-proxy
npm run smoke:production
```

## Rollback

Before a risky deploy, `npm run deploy:capture-versions` records the current Worker version, Pages production deployment, and git HEAD. If a deploy goes wrong:

1. `npm run deploy:rollback -- --plan` — shows the prior Worker version from the latest capture.
2. `npm run deploy:rollback -- --yes` — rolls the Worker back to that version (requires `CLOUDFLARE_API_TOKEN`).
3. Roll back the Pages front door in the Cloudflare dashboard (`studio-bythereeses` project) if the proxy worker changed.
4. `npm run smoke:production` — verify production health.

Alternative: redeploy a known-good git commit after the full deploy gate. See [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md).

`npm run smoke:production` is a non-destructive live check. It verifies the Studio/Schedule host split, direct Worker-origin blocking, restored production project/client counts, zero data-health issues, trusted agent finance access, trusted agent task-list access, trusted agent workflow-list access, MCP finance tool availability, MCP agent task-loop/result-submission tool availability, and MCP project workflow automation tool availability. It reads `STUDIO_AGENT_API_TOKEN` from the shell or macOS Keychain service `reese-studio-agent-api-token`.

## First Live Scheduler Test

1. Complete Google OAuth at `https://studio.bythereeses.com/api/google/auth` and set the returned `GOOGLE_REFRESH_TOKEN`.
2. Open `https://schedule.bythereeses.com/book/wedding-photography-discovery-call`.
3. Book a test slot with Tyler-owned test contact details.
4. Confirm the booking appears in the scheduler admin page.
5. Confirm the client record was created or updated.
6. Confirm the Google Calendar event is created on `hello@bythereeses.com` once Google OAuth credentials are present.
7. Confirm the slot disappears from future availability once Google Calendar sync is active.
8. Confirm Resend sends the client confirmation and admin notification.
9. Use a project detail page booking link for the vision/timeline call and confirm the booking lands on that project.

## Scheduler Admin Notes

- Scheduler defaults are seed-only. Existing event type edits must not be overwritten by the default seeding routine.
- Availability is stored compactly in `scheduler_settings.availability_json`.
- Availability day numbers use `7` for Sunday, `1` for Monday, through `6` for Saturday.
- Each day can be enabled/disabled and have its own start/end time.

## Data Rules

- D1 stores compact relational records and small JSON answers only.
- R2 stores only files that must be part of the product.
- Operational backups stay on `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm`.
