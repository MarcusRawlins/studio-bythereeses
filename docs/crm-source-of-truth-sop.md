# Reese Photography CRM Source-of-Truth SOP

This is the operating procedure for agents working on the Reese Photography CRM / scheduler codebase.

## Canonical Repository

- Canonical working copy: `/Volumes/reeseai-memory/code/reese-photography-crm`
- Canonical remote: `https://github.com/MarcusRawlins/studio-bythereeses.git`
- Do not use other local copies for active development unless Tyler explicitly reassigns the canonical path.

Archived divergent copies, kept for reference only:

- `/Users/tyler-macmini/code/reese-photography-crm.2026-06-10-drift-archive`
- `/Users/tyler-macmini/Documents/studio-bythereeses.2026-06-10-drift-archive`

If either old unarchived path reappears, treat it as drift until reviewed.

## Required First Checks

Before any durable code, migration, deployment, or branch work:

```bash
cd /Volumes/reeseai-memory/code/reese-photography-crm
git status --short --branch
npm run check:source-drift
```

If `check:source-drift` exits non-zero, stop and resolve the source-of-truth issue before editing or deploying.

## Branch Rules

- `main`: eventual production-ready source of truth after reconciliation.
- `crm-platform-baseline`: preserved integration reference for the full local CRM state.
- `crm-drift-guard`: source-of-truth drift guard slice.
- `crm-slice-*`: reviewable stacked slices extracted from `crm-platform-baseline`.
- `stabilization/*`: ops hardening work only.

Do not merge `crm-platform-baseline` directly into `main` as a giant PR. Use `docs/crm-platform-slicing-plan.md` and land reviewable slices.

## Slice Workflow

1. Start from the branch named in `docs/crm-platform-slicing-plan.md`.
2. Bring over only the listed paths for the slice.
3. Run the slice-specific verification commands from the plan.
4. Run baseline gates before pushing:

```bash
npm run check:source-drift
npm run lint
npm run build
```

5. Push the slice branch and open a PR.

## Deployment Rules

No production deploy without explicit Tyler approval.

Before any deploy:

```bash
npm run check:source-drift
npm run lint
npm run build
npm run backup:data
npm run deploy:capture-versions
npm run deploy:preflight
```

After deploy:

```bash
npm run smoke:production
```

If rollback is needed:

```bash
npm run deploy:rollback -- --plan
```

Worker rollback can use the script. Pages rollback remains a Cloudflare dashboard step.

## Agent Safety Rules

- Do not delete archived copies unless Tyler explicitly asks.
- Do not force-push, reset, clean, or rewrite shared history without explicit approval.
- Do not add secrets to repo files, docs, or Obsidian.
- Do not treat Obsidian as implementation source. Obsidian is business/system context; this repo is engineering source.
- Do not create new CRM product features until source-of-truth, deploy, backup, rollback, and permission gates are stable.
- If multiple local copies disagree, trust the canonical repo path above and escalate before syncing.

## Current Drift Policy

The drift guard treats present git copies with different HEADs as a blocking error. Archived copies are intentionally absent from the active-copy check.

Known acceptable warnings:

- Archived old copies are absent from their original paths.
- Work-in-progress branch differs from `main` while it has an upstream and clean status.

Blocking conditions:

- Different HEADs across active known copies.
- Different origin URLs across active known copies.
- Missing canonical remote on the active repo.
- Dirty worktree before deployment.
