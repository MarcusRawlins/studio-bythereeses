# Ops Stabilization Starter Checklist

Minimal mapping for photography CRM/scheduler stabilization work (baseline after `chore: capture current CRM baseline`). No feature changes. Source-of-truth, gates, and drills only. Work in this repo.

## Source of Truth
- Authoritative in-repo SOP: [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md) (layer hierarchy, canonical working copy, drift guard).
- Durable business/system context + current priorities: Obsidian (`/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` and `00 System/System Cleanup Command Center - 2026-05-21.md`).
- Implementation, deployment, and engineering details: this repo only.
- Canonical active repo: `/Volumes/reeseai-memory/04_Code/reese-photography-crm`
- Archived (removed): `/Users/tyler-macmini/code/reese-photography-crm`, `/Users/tyler-macmini/Documents/studio-bythereeses`
- Backup artifacts (code mirror + exports + snaps): `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/{d1,sqlite,manifests,logs,reconciliations}`
- Before strategic/durable changes: cross-check Obsidian first.
- Drift guard (run before durable git work or cross-copy sync): `npm run check:source-drift` (`scripts/check-source-drift.mjs`). Reports primary + known local copies for origin URL, upstream tracking, ahead/behind, dirty worktree, branch/HEAD, and cross-copy HEAD/origin alignment. Non-zero exit on critical drift (HEAD/origin mismatch across present copies). Warnings only for dirty worktree, absent copies, and ahead/behind upstream.

## Current Production Baseline
- 2026-06-24: Production deploy completed from `main` after `0082_shooting_locations`.
- Cloudflare account verified: `hello@bythereeses.com` / account `765e233f8635f207a8a3db4847efd3e9`.
- Local keychain service for deploy token: `reese-crm-cloudflare-api-token`.
- Runtime fix: keep origin guard in `src/middleware.ts`; do not reintroduce `src/proxy.ts` until OpenNext Cloudflare supports Next.js edge proxy for this target.
- Production smoke after deploy: 165 projects, 164 clients, 0 data-health issues, 53 MCP tools, required task/workflow MCP tools present.
- 2026-06-24 stabilization verification: `npm test` 168/168, `npm run lint`, `npm run build`, `npm run deploy:preflight`, `npm run deploy:capture-versions`, and `npm run smoke:production` passed.
- 2026-06-24 cleanup: Pages proxy login HTML no longer references the old Alex/Tyler logo; `npm run deploy:preflight` now passes without stale-branding warnings.

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
  - Requires `src/middleware.ts`, `wrangler.jsonc`, `pages-proxy/_worker.js`
  - Rejects if `src/proxy.ts` present (Next.js 16 proxy runs on Node.js, which OpenNext Cloudflare cannot deploy)
  - Requires a non-empty fresh D1 export at `/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/d1/latest.sql` (<=36h old)
  - Checks the MCP source still contains the finance, durable task-loop, and project workflow tool names asserted by production smoke
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

### Quarterly Restore-Verification Drill (`npm run drill:restore`)
Evidence-producing rehearsal that the latest D1 backup SQL actually restores into a usable database — not just that the manual `db:restore-local:d1` commands *can* be run. Cadence: quarterly, or immediately after any backup-pipeline change (`scripts/backup.mjs`, `scripts/reconcile-backups.mjs`, migration additions).

1. Confirm backup freshness first (do not duplicate the check — it already runs in `deploy:preflight`): the D1 export at `.../d1/latest.sql` must be `<=36h` old. If stale, run `npm run backup:data` (or wait for the nightly `npm run backup:daily`) before drilling.
2. Run the drill against a throwaway database — never `data/local.db`, never a remote/production database:
   ```bash
   npm run drill:restore
   ```
   This wraps `scripts/restore-local-from-d1-backup.mjs` (`scripts/restore-verify-d1.mjs`), restoring into `/tmp/d1-restore-drill.db` by default. It asserts `projects`/`clients` row counts are present and above threshold (override with `--min-projects` / `--min-clients` for a stricter quarterly baseline pinned to the latest `smoke:production` counts) and that key Studio tables (`projects`, `clients`, `scheduler_bookings`, `invoices`, `proposals`, `activity_logs`) exist in the restored database. Exits non-zero on any failure.
3. Confirm the stamped JSON report was written to `.../logs/restore-verify-d1-<timestamp>.json` and that `ok: true`.
4. Record pass/date in this checklist (below) and in the Obsidian source-of-truth note (`Reese Photography CRM - Source of Truth and Backups.md`).
5. If the drill fails: do not treat the backup pipeline as trustworthy. Investigate `scripts/backup.mjs` / the D1 export step before relying on it for a real recovery.

**Drill log:**
- (none recorded yet — run `npm run drill:restore` and add an entry here: `YYYY-MM-DD: pass, projects=N, clients=N`)

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
  - [x] 5. Add backup freshness + MCP tool surface assertions into deploy gate where cheap.
  - [x] 6. Document token rotation drill + "who has the token" inventory (keychain + CF secrets + launchd) — see `docs/studio-agent-access.md` "STUDIO_AGENT_API_TOKEN Rotation Runbook" and "Who Has Access — Credential Inventory". Restore-verification drill (`scripts/restore-verify-d1.mjs`, `npm run drill:restore`) landed alongside as the companion ops-drill item (phase-6-hardening-r2.md §5).
  - [x] 7. Run non-destructive verification (`lint`, `build`, `deploy:preflight` if token present, `deploy:capture-versions`, smoke against prod with token).
  - [ ] 8. PR back to main only after checklist items pass review + no feature deltas in stabilization slices.
- Do not deploy from stabilization work until explicit sign-off.
- Track via checkboxes in this doc + Obsidian.

## Quick Commands (for drill)
See package.json scripts, `docs/backups.md`, `docs/deployment-live-testing.md`, `docs/studio-agent-access.md`.

- Capture before deploy: `npm run deploy:capture-versions`
- Rollback plan: `npm run deploy:rollback -- --plan`
- CI/dev gate: `npm test && npm run lint && npm run build`
- Preflight+smoke loop: `npm run deploy:preflight && npm run smoke:production`
- Backup drill: `npm run backup:reconcile`
- Restore drill (manual, local dev): `npm run db:restore-local:d1 -- --dry-run`
- Restore-verification drill (throwaway db, quarterly evidence): `npm run drill:restore`
- Dev gate: `npm run dev:studio -- --check`
- Drift guard: `npm run check:source-drift`

This is the minimal starter patch. Expand only in the branch above. Update this file in place for refinements.
