# Reese Photography CRM

> Source-of-truth note: Obsidian holds durable business/system context and current priorities. This repo holds implementation, deployment, and engineering details. Before making strategic or durable changes, check `/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `/Users/tyler-macmini/Documents/Obsidian Vault/00 System/System Cleanup Command Center - 2026-05-21.md`.

Private, local-first CRM for Tyler Reese's photography business.

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
npm run dev
npm run lint
npm run build
npm run backup
```

Open `http://localhost:3000`.

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
