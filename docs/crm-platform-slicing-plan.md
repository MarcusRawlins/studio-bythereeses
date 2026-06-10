# CRM Platform Baseline — Slicing Plan

Turn the monolithic `crm-platform-baseline` diff into reviewable stacked branches/PRs.

## Scope

| Item | Value |
|------|-------|
| Parent baseline | `6199013` (`chore: capture current CRM baseline`) |
| Integration branch | `crm-platform-baseline` @ `042b83d` |
| Diff size | 401 files, +58,150 / −928 lines |
| Commits on branch | 4 (ops docs → deploy capture → platform baseline → proxy fix) |

**Strategy:** Branch each slice from the merge base of the prior slice (stacked PRs). Keep `crm-platform-baseline` as the known-good integration reference; do not delete until all slices are merged and `npm run lint && npm run build` pass on `main`.

**Extraction:** Prefer `git cherry-pick <commit>` for slices 1–2 and 12; use path-scoped `git checkout crm-platform-baseline -- <paths>` for ce12cf6 domains.

---

## Branch order (merge sequentially)

### 1. `crm-slice-01-ops-docs`

**Source commit:** `9b22943`

| Area | Paths |
|------|-------|
| Ops checklist | `docs/ops-stabilization-checklist.md` |

**Verify:** Docs-only — no build gate required.

**Merge risks:** None.

---

### 2. `crm-slice-02-deploy-capture-rollback`

**Source commit:** `21d3904`

| Area | Paths |
|------|-------|
| Deploy manifests | `scripts/capture-deploy-versions.mjs`, `scripts/capture-deploy-versions.test.mjs` |
| Rollback | `scripts/rollback-deploy.mjs`, `scripts/rollback-deploy.test.mjs`, `scripts/rollback.sh` |
| Docs / pointers | `docs/ops-stabilization-checklist.md` (delta), `docs/backups.md`, `docs/deployment-live-testing.md`, `README.md`, `AGENTS.md` |
| Scripts registry | `package.json` (`deploy:capture-versions`, `deploy:rollback` only) |

**Verify:**
```bash
node scripts/capture-deploy-versions.test.mjs
node scripts/rollback-deploy.test.mjs
```

**Merge risks:** Partial `package.json` — later slices add more scripts; resolve additively.

---

### 3. `crm-slice-03-schema-foundation`

**From:** `ce12cf6` (tables + indexes, no canon triggers)

| Area | Paths |
|------|-------|
| Migrations | `migrations/0010_*` … `migrations/0025_*` |
| DB layer | `src/db/schema.ts`, `src/db/client.ts`, `migrations/0000_initial.sql` (delta) |
| Repo hygiene | `.gitignore` |

**Verify:**
```bash
npm run db:migrate
npm run lint
npm run build
```

**Merge risks:** `schema.ts` / `client.ts` are shared spines — every later slice may touch them; keep this PR focused on additive tables/columns only.

---

### 4. `crm-slice-04-schema-integrity`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Uniqueness / guards | `migrations/0026_*` … `migrations/0051_*` |
| Canon triggers | `migrations/0052_*` … `migrations/0074_*` |
| Late schema | `migrations/0075_*` … `migrations/0081_*` |
| Canon test suite | `src/db/studio-canon.test.ts` |

**Verify:**
```bash
npm run db:migrate
tsx src/db/studio-canon.test.ts
npm run lint && npm run build
```

**Merge risks:** Large SQL-only PR (~65 migrations). Canon triggers are ordering-sensitive — do not reorder filenames. Expect long review; run full canon test locally before merge.

---

### 5. `crm-slice-05-lib-payments-bookkeeping`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Ledger / Stripe | `src/lib/payment-ledger*.ts`, `src/lib/stripe-checkout.ts`, `src/lib/invoice-balances.ts`, `src/lib/invoice-fees*.ts`, `src/lib/invoice-canon*.ts`, `src/lib/revenue-payment-canon*.ts` |
| Bookkeeping | `src/lib/bookkeeping*.ts`, `src/lib/project-finance*.ts`, `src/lib/agent-finance.ts`, `src/lib/agent-payment*.ts`, `src/lib/agent-invoice*.ts`, `src/lib/invoice-reminders*.ts`, `src/lib/agent-invoice-reminder*.ts` |
| Scheduler payments | `src/lib/scheduler-payment*.ts`, `src/lib/scheduler-link-canon*.ts` |
| Sales/CRM deltas | `src/lib/sales.ts`, `src/lib/crm.ts` (payment-related hunks only — expect overlap) |

**Verify:**
```bash
tsx src/lib/payment-ledger.test.ts
tsx src/lib/bookkeeping.test.ts
tsx src/lib/invoice-fees.test.ts
tsx src/lib/invoice-canon.test.ts
tsx src/lib/project-finance.test.ts
tsx src/lib/scheduler-payment.test.ts
npm run lint && npm run build
```

**Merge risks:** Heavy overlap in `sales.ts` / `crm.ts` monoliths; may need to include whole-file replacements from baseline rather than partial hunks.

---

### 6. `crm-slice-06-lib-projects-agent-platform`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Project surface | `src/lib/project-timeline*.ts`, `src/lib/project-communications*.ts`, `src/lib/project-notes*.ts`, `src/lib/project-canon*.ts`, `src/lib/project-index*.ts`, `src/lib/project-primary-client*.ts`, `src/lib/project-workflow-*.ts` |
| Agent tasks / sources | `src/lib/agent-tasks*.ts`, `src/lib/agent-sources*.ts`, `src/lib/agent-events*.ts`, `src/lib/agent-proposal*.ts`, `src/lib/agent-locations*.ts` |
| MCP | `src/lib/studio-mcp*.ts`, `src/lib/studio-mcp-client*.ts`, `src/lib/studio-mcp-events*.ts`, `src/lib/agent-api*.ts` |
| Data health | `src/lib/data-health*.ts` |
| Remaining monolith | `src/lib/crm.ts`, `src/lib/sales.ts`, `src/lib/questionnaires.ts`, `src/lib/portal*.ts`, `src/lib/proposal-*.ts`, `src/lib/scheduler.ts`, `src/lib/dashboard*.ts`, `src/lib/activity*.ts`, `src/lib/agenda*.ts`, `src/lib/format*.ts`, `src/lib/settings*.ts`, `src/lib/templates.ts`, `src/lib/email.ts`, `src/lib/client-*.ts`, `src/lib/engagement-sessions*.ts`, `src/lib/honeybook-import*.ts`, `src/lib/six-figure-workflows*.ts`, `src/lib/origin-guard*.ts` |

**Verify:**
```bash
tsx src/lib/agent-tasks.test.ts
tsx src/lib/studio-mcp.test.ts
tsx src/lib/data-health.test.ts
tsx src/lib/project-timeline.test.ts
tsx src/lib/project-communications.test.ts
tsx src/lib/project-workflow-automation.test.ts
tsx src/lib/questionnaire-response-management.test.ts
tsx src/lib/portal-context.test.ts
npm run lint && npm run build
```

**Merge risks:** Largest lib slice; `crm.ts` (+2,286) and `sales.ts` (+2,465) are cross-cutting. If partial checkout conflicts, take full files from `crm-platform-baseline`. Import scripts (`scripts/import-honeybook-projects.ts`, `scripts/import-six-figure-workflows.ts`) and `package.json` import entries belong here.

---

### 7. `crm-slice-07-api-surface`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Agent REST | `src/app/api/agent/**` |
| MCP endpoint | `src/app/api/mcp/**` |
| Finance / project / client APIs | `src/app/api/finance/**`, `src/app/api/projects/**`, `src/app/api/clients/**`, `src/app/api/invoices/**`, `src/app/api/proposals/**`, `src/app/api/questionnaires/**`, `src/app/api/scheduler/**`, `src/app/api/search/**`, `src/app/api/settings/**`, `src/app/api/stripe/**`, `src/app/api/templates/**`, `src/app/api/proposal/**` |

**Verify:**
```bash
# Spot-check highest-signal route tests
tsx src/app/api/agent/projects/route.test.ts
tsx src/app/api/agent/tasks/route.test.ts
tsx src/app/api/mcp/route.test.ts
tsx src/app/api/finance/expenses/route.test.ts
tsx src/app/api/stripe/webhook/route.test.ts
npm run lint && npm run build
```

**Merge risks:** Route handlers import lib symbols from slice 6 — strict ordering required.

---

### 8. `crm-slice-08-ui-shell-pages`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Shell / nav | `src/components/AppShell.tsx`, `src/components/QuickFind*.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/page.test.tsx` |
| New pages | `src/app/finance/**`, `src/app/inbox/**`, `src/app/agenda/**`, `src/app/activity/**`, `src/app/data-health/**` |
| Project UX | `src/app/projects/**`, `src/components/Project*.tsx`, `src/components/CreateProjectForClientForm.tsx` |
| Client / portal | `src/app/clients/**`, `src/app/portal/**` |
| Commerce flows | `src/app/invoices/**`, `src/app/proposals/**`, `src/app/proposal/**`, `src/components/ClientProposalExperience*.tsx` |
| Scheduler / book | `src/app/scheduler/**`, `src/app/book/**` |
| Questionnaires / templates | `src/app/questionnaires/**`, `src/app/templates/**`, `src/components/QuestionnaireTemplateEditor.tsx`, `src/components/ClientForm.tsx`, `src/components/ProjectForm*.tsx`, `src/components/PlannedAdminPage.tsx`, `src/components/LinkClientToProjectForm.tsx`, `src/app/settings/page.tsx` |

**Verify:**
```bash
tsx src/app/finance/page.test.tsx
tsx src/app/projects/page.test.tsx
tsx src/app/projects/[id]/page.test.tsx
tsx src/app/data-health/page.test.tsx
tsx src/components/QuickFind.test.ts
npm run lint && npm run build
```

**Merge risks:** UI imports new lib types and API shapes; must follow slice 7.

---

### 9. `crm-slice-09-proxy-security`

**Source commits:** `ce12cf6` (pages-proxy) + `042b83d` (Next.js 16 proxy fix)

| Area | Paths |
|------|-------|
| Pages front door | `pages-proxy/_worker.js`, `pages-proxy/proxy-*.test.ts` |
| Next proxy | `src/proxy.ts`, `src/proxy.test.ts` |
| Middleware removal | `src/middleware.ts` (delete) |
| Origin guard | `src/lib/origin-guard.ts`, `src/lib/origin-guard.test.ts` |

**Verify:**
```bash
npm run test:origin-guard
tsx src/proxy.test.ts
tsx pages-proxy/proxy-security.test.ts
tsx pages-proxy/proxy-admin-auth.test.ts
npm run lint && npm run build
```

**Merge risks:** **Critical ordering** — `deploy-preflight` rejects `src/middleware.ts`. Apply this slice **before** slice 10.

---

### 10. `crm-slice-10-ops-deploy-gate`

**From:** `ce12cf6` + `042b83d` doc deltas

| Area | Paths |
|------|-------|
| Preflight / smoke / restore | `scripts/deploy-preflight.mjs`, `scripts/deploy-preflight.test.mjs`, `scripts/production-smoke.mjs`, `scripts/production-smoke.test.mjs`, `scripts/restore-local-from-d1-backup.mjs`, `scripts/dev-studio.mjs` |
| Scripts registry | `package.json` (remaining: `deploy:preflight`, `smoke:production`, `db:restore-local:d1`, `dev:studio`, `deploy` gate wiring) |
| Docs | `docs/deployment-live-testing.md`, `docs/ops-stabilization-checklist.md` (final deltas), `docs/roadmap.md` |

**Verify:**
```bash
node scripts/deploy-preflight.test.mjs
node scripts/production-smoke.test.mjs
npm run deploy:preflight
npm run lint && npm run build
# Optional (needs CF token + agent token):
# npm run smoke:production
```

**Merge risks:** Depends on slice 9 (no `middleware.ts`). `npm run deploy` now runs preflight — document in PR body.

---

### 11. `crm-slice-11-agent-access-docs`

**From:** `ce12cf6`

| Area | Paths |
|------|-------|
| Agent/MCP reference | `docs/studio-agent-access.md` (+2,452 lines) |

**Verify:** Docs-only.

**Merge risks:** Large doc PR; best reviewed after slices 6–7 land so tool names match code.

---

## End-to-end gate (after all slices merged)

```bash
npm run lint
npm run build
npm run db:migrate
tsx src/db/studio-canon.test.ts
npm run deploy:preflight
# With credentials:
npm run smoke:production
```

Confirm reassembled `main` matches `crm-platform-baseline`:
```bash
git diff crm-platform-baseline --stat
# Expect empty or docs-only delta (this slicing plan)
```

---

## Cross-cutting merge risks

1. **Monolith files** — `src/lib/crm.ts`, `src/lib/sales.ts`, `src/lib/questionnaires.ts`, `src/db/client.ts` span multiple domains. Prefer whole-file checkout from `crm-platform-baseline` over conflict-prone partial hunks.
2. **Middleware vs preflight** — Do not merge slice 10 before slice 9; interim state with both `middleware.ts` and preflight will fail the deploy gate.
3. **`package.json`** — Touched in slices 2, 6, and 10; merge additively.
4. **Migration ordering** — All `migrations/00xx_*.sql` must land in numeric order in slice 4 (or 3+4 without gaps); never interleave with unrelated code in the same PR if avoidable.
5. **Test pattern** — No unified test runner; slice verify blocks use `tsx` / `node` on co-located `*.test.ts` / `*.test.mjs` files.
6. **Production smoke** — Requires live tokens (`CLOUDFLARE_API_TOKEN`, `STUDIO_AGENT_API_TOKEN` / keychain); keep out of CI until secrets are wired.

---

## Quick reference: commits → slices

| Commit | Slice(s) |
|--------|----------|
| `9b22943` docs: ops stabilization checklist | 1 |
| `21d3904` ops: deploy capture/rollback | 2 |
| `ce12cf6` chore: capture CRM platform baseline | 3–8, 10–11 |
| `042b83d` fix: proxy / origin guard | 9, 10 (doc/script deltas) |