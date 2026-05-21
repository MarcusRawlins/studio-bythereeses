# Deployment Live Testing

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
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL=The Reeses <hello@bythereeses.com>`
- `SCHEDULER_ADMIN_EMAIL=hello@bythereeses.com`

Do not commit secret values to the repo or Obsidian.

Google Calendar setup details live in `docs/google-calendar-setup.md`.

## Before First Deploy

1. Confirm Wrangler is authenticated to the `hello@bythereeses.com` Cloudflare account, not a different personal account.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm run backup:data` with a valid Cloudflare API token in the shell.
5. Confirm the remote D1 schema is current.
6. Confirm custom domains are attached to the Cloudflare Worker, then confirm DNS points to that accepted Cloudflare target.

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

## Deploy Commands

Use the OpenNext Cloudflare adapter:

```bash
npm run preview
npm run deploy
```

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
- Operational backups stay on `/Volumes/reeseai-memory/backups/reese-photography-crm`.
