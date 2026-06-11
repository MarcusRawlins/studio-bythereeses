# Ops Stabilization Starter Checklist

Minimal mapping for photography CRM/scheduler stabilization work (baseline after `chore: capture current CRM baseline`). No feature changes. Source-of-truth, gates, and drills only. Work in this repo.

## Source of Truth
- Authoritative in-repo SOP: [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md) (layer hierarchy, canonical working copy, drift guard).
- Durable business/system context + current priorities: Obsidian (`/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `00 System/System Cleanup Command Center - 2026-05-21.md`).
- Implementation, deployment, and engineering details: this repo only.
- Canonical active repo: `/Volumes/reeseai-memory/code/reese-photography-crm`
- Archived (removed): `/Users/tyler-macmini/code/reese-photography-crm`, `/Users/tyler-macmini/Documents/studio-bythereeses`
- Backup artifacts (code mirror + exports + snaps): `/Volumes/reeseai-memory/backups/reese-photography-crm/{d1,sqlite,manifests,logs,reconciliations}`
- Before strategic/durable changes: cross-check Obsidian first.
- Drift guard (run before durable git work or cross-copy sync): `npm run check:source-drift` (`scripts/check-source-drift.mjs`). Reports primary + known local copies for origin URL, upstream tracking, ahead/behind, dirty worktree, branch/HEAD, and cross-copy HEAD/origin alignment. Non-zero exit on critical drift (HEAD/origin mismatch across present copies). Warnings only for dirty worktree, absent copies, and ahead/behind upstream.

## Deploy Gate
- Required before any `npm run deploy` or `opennextjs-cloudflare deploy`:
  - `npm run lint`
  - `npm run build`
  - `npm run backup:data` (valid CF token)
  - `npm run deploy:capture-versions` (snapshot Worker/Pages IDs + git HEAD)
  - `npm run check:source-drift` (enforced in `npm run deploy:preflight`)
  - `npm run deploy:preflight` (enforced in `npm run deploy`)
- Preflight (see `scripts/deploy-preflight.mjs` + `docs/deployment-live-testing.md`):
  - Requires `CLOUDFLARE_API_TOKEN`
  - Requires `src/proxy.ts`, `wrangler.jsonc`, `pages-proxy/_worker.js`
  - Rejects if `src/middleware.ts` present (conflicts with Next.js 16 proxy)
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
- Pre-deploy capture: `npm run deploy:capture-versions` (writes `.../manifests/latest-deploy-versions.json` + stamped copy; needs `CLOUDFLARE_API_TOKEN` for live Worker/Pages IDs, always records git HEAD/branch/dirty).
- Worker rollback helper: `npm run deploy:rollback -- --plan` (dry run) or `npm run deploy:rollback -- --yes` (executes `wrangler rollback` to prior captured Worker version). Shell wrapper: `scripts/rollback.sh`.
- Pages front door: still manual via Cloudflare dashboard (`studio-bythereeses` > Deployments > Rollback). No wrangler Pages rollback command.
- Git redeploy path (unchanged):
  1. `git checkout <prior-good-commit>` (or revert the bad change).
  2. Re-run full deploy gate + `npm run deploy` (and pages-proxy).
  3. Verify with `npm run smoke:production`.
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

## CRM Integration Stack (Slices 01–11)
- Current slice: `crm-slice-11-agent-access-docs` — agent/MCP operating reference in `docs/studio-agent-access.md`.
- Prior slices: ops docs, deploy capture/rollback, schema, lib, API, UI shell, proxy security, ops deploy gate.
- Slice 11 deliverables: MCP tool reference, agent API auth model, finance mutation approval guard, source-of-truth SOP links, deploy/smoke checklist, remaining live integration requirements, `scripts/studio-agent-access-docs.test.mjs`.

## Next Branch Plan (Stabilization)
- Baseline: `stabilization/ops-2026-06` from `main` @ `6199013`. CRM stack branches stack on that work without reverting unknown changes.
- Slice progress:
  - [x] 1. Create stabilization branch + land starter checklist.
  - [x] 2. Cross-link checklist from README, AGENTS.md, `docs/deployment-live-testing.md`, `docs/backups.md`.
  - [x] 3. Add version capture (`scripts/capture-deploy-versions.mjs`, `npm run deploy:capture-versions`) + rollback helper (`scripts/rollback-deploy.mjs`, `scripts/rollback.sh`, `npm run deploy:rollback`).
  - [x] 11. Agent/MCP access docs (`docs/studio-agent-access.md`) reconciled with finance approval guard + smoke surface.
  - [ ] 4. Expand with Obsidian priorities + `docs/superpowers/plans/2026-05-20-project-reliability-efficiency.md` items in scope.
  - [ ] 5. Add backup freshness + MCP tool surface assertions into deploy gate where cheap.
  - [ ] 6. Document token rotation drill + "who has the token" inventory (keychain + CF secrets + launchd).
  - [ ] 7. Run non-destructive verification (`lint`, `build`, `deploy:preflight` if token present, `deploy:capture-versions`, smoke against prod with token).
  - [ ] 8. PR back to main only after checklist items pass review + no feature deltas in stabilization slices.
- Do not deploy from stabilization work until explicit sign-off.
- Track via checkboxes in this doc + Obsidian.

## Quick Commands (for drill)
See package.json scripts, `docs/backups.md`, `docs/deployment-live-testing.md`, `docs/studio-agent-access.md`.

- Capture before deploy: `npm run deploy:capture-versions`
- Rollback plan: `npm run deploy:rollback -- --plan`
- Preflight+smoke loop: `npm run deploy:preflight && npm run smoke:production`
- Backup drill: `npm run backup:reconcile`
- Restore drill: `npm run db:restore-local:d1 -- --dry-run`
- Dev gate: `npm run dev:studio -- --check`
- Drift guard: `npm run check:source-drift`

This is the minimal starter patch. Expand only in the branch above. Update this file in place for refinements.