# Reese Photography CRM

Private, local-first CRM for Tyler Reese's photography business.

## Authoritative Docs

| Topic | Doc |
| --- | --- |
| Source-of-truth hierarchy, working copy, drift guard | [`docs/crm-source-of-truth-sop.md`](docs/crm-source-of-truth-sop.md) |
| Agent/MCP auth, tools, finance guard, smoke | [`docs/studio-agent-access.md`](docs/studio-agent-access.md) |
| Deploy gate, rollback, backup drills | [`docs/ops-stabilization-checklist.md`](docs/ops-stabilization-checklist.md) |

Obsidian holds durable business context and current priorities. Before strategic changes, cross-check `/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `/Users/tyler-macmini/Documents/Obsidian Vault/00 System/System Cleanup Command Center - 2026-05-21.md`.

## Locations

- **Canonical active repo:** `/Volumes/reeseai-memory/04_Code/reese-photography-crm`
- **Data backups:** `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm`
- **Planning docs backup:** `/Volumes/reeseai-memory/01_Businesses/photography/crm`
- **Archived (removed):** `/Users/tyler-macmini/code/reese-photography-crm` — do not use as a working copy

Run `npm run check:source-drift` before durable git or cross-copy work. Details: [`docs/crm-source-of-truth-sop.md`](docs/crm-source-of-truth-sop.md).

## Stack

- Next.js App Router + TypeScript
- Drizzle ORM
- Local SQLite for development
- Cloudflare D1 in production
- Cloudflare R2 for PDFs and attachments

## Local Commands

```bash
npm run db:migrate
npm run db:seed
npm run db:restore-local:d1 -- --dry-run
npm run dev:studio
npm run lint
npm run build
npm run backup
```

Open `http://localhost:3000`.

`npm run dev:studio` checks that port `3000` is not serving another repo and that the local database has the expected Studio project/client data before it starts Next. For a one-off preflight without starting the server:

```bash
npm run dev:studio -- --check
```

If local development only shows seed projects, restore from the latest D1 backup with:

```bash
npm run db:restore-local:d1 -- --yes
```

## Google Calendar Setup

Copy `.env.example` to `.env.local`, add Google OAuth credentials, then visit:

```bash
http://localhost:3000/api/google/auth
```

The callback prints a `GOOGLE_REFRESH_TOKEN` to add to `.env.local`. Restart `npm run dev` after adding it.

## Platform Status

Slices 01–11 deliver the full CRM platform in this repo and in production (`studio.bythereeses.com`, `schedule.bythereeses.com`). Core surfaces are implemented:

- Admin dashboard, projects, clients, scheduler, portal
- Admin Google OAuth and Google Calendar integration
- Proposals, contracts, invoices, payment schedules, Stripe Checkout
- Questionnaires (admin + portal responses)
- Resend email for scheduler confirmations
- MCP server (`POST /api/mcp`) and REST agent API (`/api/agent/*`)
- Cloudflare D1, Worker, Pages proxy, custom domains

Remaining work is live-integration hardening, not missing platform code — see **Remaining Live Integration Requirements** in [`docs/studio-agent-access.md`](docs/studio-agent-access.md). Deploy gates, rollback, and smoke: [`docs/ops-stabilization-checklist.md`](docs/ops-stabilization-checklist.md). Capture live Worker/Pages deployment IDs before risky deploys with `npm run deploy:capture-versions`.