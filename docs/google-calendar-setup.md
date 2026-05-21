# Google Calendar Setup

## Goal

The scheduler should:

- Check busy/free conflicts across every calendar listed in scheduler settings.
- Create new booked events only on `hello@bythereeses.com`.
- Use the recurring Zoom link until a Zoom app integration is added later.

## Production URLs

- OAuth redirect URI: `https://studio.bythereeses.com/api/google/callback`
- Scheduler admin: `https://studio.bythereeses.com/scheduler`
- Public scheduler: `https://schedule.bythereeses.com/book/wedding-photography-discovery-call`

## Cloudflare Secrets Needed

Set these on the `reese-photography-crm` Worker:

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
```

`GOOGLE_REDIRECT_URI` is a non-secret Worker variable in `wrangler.jsonc`.

## Google Cloud Console Steps

1. Go to Google Cloud Console.
2. Create or choose a project for The Reeses CRM.
3. Enable the Google Calendar API.
4. Configure the OAuth consent screen.
5. Create OAuth Client credentials:
   - Application type: Web application
   - Authorized redirect URI: `https://studio.bythereeses.com/api/google/callback`
6. Copy the client ID and client secret.
7. Set them as Worker secrets.
8. Visit `https://studio.bythereeses.com/api/google/auth`.
9. Sign in as the Google account that has access to all calendars the CRM should check.
10. Copy the returned `GOOGLE_REFRESH_TOKEN`.
11. Set that token as a Worker secret.
12. Redeploy the Worker.

## Calendar Access Rules

The authorized Google account must have access to every calendar listed in the scheduler settings. The scheduler can only see calendars that the authorized account can see.

Recommended first setting:

```txt
Calendars to check for conflicts: hello@bythereeses.com
Calendar to create events on: hello@bythereeses.com
```

After the first live test works, add other calendar IDs to the conflict-check list as comma-separated values.

## Verification

1. Open `https://studio.bythereeses.com/scheduler`.
2. Confirm Google Calendar shows `Connected`.
3. Book a test slot on `https://schedule.bythereeses.com/book/wedding-photography-discovery-call`.
4. Confirm the booking appears in the CRM.
5. Confirm an event appears on the `hello@bythereeses.com` calendar.
6. Confirm the booked slot no longer appears as available.

