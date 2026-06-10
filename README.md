# Reese Photography CRM

> Source-of-truth note: Obsidian holds durable business/system context and current priorities. This repo holds implementation, deployment, and engineering details. Before making strategic or durable changes, check `/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `/Users/tyler-macmini/Documents/Obsidian Vault/00 System/System Cleanup Command Center - 2026-05-21.md`.

Private, local-first CRM for Tyler Reese's photography business.

## Ops Stabilization

Deploy gates, rollback/version capture, backup drills, and MCP scope: [`docs/ops-stabilization-checklist.md`](docs/ops-stabilization-checklist.md). Capture live Worker/Pages deployment IDs before risky deploys with `npm run deploy:capture-versions`.

## Locations

- Primary working copy: `/Users/tyler-macmini/code/reese-photography-crm`
- Local backup mirror: `/Volumes/reeseai-memory/code/reese-photography-crm`
- Planning docs backup: `/Volumes/reeseai-memory/businesses/photography/crm`

## Stack

- Next.js App Router + TypeScript
- Drizzle ORM
- Local SQLite for development
- Cloudflare D1 target for production
- Cloudflare R2 target for future PDFs and attachments

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

## MVP Status

Implemented:

- Admin dashboard shell
- Project list
- Project creation with primary client
- Project detail page
- D1-compatible local schema and migration
- Magic-link portal token generation
- `/p/[token]` portal login handoff
- `/portal` project-scoped client view
- 30-day remembered portal cookies
- Token revocation
- Activity logging
- Scheduler admin page
- Public booking links
- Local booking storage
- Optional Google Calendar free/busy and event creation adapter

Not yet implemented:

- Admin Google OAuth
- Proposals/contracts/invoices
- Questionnaires
- Email sending for scheduler confirmations
- MCP server
- Cloudflare production resources
