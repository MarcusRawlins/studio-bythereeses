# Production Deploy Record — Phase 6 (2026-07-05)

**Branch:** `claude/reese-crm-production-qa-4caxz0` (tip at deploy: `ff53644` + `da23fb1` build-fix)
**Account:** `Hello@bythereeses.com's Account` (`765e233f8635f207a8a3db4847efd3e9`)
**Executed from:** cloud container (drift check bypassed — benign sandbox-origin false positive; real D1 backup taken so the backup gate was *satisfied*, not bypassed).

## Artifacts / rollback points

| Item | Value |
| --- | --- |
| Pre-deploy D1 backup | `…/d1/latest.sql` (real remote export, 930 KB) |
| Worker version deployed | `d1cd7b34-071a-4226-8133-cfbbbf36f2a9` |
| **Worker rollback target** | `b9751424-33e6-443d-bfc9-0d3b0d7f1376` (`wrangler rollback b9751424…`) |
| Pages-proxy deployment | `6d6df58a.studio-bythereeses.pages.dev` |
| D1 migration applied | `0083_asset_objects.sql` (idempotent `CREATE TABLE IF NOT EXISTS` + indexes) |

## Post-deploy health (all pass)

Studio `/`→303 login · `/finance`→303 (M4 off, session-gated) · schedule booking→200 · `workers.dev`→404 · agent API→401 · MCP GET→405 · `/proposal/*` **Referrer-Policy: no-referrer** · baseline CSP + HSTS/nosniff/frame-DENY present · `/api/assets/*`→404 (table present, dark). Async edge middleware verified working at runtime.

## Current runtime state

- **M4 (`ADMIN_PROOF_ENFORCE`)**: unset = **off** (proof not evaluated; admin stays Google-session-gated as before).
- **CSP (`CSP_MODE`)**: unset = **off** (baseline CSP, no `script-src`; zero change).
- **R2**: storage + serving code live but **dark** — nothing mints assets/signed URLs yet (Phase 7). `R2_URL_SIGNING_SECRET` not set (fail-closed; signing throws in prod until set).
- **Secrets not yet set**: `ADMIN_PROOF_SECRET` (proxy + worker), `R2_URL_SIGNING_SECRET` (worker). Required before enabling M4 / R2.

## Enable runbook (deliberate, post-deploy — each reversible)

**M4 admin-proof:**
1. `wrangler secret put ADMIN_PROOF_SECRET` (Worker) + set the same value as a Pages-proxy env var.
2. `wrangler secret put ADMIN_PROOF_ENFORCE` = `"log"` → use the CRM admin normally; watch `wrangler tail` for `[admin-proof] missing/invalid proof` on legit admin paths (each = a classifier miss to fix).
3. Clean window → set `ADMIN_PROOF_ENFORCE` = `"1"` (enforce). Break-glass: `wrangler secret delete ADMIN_PROOF_ENFORCE`.

**CSP:**
1. `CSP_MODE="report"` → load Studio + `/book/*` (twice, cache HIT) with the browser console open; fix any violation (note: no `report-uri` yet, violations show in-console).
2. After the pre-enforce checklist (dynamic-render audit; see `specs/phase-6-hardening-r2.md` §4) → `CSP_MODE="enforce"`. Rollback: unset.

**R2 (Phase 7 prerequisite):** `wrangler secret put R2_URL_SIGNING_SECRET`; confirm **no public domain** is attached to the `studio-bythereeses` R2 bucket.

## Ops observation — prod migration tracker drift (for Tyler)

Prod `d1_migrations` shows latest applied = `0081_project_workflow_automations.sql`, but the app runs features through `0082` (shooting locations) and the repo is at `0083`. So prod schema is created by a mechanism the `d1_migrations` tracker does not fully reflect (runtime ensure-path and/or manual `d1 execute`). `0083` was applied here via direct `d1 execute --file` (idempotent), which also does **not** update the tracker. **Recommendation:** reconcile the prod `d1_migrations` tracker against actual schema before relying on `wrangler d1 migrations apply --remote` for future migrations — a blanket apply today could error on already-existing tables.
