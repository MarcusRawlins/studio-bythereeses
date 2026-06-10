# Ops Stabilization Starter Checklist

Minimal mapping for photography CRM/scheduler stabilization work (baseline after `chore: capture current CRM baseline`). No feature changes. Source-of-truth, gates, and drills only. Work in this repo.

## Source of Truth
- Durable business/system context + current priorities: Obsidian (`/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `00 System/System Cleanup Command Center - 2026-05-21.md`).
- Implementation, deployment, and engineering details: this repo only.
- Working copies (non-destructive mirror):
  - Primary: `/Users/tyler-macmini/code/reese-photography-crm`
  - Mirror (current): `/Volumes/reeseai-memory/code/reese-photography-crm`
- Backup artifacts (code mirror + exports + snaps): `/Volumes/reeseai-memory/backups/reese-photography-crm/{d1,sqlite,manifests,logs,reconciliations}`
- Before strategic/durable changes: cross-check Obsidian first.

## Deploy Gate
- Required before any `npm run deploy` or `opennextjs-cloudflare deploy`:
  - `npm run lint`
  - `npm run build`
  - `npm run backup:data` (valid CF token)
  - `npm run deploy:preflight` (enforced in `npm run deploy`)
- Preflight (see `scripts/deploy-preflight.mjs` + `docs/deployment-live-testing.md`):
  - Requires `CLOUDFLARE_API_TOKEN`
  - Requires `src/middleware.ts`, `wrangler.jsonc`, `pages-proxy/_worker.js`
  - Rejects if `src/proxy.ts` present (legacy)
  - Warns on stale Alex/Tyler branding at studio/schedule domains
- Full flow (from package.json + deployment doc):
  ```
  npm run deploy:preflight
  npm run preview   # optional
  npm run deploy
  npm run deploy:pages-proxy
  npm run smoke:production
  ```
- Smoke (`npm run smoke:production`, reads agent token from shell or keychain `reese-studio-agent-api-token`):
  - Validates studio/schedule host split + direct worker 404
  - Project/client counts >=100, data-health issueCount === 0
  - Agent REST + MCP tool surface (finance, task loop, workflow)
- Do not deploy on dirty baseline without explicit note.

## Rollback
- No automated rollback script or gate yet (search confirmed zero mentions in docs/scripts).
- Current manual path:
  1. Note current Worker/Pages version IDs (Wrangler dashboard or `wrangler deployments list`).
  2. `git checkout <prior-good-commit>` (or revert the bad change).
  3. Re-run full deploy gate + `npm run deploy` (and pages-proxy).
  4. Verify with `npm run smoke:production`.
- Alternative (no git change): Cloudflare dashboard "Rollback" for the Worker + Pages project to a prior deployment.
- Future: add explicit pre-deploy version capture + `scripts/rollback.sh` candidate in stabilization branch.
- Always keep local + mirror at known-good baseline before risky deploys.

## Backup / Restore Drill
- Schedule (launchd on primary path):
  - Daily 02:15: `npm run backup:daily` (or `backup` alias) → non-`--delete` rsync-style code mirror + D1 SQL export + local SQLite snap + manifest + logs.
  - Weekly (Mon 03:15): `npm run backup:reconcile`
  - Install/refresh: `npm run backup:install-launchd`
- Manual: `npm run backup:daily`, `npm run backup:reconcile`, `npm run backup:data`
- Restore local dev from latest D1 (see `docs/backups.md` + `scripts/restore-local-from-d1-backup.mjs`):
  ```
  npm run db:restore-local:d1 -- --dry-run
  npm run db:restore-local:d1 -- --yes
  ```
  - Imports `.../d1/latest.sql`, validates Studio tables + project/client rows present.
  - Snapshots `local-before-d1-restore-*.db` first.
  - Runs `npm run db:migrate` after replace.
  - Writes JSON report to backups logs.
- Specific source: `--source /path/to/foo.sql --database /tmp/test.db --yes`
- Verify drift: `npm run dev:studio -- --check` (fails if only seed data when D1 backup has real projects).
- Cloudflare token for D1 export: prefer macOS keychain `reese-crm-cloudflare-api-token` (never commit; see backups.md for env/file fallbacks).
- Reconciliation expectations: mirror HEAD match, recent D1 export (<36h or warn), manifests, etc. Non-zero on critical fail.

## MCP / Token Scopes
- Token secret: `STUDIO_AGENT_API_TOKEN` (never in repo/Obsidian; keychain service `reese-studio-agent-api-token` or `CLOUDFLARE_API_TOKEN` style).
- Protected surfaces (pass-through Pages front door, no Google OAuth for agents):
  - `POST /api/mcp` (streamable HTTP JSON-RPC; 405 on GET)
  - `GET/POST /api/agent/*` (REST equivalent for some tools)
- Auth: `Authorization: Bearer <STUDIO_AGENT_API_TOKEN>` → 401 on bad/missing, 503 if token unset in runtime.
- Principle (from `docs/studio-agent-access.md` + roadmap + smoke): narrow, auditable actions only. Prefer read + source-linked writes. All actions hit canonical paths + activity logs.
- MCP tools/list surface (validated in smoke):
  - Finance: `studio_get_finance_report`
  - Agent task loop: `studio_create_agent_task`, `studio_claim_agent_task`, `studio_start_agent_task_run`, `studio_list_agent_tasks`, `studio_update_agent_task`, `studio_submit_workflow_task_result`, `studio_run_workflow_draft_task`
  - Workflow: `studio_list_project_workflow_automations`, `studio_setup_project_workflow_automation`, `studio_queue_project_workflow_steps`
  - Plus: search, get context (project/client/agenda/data-health/settings), create/update for projects/clients/events/locations/sources/proposals/invoices/payments/expenses/comms/timeline/questionnaires/portals, merge clients, etc.
- Full enumerated list + example payloads: `docs/studio-agent-access.md`
- Smoke also asserts studio redirect behavior, worker origin blocking, and live counts/health.
- Scope guard: agent paths intentionally bypass browser Google session; browser admin pages remain protected.

## Next Branch Plan (Stabilization)
- Current state: `main` @ `6199013 chore: capture current CRM baseline`. Many untracked changes present (new agent routes, migrations 0010+, tests, data-health, scheduler enhancements) — do not revert/reset/delete unknown uncommitted.
- Starter stabilization branch (next exact):
  1. `git checkout -b stabilization/ops-2026-05` (or similar) from current main.
  2. Land this checklist (and cross-link from README + AGENTS.md + deployment/backups docs).
  3. Expand with Obsidian priorities (read outside this session) + relevant items from `docs/superpowers/plans/2026-05-20-project-reliability-efficiency.md` (reliability plan uses its own sub-skill discipline; keep gates/rollback/backup/MCP in scope).
  4. Add concrete rollback procedure + version capture to preflight/smoke or new script (no code yet).
  5. Add backup freshness + MCP tool surface assertions into deploy gate where cheap.
  6. Document token rotation drill + "who has the token" inventory (keychain + CF secrets + launchd).
  7. Run only non-destructive local verification (`lint`, `build`, `deploy:preflight` if token present locally, smoke against prod with token).
  8. PR back to main only after checklist items pass review + no feature deltas in this slice.
- Do not deploy from stabilization work until explicit sign-off.
- Track via checkboxes in this doc + Obsidian.

## Quick Commands (for drill)
See package.json scripts, `docs/backups.md`, `docs/deployment-live-testing.md`, `docs/studio-agent-access.md`.

- Preflight+smoke loop: `npm run deploy:preflight && npm run smoke:production`
- Backup drill: `npm run backup:reconcile`
- Restore drill: `npm run db:restore-local:d1 -- --dry-run`
- Dev gate: `npm run dev:studio -- --check`

This is the minimal starter patch. Expand only in the branch above. Update this file in place for refinements.