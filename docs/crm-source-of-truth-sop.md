# CRM Source of Truth SOP

Authoritative in-repo map for where decisions, code, backups, and agent access live. Cross-check Obsidian before strategic or durable changes; use this doc for engineering layout and working-copy rules.

## Layer Hierarchy

| Layer | Location | Owns |
| --- | --- | --- |
| Business priorities, client context, durable decisions | Obsidian: `/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` | What to build, safety rules, operating notes |
| Cross-project cleanup priorities | Obsidian: `/Users/tyler-macmini/Documents/Obsidian Vault/00 System/System Cleanup Command Center - 2026-05-21.md` | System-wide sequencing |
| Implementation, deployment, agent API | This repo | Code, migrations, deploy gates, MCP tools |
| Agent/MCP operating reference | [`studio-agent-access.md`](studio-agent-access.md) | Auth, tools, finance approval guard, smoke |
| Ops stabilization | [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md) | Deploy gate, rollback, backup/MCP drills |
| Production deploy targets | [`deployment-live-testing.md`](deployment-live-testing.md) | Domains, secrets, live-test checklist |
| Backup layout | [`backups.md`](backups.md) | Schedules, restore paths, launchd |

## Canonical Working Copy

- **Active repo:** `/Volumes/reeseai-memory/code/reese-photography-crm`
- **Git origin:** `https://github.com/MarcusRawlins/studio-bythereeses.git`
- **Archived (removed):** `/Users/tyler-macmini/code/reese-photography-crm`, `/Users/tyler-macmini/Documents/studio-bythereeses` — do not treat these paths as current working copies.

Run all git work, `npm run dev:studio`, deploy gates, and agent doc updates from the canonical `/Volumes` path.

## Backup and Mirror Surfaces

- **Code mirror target (daily backup):** `/Volumes/reeseai-memory/code/reese-photography-crm` (same path as canonical working copy; backup rsync is non-destructive)
- **Data backups:** `/Volumes/reeseai-memory/backups/reese-photography-crm/{d1,sqlite,manifests,logs,reconciliations}`
- **Planning docs backup:** `/Volumes/reeseai-memory/businesses/photography/crm`

Production database: Cloudflare D1 `studio-bythereeses`. Local SQLite at `data/local.db` is development-only.

## Drift Guard

Before durable git work or cross-copy sync:

```bash
npm run check:source-drift
```

`scripts/check-source-drift.mjs` reports origin URL, branch/HEAD, dirty worktree, and alignment across known copies. Non-zero exit on critical drift (HEAD or origin mismatch across present copies). Absent archived `/Users` copies are warnings only.

## Platform Status (Slices 01–11)

The stacked CRM integration branch (`crm-slice-11-agent-access-docs`) carries the full platform baseline. Implemented in repo and production:

- Admin Google OAuth (browser session) and Google Calendar adapter
- Proposals, contracts, invoices, payment schedules, Stripe Checkout
- Questionnaires (admin builder, portal responses, canonical source sync)
- Scheduler with Resend email confirmations
- MCP server (`POST /api/mcp`, 50+ tools) and REST agent API (`/api/agent/*`)
- Cloudflare production: D1, Worker, Pages proxy, `studio.bythereeses.com`, `schedule.bythereeses.com`

Remaining live-integration hardening (not missing code): see **Remaining Live Integration Requirements** in [`studio-agent-access.md`](studio-agent-access.md) — Tyler OAuth restriction audit, production secrets inventory, first live scheduler test, token rotation drill, deploy-gate backup/MCP assertions.

## Quick Commands

```bash
npm run check:source-drift
npm run dev:studio -- --check
npm run deploy:capture-versions
npm run deploy:preflight
npm run smoke:production
npm run backup:reconcile
```