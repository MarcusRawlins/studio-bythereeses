# Project Detail Reliability and D1 Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Move remaining project-detail mutations off fragile server-action-only flows, tighten D1 reads, and add questionnaire response payload limits without changing user-facing workflows.

## Guardrails

- Do not deploy.
- Do not commit secrets.
- Do not run destructive database or git operations.
- Do not run remote D1 migrations.
- Do not change auth, payment, domain, or Cloudflare origin-guard behavior.
- Keep changes small, reversible, and within the agreed Cloudflare D1/OpenNext architecture.

## Architecture

The app is a Next.js 16 + TypeScript CRM running through OpenNext on Cloudflare Workers, with Cloudflare D1 in production and local SQLite for development. Project detail pages should submit state changes through explicit route handlers so the runtime behavior is easier to debug and less dependent on server-action transport. Existing server-action wrappers should remain where useful for compatibility, but should delegate to shared helpers.

## Tech Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Drizzle ORM
- Cloudflare D1 / local SQLite
- OpenNext Cloudflare

## Task 1: Read The Current Runtime Patterns

- [ ] Read `/Users/tyler-macmini/code/reese-photography-crm/AGENTS.md`.
- [ ] Read the relevant Next route-handler/server-action docs under `/Users/tyler-macmini/code/reese-photography-crm/node_modules/next/dist/docs/`.
- [ ] Inspect existing route-handler style in:
  - `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/route.ts`
  - `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/calendar/route.ts`
- [ ] Inspect current project detail forms/actions:
  - `/Users/tyler-macmini/code/reese-photography-crm/src/app/projects/[id]/page.tsx`
  - `/Users/tyler-macmini/code/reese-photography-crm/src/lib/crm.ts`

## Task 2: Extract Shared Project Mutation Helpers

In `/Users/tyler-macmini/code/reese-photography-crm/src/lib/crm.ts`:

- [ ] Add non-redirecting helpers that accept `FormData` and perform the existing mutation/revalidation/logging behavior:
  - `updateProjectStageFromForm(formData)`
  - `addProjectEventFromForm(formData)`
  - `updateProjectEventFromForm(formData)`
  - `createPortalLinkFromForm(formData): Promise<{ projectId: string; url: string }>`
  - `revokePortalTokenFromForm(formData)`
- [ ] Keep existing server-action exports in place, but make them call the helper and then perform the current redirect behavior.
- [ ] Do not remove public exports unless the repo proves they are unused.

## Task 3: Add Project Route Handlers

Create route handlers that call the helpers from Task 2:

- [ ] `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/stage/route.ts`
- [ ] `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/events/route.ts`
- [ ] `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/events/[eventId]/route.ts`
- [ ] `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/portal/route.ts`
- [ ] `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/projects/[id]/portal/[tokenId]/revoke/route.ts`

Implementation notes:

- [ ] Use `NextRequest` and `NextResponse`.
- [ ] Match the repo's Next 16 async `params` convention.
- [ ] Add `projectId` to the submitted `FormData` from the URL param.
- [ ] Add `eventId` or `tokenId` from the URL param where needed.
- [ ] Use `NextResponse.redirect(new URL(..., request.url), 303)` for successful form submissions.
- [ ] Return a small JSON `400` response for caught validation/mutation errors.

## Task 4: Point Project Detail Forms At Route Handlers

In `/Users/tyler-macmini/code/reese-photography-crm/src/app/projects/[id]/page.tsx`:

- [ ] Remove direct server-action imports for the moved mutations.
- [ ] Update the stage form to `method="post"` and `action="/api/projects/[id]/stage"`.
- [ ] Update add-event form to `method="post"` and `action="/api/projects/[id]/events"`.
- [ ] Update edit-event forms to `method="post"` and `action="/api/projects/[id]/events/[eventId]"`.
- [ ] Update create-portal-link form to `method="post"` and `action="/api/projects/[id]/portal"`.
- [ ] Update revoke-portal-token forms to `method="post"` and `action="/api/projects/[id]/portal/[tokenId]/revoke"`.
- [ ] Preserve the existing visible UI behavior.

## Task 5: Reduce D1 Read Waste

In `/Users/tyler-macmini/code/reese-photography-crm/src/lib/crm.ts`:

- [ ] Import `notInArray` from `drizzle-orm` if supported by the installed Drizzle version.
- [ ] Convert independent reads inside `getProject(projectId)` to a single `Promise.all` after the base project is loaded.
- [ ] Rewrite `listProjectsForClientLink(clientId)` so it does not load all projects and filter in memory when linked rows exist.
- [ ] If there are no linked rows, return all projects as before.
- [ ] If there are linked rows, query projects with `where: notInArray(projects.id, linkedProjectIds)`.

## Task 6: Add Questionnaire Answer Payload Limits

In `/Users/tyler-macmini/code/reese-photography-crm/src/app/api/questionnaires/[id]/responses/route.ts`:

- [ ] Add constants:
  - `MAX_ANSWER_LENGTH = 5000`
  - `MAX_CHECKBOX_VALUE_LENGTH = 500`
  - `MAX_SERIALIZED_ANSWERS_LENGTH = 100000`
- [ ] Validate every submitted answer before writing to D1.
- [ ] For checkbox/multi-select arrays, validate each item and reject oversized values.
- [ ] Reject the full serialized answer payload if it exceeds the max serialized length.
- [ ] Return a clear JSON `400` response for invalid payloads.
- [ ] Do not change the client-facing questionnaire flow beyond validation.

## Task 7: Verification

- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] If either fails, fix only issues caused by this slice.

## Task 8: Handoff

- [ ] Summarize changed files.
- [ ] Summarize verification results.
- [ ] Note any blockers or out-of-scope findings.
- [ ] Do not deploy.

## Explicitly Out Of Scope

- Cloudflare Worker origin guard activation.
- New secrets or environment-variable changes.
- Remote D1 migrations.
- Stripe/payment behavior.
- Google/Zoom auth behavior.
- Public domain routing.
- Large UX redesigns.
