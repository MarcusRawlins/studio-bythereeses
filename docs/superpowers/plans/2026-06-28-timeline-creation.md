# Timeline Creation Plan

## Goal

Create a Studio timeline workflow that turns submitted questionnaire responses and project sources into reviewable, source-linked timeline drafts, family formal drafts, and organized location context without letting AI silently change protected project truth.

This plan responds to the current Tiffany & Tim project issues:

- `Address TBD` and `Location TBD` should be filled from the questionnaire when Tyler has not already entered those fields.
- Day-of locations should be normalized and organized from questionnaire answers instead of appearing as a loose set of duplicate cards.
- The response page needs a strong `Create timeline` path that uses Studio AI/templates to create a timeline and family formal list.

## Guardrails

- AI may suggest a wedding date correction, but only Tyler can change the canonical wedding date.
- AI may not change a signed contract without Tyler approval.
- AI may not change an invoice or payment after creation without Tyler approval.
- Questionnaire-derived sync can only fill missing project fields or create reviewable suggestions unless the existing field is clearly empty/placeholder.
- Every generated timeline item, location update, family formal item, and communication draft must keep a source link back to the questionnaire response, project source, or agent task that produced it.
- No client-facing message, proposal, invoice, contract, or calendar sync should happen as part of timeline creation unless Tyler explicitly approves that action.

## Design

### 1. Canonical Project Profile From Questionnaire

Submitted questionnaire responses should continue to become canonical project sources, then feed the project profile in a controlled way.

Rules:

- If `projects.venueAddress` is empty, `Address TBD`, or equivalent, fill it from the best questionnaire location answer.
- If `projects.city/state/location` are empty or placeholders, derive them from the same best questionnaire location answer.
- If the venue answer is written as `District Winery (385 Water St SE, Washington, DC 20003)`, normalize it into:
  - venue name: `District Winery`
  - venue address: `385 Water St SE`
  - city: `Washington`
  - state: `DC`
- Do not overwrite a non-placeholder Tyler-entered venue name, address, city, state, or wedding date.
- Prefer reception as the primary venue for the project detail card when that is the known booked venue, but preserve ceremony, getting-ready, portraits, and other locations as separate day-of locations.

Files:

- `src/lib/questionnaires.ts`
- `src/lib/questionnaire-response-management.test.ts`
- `src/app/projects/[id]/page.tsx`
- `src/app/projects/[id]/page.test.tsx`

Implementation tasks:

1. Add a helper such as `parseVenueWithOptionalAddress(value)` for parenthetical address answers.
2. Add `isPlaceholderProjectText(value)` for `TBD`, `Address TBD`, `Location TBD`, blank, and similar placeholders.
3. Update `syncQuestionnaireResponseProjectProfile` so questionnaire sync fills only missing/placeholder address and location fields.
4. Add regression coverage using Tiffany-style answers where the venue answer includes a parenthetical address.
5. Add regression coverage proving Tyler-entered project address/location fields are not overwritten.

Verification:

```bash
npx tsx src/lib/questionnaire-response-management.test.ts
npx tsx src/app/projects/[id]/page.test.tsx
```

### 2. Organized Day-Of Locations

Project locations should read like a production plan, not raw questionnaire scraps.

Canonical location roles:

- bride getting ready
- groom getting ready
- ceremony
- portraits / family formals
- cocktail hour
- reception
- after party
- other logistics

Rules:

- Keep separate records when locations represent different roles, even if the address is the same.
- Merge obvious duplicates only when role, address, and source match.
- Keep free-text answers as notes when they are useful, but do not promote vague text into a fake address.
- Display locations grouped in a predictable order:
  1. getting ready
  2. ceremony
  3. portraits / family formals
  4. cocktail hour
  5. reception
  6. after party
  7. other
- In project details, show a compact summary. The fuller editable list can remain lower on the page or move into a dedicated logistics section.

Files:

- `src/lib/questionnaires.ts`
- `src/lib/project-location-plan.ts` (new)
- `src/app/projects/[id]/page.tsx`
- `src/lib/questionnaire-response-management.test.ts`
- `src/app/projects/[id]/page.test.tsx`

Implementation tasks:

1. Extract questionnaire location answers into typed candidates before writing rows.
2. Add a small location grouping formatter for UI display.
3. Update the project detail card so `Day-of locations` reads as a concise production summary.
4. Keep edit affordances, but make it clear the records are shared canonical project logistics.

Verification:

```bash
npx tsx src/lib/questionnaire-response-management.test.ts
npx tsx src/app/projects/[id]/page.test.tsx
```

### 3. Timeline Draft Creation

The `Create timeline` button should create a reviewable draft, not immediately write a final timeline.

Recommended flow:

1. Tyler opens a submitted questionnaire response.
2. Tyler clicks `Create timeline`.
3. Studio creates or reuses a `Timeline Agent` task linked to:
   - the project
   - the questionnaire response source
   - relevant project sources
   - current project events and locations
4. The agent drafts:
   - wedding day timeline items
   - family formal list
   - location plan updates/suggestions
   - open questions / missing info
5. Tyler reviews the draft.
6. Tyler clicks `Apply timeline`, `Apply locations`, and/or `Apply family formals`.
7. Only approved pieces become canonical records.

Draft output shape:

```ts
type TimelineDraft = {
  projectId: string
  sourceIds: string[]
  assumptions: string[]
  openQuestions: string[]
  timelineItems: Array<{
    title: string
    description?: string
    startAt?: string
    endAt?: string
    locationRole?: string
    locationName?: string
    confidence: "low" | "medium" | "high"
    sourceQuestionIds?: string[]
  }>
  familyFormals: Array<{
    groupName: string
    people: string[]
    notes?: string
    priority?: "must_have" | "nice_to_have"
    sourceQuestionIds?: string[]
  }>
  locationSuggestions: Array<{
    role: string
    name?: string
    address?: string
    city?: string
    state?: string
    notes?: string
    action: "create" | "update" | "review"
  }>
}
```

Files:

- `src/lib/timeline-draft.ts` (new)
- `src/lib/timeline-draft.test.ts` (new)
- `src/lib/agent-tasks.ts`
- `src/lib/project-timeline.ts`
- `src/lib/studio-mcp.ts`
- `src/app/questionnaires/[id]/responses/[responseId]/page.tsx`
- `src/app/api/projects/[id]/timeline-drafts/route.ts` (new, if we want a UI route instead of only MCP)
- `docs/studio-agent-access.md`

Implementation tasks:

1. Add a pure draft-builder that prepares project context from existing canonical records.
2. Use the existing `Timeline Agent` task path as the queue mechanism.
3. Store draft output in a source-linked agent task output or a compact `project_sources` draft record.
4. Add validation so a draft cannot be applied unless each timeline item is linked to project/source context.
5. Add a project-page draft review UI after the task path is reliable.

Verification:

```bash
npx tsx src/lib/timeline-draft.test.ts
npx tsx src/lib/agent-tasks.test.ts
npx tsx src/lib/project-timeline.test.ts
npx tsx src/lib/studio-mcp.test.ts
```

### 4. Family Formal Lists

Family formals should become first-class Studio data because they are part of the wedding production plan, not just notes.

Recommended schema:

- `project_family_formal_groups`
  - `id`
  - `project_id`
  - `title`
  - `notes`
  - `sort_order`
  - `source_type`
  - `source_id`
  - timestamps
- `project_family_formal_people`
  - `id`
  - `group_id`
  - `name`
  - `relationship`
  - `sort_order`
  - timestamps

Alternative quick slice:

- Store family formal drafts in an agent task output first.
- Add canonical tables in the next slice.

Recommendation:

- Start with draft output in the timeline task so the workflow is usable quickly.
- Add first-class family formal tables before treating this as a HoneyBook replacement feature.

Files:

- `migrations/0083_project_family_formals.sql` (new, if doing canonical tables)
- `src/db/schema.ts`
- `src/lib/family-formals.ts` (new)
- `src/lib/family-formals.test.ts` (new)
- `src/app/projects/[id]/page.tsx`

### 5. Templates And AI Prompting

Timeline generation should use Studio templates, not hard-coded prompt text scattered through the app.

Template inputs:

- project type
- wedding date
- ceremony/reception/getting-ready locations
- questionnaire response answers
- photo coverage hours, if known
- family formal answers
- sunset/timezone if available
- Tyler’s preferred workflow rules
- open questions and confidence rules

Template behavior:

- If exact times are not known, produce relative blocks or questions instead of fake precision.
- If a questionnaire answer conflicts with canonical project data, surface it as a conflict for review.
- If a location is vague, keep it as a note/suggestion rather than canonical address.
- Never change wedding date, contract, invoice, or payment fields.

Files:

- `src/lib/templates.ts`
- `src/lib/timeline-draft.ts`
- `docs/studio-agent-access.md`

### 6. UI Flow

Response page:

- Keep `View responses`.
- Add or keep `Create timeline`.
- After clicking, show `Timeline draft queued` and link back to the project.
- Later: show draft status inline when a draft exists for this response.

Project page:

- `Project details` shows filled venue address/location if empty fields can be safely inferred from questionnaire context.
- `Day-of locations` becomes compact and grouped.
- `Timeline` shows:
  - canonical applied timeline items
  - pending draft status
  - `Review draft` action if a timeline draft exists
- `Agent tasks` shows the queued work, but the main timeline UX should not require Tyler to understand task internals.

### 7. Rollout Order

Do this in four slices.

#### Slice A: Questionnaire Canon Fix

- Fill missing address/location from questionnaire.
- Normalize parenthetical venue addresses.
- Organize day-of locations in the existing project detail card.
- No AI call required.

Commands:

```bash
npx tsx src/lib/questionnaire-response-management.test.ts
npx tsx src/app/projects/[id]/page.test.tsx
npm run lint
npm run build
```

#### Slice B: Timeline Draft Skeleton

- Add `timeline-draft.ts` and tests.
- Make `Create timeline` queue a source-linked Timeline Agent task with enough context to generate a draft.
- Keep output as draft/review state only.

Commands:

```bash
npx tsx src/lib/timeline-draft.test.ts
npx tsx src/lib/agent-tasks.test.ts
npx tsx src/lib/studio-mcp.test.ts
npm run lint
npm run build
```

#### Slice C: Review And Apply

- Add review UI for timeline draft.
- Add `Apply timeline` to write canonical `project_timeline_items`.
- Add source-link validation before writing.
- Keep wedding date changes as suggestions only.

Commands:

```bash
npx tsx src/lib/project-timeline.test.ts
npx tsx src/app/projects/[id]/page.test.tsx
npm run lint
npm run build
```

#### Slice D: Family Formal Canon

- Add family formal tables and UI.
- Let timeline draft produce family formal groups.
- Add `Apply family formals` review action.

Commands:

```bash
npx tsx src/lib/family-formals.test.ts
npx tsx src/app/projects/[id]/page.test.tsx
npm run lint
npm run build
```

## Production Deployment Checklist

Before deploying any slice:

```bash
npm run backup:data
npm run lint
npm run build
```

After deploying:

```bash
npm run smoke:production
```

Browser QA targets:

- `https://studio.bythereeses.com/projects/e5094843-4d8f-44b5-a329-50b276e9b9e4`
- Tiffany & Tim project details should no longer show placeholder address/location when questionnaire data can safely fill them.
- Submitted questionnaire response page should keep `View responses` and timeline creation affordance.
- Timeline creation should create a reviewable draft/task, not silently mutate protected records.

## Open Decisions

1. Should the first production version store family formal lists as draft task output only, or add canonical family formal tables immediately?
2. Should `Create timeline` run immediately with the available agent provider, or should it only queue a task until Tyler explicitly enables the AI runner for the project?
3. Should location suggestions be applied from questionnaire sync automatically when fields are empty, or should all multi-location organization require a review step?

## Recommendation

Start with Slice A and Slice B.

That fixes the visible data problems Tyler is seeing now, gives the AI enough canonical context to work from, and avoids the risky part: silently applying a full wedding timeline before the review experience exists.
