# Performance and Origin Hardening

## Current Performance Shape

- Public scheduler pages are intentionally served through `schedule.bythereeses.com`.
- Anonymous public booking pages under `/book/*` are cached by the Cloudflare Pages proxy for 60 seconds.
- Confirmed/manage pages, project-scoped links, and reschedule links are not cached.
- The Pages proxy returns `204` for browser/Next prefetch requests before they reach the dynamic Worker.
- The scheduler code performs one availability pass for the public booking page and reuses the same busy-time range for the selected date.

## Smoke Test

Run:

```bash
npm run smoke:perf
```

Optional overrides:

```bash
SMOKE_SCHEDULE_URL=https://schedule.bythereeses.com \
SMOKE_STUDIO_URL=https://studio.bythereeses.com \
SMOKE_BOOKING_SLUG=wedding-photography-discovery-call \
npm run smoke:perf
```

The smoke test verifies:

- Public booking page returns `200`.
- Warm public booking page stays under the configured threshold.
- Public booking page includes the Reese cache header.
- Unauthenticated Studio redirects to `/admin/login`.

## Worker Origin Guard

The custom domains are the intended entry points:

- `https://studio.bythereeses.com`
- `https://schedule.bythereeses.com`

The raw Worker origin should not be used as a public bypass once sensitive proposal, invoice, contract, and client data are active.

The app now supports an optional shared secret:

```bash
ORIGIN_PROXY_SECRET=...
```

When this secret is set on both the dynamic Worker and the Pages proxy, direct `*.workers.dev` requests without the matching `x-reese-origin-secret` header return `404`. The Pages proxy overwrites the header before proxying to the Worker.

Keep this value as a Cloudflare secret only. Do not commit it to code, Obsidian, or local notes.

## Deployment Checklist

1. Generate a long random `ORIGIN_PROXY_SECRET`.
2. Set it on the dynamic Worker.
3. Set it on the `studio-bythereeses` Pages project.
4. Deploy the Worker.
5. Deploy the Pages proxy.
6. Verify:

```bash
npm run smoke:perf
```

Then check that the raw Worker origin returns `404` while the custom domains still work.
