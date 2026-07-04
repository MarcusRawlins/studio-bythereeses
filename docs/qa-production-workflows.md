# Production Workflow QA Audit

> **Superseded by [`qa-production-workflows-2026-07-04.md`](qa-production-workflows-2026-07-04.md)** (2026-07-04 QA + security pass, 172/172 tests, booking-hardening fixes). This 2026-07-03 record is retained as a historical audit; its "171/171" and "2026-07-03" figures reflect that date, not current state.

**Status:** ACHIEVED  
**Audit date:** 2026-07-03  
**Auditor:** Brunel (Codex execution specialist)  
**Worktree:** `/tmp/brunel-worktrees/reese-qa-audit-20260703`  
**Branch:** `brunel/qa-production-workflows-audit`  
**Base commit:** `45173c6` (`chore: harden crm security deployment`)  
**Canonical repo:** `/Volumes/reeseai-memory/04_Code/reese-photography-crm`

Related docs: [`deployment-live-testing.md`](deployment-live-testing.md), [`route-access-audit.md`](route-access-audit.md), [`studio-agent-access.md`](studio-agent-access.md), [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md), [`performance-and-origin-hardening.md`](performance-and-origin-hardening.md).

## Executive Summary

Production is **healthy** for the automated non-destructive checks in scope. All three required verifiers passed after installing dependencies in the isolated worktree (`npm install` was required because worktrees do not share `node_modules`).

| Verifier | Result | Notes |
| --- | --- | --- |
| `npm run smoke:production` | PASS | 165 projects, 164 clients, 0 data-health issues, 53 MCP tools |
| `npm run smoke:perf` | PASS | Warm booking 50ms (HIT), Studio redirect 78ms |
| `npm run test` | PASS | 171/171 tests |

**Bottom line:** Infrastructure gates (host split, origin blocking, agent/MCP surface, data health, performance SLOs) are verified. Client-facing mutation workflows (live booking, Stripe checkout, proposal acceptance, Resend/Google Calendar) remain **documented manual QA** with open checklist items in [`studio-agent-access.md`](studio-agent-access.md) and [`deployment-live-testing.md`](deployment-live-testing.md).

## Production Targets

| Surface | URL | Role |
| --- | --- | --- |
| Studio (admin) | `https://studio.bythereeses.com` | Private CRM; Google session via Pages proxy |
| Schedule (public) | `https://schedule.bythereeses.com` | Public booking + scheduler APIs |
| Pages front door | `studio-bythereeses.pages.dev` | External DNS CNAME target; proxies to Worker |
| Raw Worker origin | `reese-photography-crm.solitary-flower-c3ab.workers.dev` | Blocked for admin/API (404 without origin secret) |
| D1 | `studio-bythereeses` | Production relational data |
| R2 | `studio-bythereeses` | File storage |

## Workflow Coverage Matrix

Legend: **Live** = production smoke/perf hit live URLs; **Unit** = repo test suite; **Manual** = documented but not automated in this audit; **Gap** = no automated or recent live verification.

### 1. Access Control and Front Door

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Studio unauthenticated redirect -> `/admin/login` | smoke:production, smoke:perf | `pages-proxy/proxy-admin-auth.test.ts`, `src/middleware.test.ts` | - | Covered |
| Schedule `/projects` redirect -> public booking | smoke:production | `pages-proxy/proxy-security.test.ts` | - | Covered |
| Studio `/book/*` redirect -> schedule host | smoke:production | `pages-proxy/proxy-security.test.ts` | - | Covered |
| Direct `workers.dev` admin/API blocked (404) | smoke:production | `src/lib/origin-guard.test.ts`, `src/middleware.test.ts` | - | Covered |
| Admin Google OAuth callback (email from userinfo, not id_token) | - | `pages-proxy/proxy-admin-auth.test.ts` | OAuth restricted to Tyler account | Unit covered; live OAuth unchecked |
| Agent `/api/agent/*` bearer auth | smoke:production | 30+ `src/app/api/agent/**/route.test.ts` | - | Covered |
| MCP `POST /api/mcp` tools/list surface | smoke:production | `src/app/api/mcp/route.test.ts`, `src/lib/studio-mcp.test.ts` | - | Covered |
| Finance mutation approval guard (agents blocked) | smoke:production (read) | `src/lib/studio-mcp.test.ts`, agent invoice/payment route tests | Tyler approval for writes | Covered |

### 2. Studio Admin CRM (Browser)

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Dashboard / home | - | `src/app/page.test.tsx` | Browser session E2E | Unit only |
| Projects list / detail / edit | - | `src/app/projects/**`, `src/lib/project-*.test.ts` | Browser E2E | Unit only |
| Clients list / detail / merge | - | `src/app/clients/**`, `src/lib/client-*.test.ts` | Browser E2E | Unit only |
| Finance / invoices / expenses | - | `src/app/finance/page.test.tsx`, finance API + lib tests | Browser E2E | Unit only |
| Proposals (admin) | - | `src/app/proposals/**`, `src/lib/proposal-*.test.ts` | Browser E2E | Unit only |
| Questionnaires (admin) | - | questionnaire lib + API tests | Browser E2E | Unit only |
| Scheduler admin / bookings | - | `src/app/scheduler/bookings/[id]/page.test.tsx` | Browser E2E | Unit only |
| Settings / templates / shooting locations | - | `src/app/templates/page.test.tsx`, lib tests | Browser E2E | Unit only |
| Data health page | - | `src/app/data-health/page.test.tsx`, `src/lib/data-health.test.ts` | - | Unit + live agent API |
| Activity / agenda / inbox | - | page + lib tests | - | Unit only |
| Admin POST forms through Pages proxy | - | proxy security tests | Form submission E2E | **Gap** |

### 3. Public Scheduler

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Schedule root redirect -> default booking slug | smoke:perf | `pages-proxy/proxy-security.test.ts` | - | Covered |
| Public booking page load + cache (60s) | smoke:perf | - | - | Covered |
| Booking mutation (`POST /api/scheduler/bookings`) | - | `src/lib/scheduler-*.test.ts`, cron/reminder tests | First live scheduler test | **Gap** |
| Google Calendar event creation | - | `src/lib/project-event-calendar.test.ts` | First live scheduler test | **Gap** |
| Resend confirmation + admin notification | - | - | First live scheduler test | **Gap** |
| Project-scoped booking link | - | `src/lib/scheduler-link-canon.test.ts` | deployment-live-testing step 9 | **Gap** |
| `/book/[slug]/manage` reschedule | - | - | Manual | **Gap** |

### 4. Client Token Surfaces

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Portal session (`/portal`) | - | `src/app/portal/page.test.tsx`, `src/lib/portal-*.test.ts` | Live portal cookie flow | Unit only |
| Proposal token view (`/proposal/:token`) | - | `src/lib/proposal-client-experience.test.ts` | Live acceptance | **Gap** |
| Proposal accept API | - | - | Live Stripe/contract path | **Gap** |
| Short link `/p/:token` | - | `src/lib/proposal-link-canon.test.ts` | Manual | Unit only |
| Public questionnaire response | - | `src/app/api/questionnaires/[id]/responses/route.test.ts` | Live public submit | Unit only |

### 5. Payments and Webhooks

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Stripe webhook signature verification | - | `src/app/api/stripe/webhook/route.test.ts` | Live webhook delivery | Unit only |
| Invoice Checkout Session (agent creates link) | - | checkout route tests | Live Stripe hosted checkout | Unit only |
| Scheduler booking payment (agent) | - | `src/app/api/agent/scheduler/bookings/[id]/payment/route.test.ts` | Tyler approval for mutations | Guard covered |
| Finance reconciliation reads | smoke:production | finance report route + lib tests | - | Covered |

### 6. Agent / MCP Automation

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Project search + context | smoke:production (search) | agent project/context route tests | - | Covered |
| Data health summary | smoke:production | `src/app/api/agent/data-health/route.test.ts` | - | Covered |
| Agent task loop (list/create/claim/run) | smoke:production (list) | `src/lib/agent-tasks.test.ts`, task route tests | Full task lifecycle in prod | Partial live |
| Project workflow automations | smoke:production (list steps) | `src/lib/project-workflow-*.test.ts` | Queue/run in prod | Partial live |
| Timeline draft from agent task | - | `src/lib/timeline-draft.test.ts`, route tests | Manual | Unit only |
| Finance report (needs_reconciliation) | smoke:production | `src/app/api/agent/finance/report/route.test.ts` | - | Covered |

### 7. Ops / Deploy / Backup

| Workflow | Live | Unit | Manual | Status |
| --- | --- | --- | --- | --- |
| Deploy preflight gate | - | `scripts/deploy-preflight.test.mjs` | Requires `CLOUDFLARE_API_TOKEN` | Unit only |
| Deploy version capture / rollback plan | - | `scripts/capture-deploy-versions.test.mjs`, `scripts/rollback-deploy.test.mjs` | Rollback execution | Unit only |
| Source drift guard | - | `scripts/check-source-drift.test.mjs` | Cross-copy sync | Unit only |
| Backup daily / reconcile | - | - | launchd + `npm run backup:reconcile` | **Gap** |
| D1 restore local drill | - | - | `npm run db:restore-local:d1 -- --dry-run` | **Gap** |
| Token rotation drill | - | - | ops checklist item 6 | **Gap** |

## Live Smoke Results (2026-07-03)

### `npm run smoke:production`

```json
{
  "projectCount": 165,
  "clientCount": 164,
  "dataHealthIssueCount": 0,
  "agentProjectRows": 5,
  "agentTaskRows": 2,
  "workflowAvailableStepCount": 16,
  "financeReconciliationCount": 0,
  "mcpTaskToolsPresent": true,
  "mcpWorkflowToolsPresent": true,
  "mcpToolCount": 53
}
```

Checks passed: Studio/Schedule host split, `workers.dev` 404, agent REST (projects, data-health, finance, tasks, workflows), MCP tools/list (finance + task loop + workflow automation).

### `npm run smoke:perf`

| Check | Status | Time | Cache |
| --- | --- | --- | --- |
| Schedule root redirect (303) | PASS | 164ms | n/a |
| Booking cold/warmup (200) | PASS | 1373ms | MISS |
| Booking warm (200) | PASS | 50ms | HIT |
| Studio auth redirect (303 -> login) | PASS | 78ms | n/a |

Thresholds: warm booking <=750ms, Studio redirect <=500ms.

### `npm run test`

```text
171/171 tests passed.
```

Includes: script tests, pages-proxy tests, agent API route tests, admin API route tests, admin page tests, and lib/component/db tests.

## Open Risks

1. **First live scheduler test not completed** - booking mutation, Google Calendar sync, and Resend email remain unchecked in production per [`deployment-live-testing.md`](deployment-live-testing.md) and [`studio-agent-access.md`](studio-agent-access.md).
2. **No live mutation smokes** - production smoke is read-only HEAD/GET; a regression in `POST /api/scheduler/bookings`, Stripe webhooks, or proposal acceptance would not be caught automatically.
3. **Shared agent bearer token** - single `STUDIO_AGENT_API_TOKEN` for all agent/MCP access; rotation drill and inventory undocumented.
4. **Browser admin E2E absent** - Google session, admin POST forms, and multi-page CRM flows rely on unit tests + manual use; no Playwright/Cypress suite.
5. **Public booking page untested in unit suite** - no `src/app/book/**` tests; only live perf smoke and proxy security tests.
6. **Proposal token pages untested** - `/proposal/:token` and accept API lack dedicated page/route tests beyond lib canon tests.
7. **Worktree test bootstrap** - fresh worktrees require `npm install` before `npm run test`; `run-tests.mjs` can throw if `stdout` is undefined when a test fails without deps.
8. **Verifier scope** - this audit did not run `lint`, `build`, or `deploy:preflight`; those should remain part of release gates.

## Recommended Next QA Actions

1. **Complete First Live Scheduler Test** - follow [`deployment-live-testing.md`](deployment-live-testing.md) steps 1-9 with a Tyler-owned test contact; record outcome and date in this doc.
2. **Add non-destructive scheduler read smoke** - extend `smoke:production` to `GET` booking page HTML sanity for a second event type slug if available.
3. **Document token inventory + rotation drill** - list keychain services, Cloudflare secrets, and launchd jobs.
4. **Quarterly backup/restore drill** - `npm run backup:reconcile` + `npm run db:restore-local:d1 -- --dry-run`; log result to backups manifest.
5. **Consider staging-safe mutation smoke** - optional test booking with a dedicated test meeting type + immediate cancel, behind env flag.
6. **Browser smoke for admin login redirect chain** - lightweight check that `/api/google/auth` returns 307 to Google.
7. **Harden worktree CI note** - document that worktree clones need `npm install` before test/smoke scripts; optionally fix `run-tests.mjs` null-safe `stdout`/`stderr` handling.

## Audit Method

1. Created isolated worktree at `/tmp/brunel-worktrees/reese-qa-audit-20260703` on branch `brunel/qa-production-workflows-audit`.
2. Inspected routes (`src/app/**`), smoke scripts, route-access audit, deployment docs, and test inventory.
3. Ran verifiers against live production (non-mutating): `smoke:production`, `smoke:perf`, `test`.
4. Mapped workflow coverage and cross-referenced open items from ops/studio-agent checklists.
5. Wrote this report (report-only; no production mutations, no deploy, no secrets changed).

## Changed Files

| File | Change |
| --- | --- |
| `docs/qa-production-workflows.md` | Created (this audit report) |

No scripts or tests were modified by the QA audit; gaps did not warrant code changes within the report-only preference.

## Verifier Command Log

```bash
# Worktree
git worktree add /tmp/brunel-worktrees/reese-qa-audit-20260703 -b brunel/qa-production-workflows-audit

# Attempt 1: test failed (missing node_modules in worktree)
cd /tmp/brunel-worktrees/reese-qa-audit-20260703 && npm run test  # FAIL

# Remediation
npm install

# Attempt 2: all verifiers pass
npm run smoke:production  # PASS
npm run smoke:perf        # PASS
npm run test              # PASS (171/171)
```
