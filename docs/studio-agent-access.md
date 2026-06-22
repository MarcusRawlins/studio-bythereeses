# The Reeses Studio Agent Access

The Studio exposes token-guarded agent access for trusted AI assistants. Use this for workflows like creating a project timeline from a planning call or drafting a proposal from discovery call notes.

Ops stabilization (deploy gate, rollback, backup/MCP drills): [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md). Production deploy and smoke targets: [`deployment-live-testing.md`](deployment-live-testing.md).

## Operating Reference

**Audience:** Tyler, Marcus, Brunel, and future trusted agents using Studio as a backoffice tool — not public clients.

**Base URL:** `https://studio.bythereeses.com` (never call the raw `workers.dev` origin; direct Worker admin/API access is blocked unless the origin secret header is present).

**Safe workflow:**

1. Run `npm run check:source-drift` before durable git or cross-copy work.
2. Read before write: `studio_search_projects` → `studio_get_project_context` (or `studio_get_client_context`) → `studio_list_activity` when duplicate risk exists.
3. Store durable outputs in Studio (`project_sources`, tasks, proposals, timelines, communications, expenses) with `sourceType` / `sourceId` links — not only in chat.
4. Prefer MCP (`POST /api/mcp`) for multi-step agent loops; REST (`GET/POST/PATCH /api/agent/*`) remains available for simpler clients. Both hit the same canonical library paths and activity logs.
5. Do not send client-facing email or SMS from agent tools unless a separate send/approval tool explicitly permits it. Workflow and communication tools draft or log; Tyler sends.
6. After production deploy, run `npm run smoke:production` (reads token from env or macOS Keychain `reese-studio-agent-api-token`).

**Token storage:** `STUDIO_AGENT_API_TOKEN` is a Cloudflare Worker secret in production. Local dev uses `.env.local`. Never commit the token to this repo or Obsidian. Keychain service: `reese-studio-agent-api-token` (account `studio.bythereeses.com`).

## Source of Truth

| Layer | Location |
| --- | --- |
| Business priorities, client context, durable decisions | Obsidian: `/Users/tyler-macmini/Documents/Obsidian Vault/02 Businesses/The Reeses/Reese Photography CRM - Source of Truth and Backups.md` |
| System cleanup / cross-project priorities | Obsidian: `/Users/tyler-macmini/Documents/Obsidian Vault/00 System/System Cleanup Command Center - 2026-05-21.md` |
| Source-of-truth hierarchy, working copy, drift guard | [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md) |
| Agent/MCP auth, tools, finance guard, smoke | This doc (`docs/studio-agent-access.md`) |
| Ops stabilization, deploy gate, rollback | [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md), [`deployment-live-testing.md`](deployment-live-testing.md) |
| Canonical active repo | `/Volumes/reeseai-memory/code/reese-photography-crm` |
| Archived (removed) | `/Users/tyler-macmini/code/reese-photography-crm`, `/Users/tyler-macmini/Documents/studio-bythereeses` |
| Backup artifacts | `/Volumes/reeseai-memory/backups/reese-photography-crm` (see [`backups.md`](backups.md)) |

Before strategic or durable changes, cross-check Obsidian first, then [`crm-source-of-truth-sop.md`](crm-source-of-truth-sop.md). Engineering details in this doc reflect the stacked CRM integration branch reality at slice 11.

## Deploy and Smoke Checklist

Required before `npm run deploy`:

```bash
npm run lint
npm run build
npm run backup:data          # valid CLOUDFLARE_API_TOKEN
npm run deploy:capture-versions
npm run check:source-drift   # enforced in deploy:preflight
npm run deploy:preflight
```

Full production loop:

```bash
npm run deploy:capture-versions
npm run deploy:preflight
npm run deploy
npm run deploy:pages-proxy
npm run smoke:production
```

`npm run smoke:production` verifies Studio/Schedule host split, Worker-origin blocking, project/client counts (≥100), zero data-health issues, agent REST finance/tasks/workflows, and MCP `tools/list` surface (finance report, agent task loop, project workflow automation). Rollback: `npm run deploy:rollback -- --plan` / `--yes`; Pages rollback remains manual in the Cloudflare dashboard. Details: [`ops-stabilization-checklist.md`](ops-stabilization-checklist.md).

## Finance Mutation Approval Guard

**Agents may read finance data** via `studio_get_finance_report` and `GET /api/agent/finance/report`. Use `paymentStatus` / `expenseStatus` of `needs_reconciliation` and `financeReport.reconciliation` before claiming books are clean.

**Agents may not mutate invoices, payment schedules, or payment ledger rows** without Tyler performing the change in Studio admin or explicitly approving a human-executed step. MCP tool descriptions mark blocked tools; REST and MCP calls return errors such as:

- `Invoices and payment schedules require Tyler approval before creation or changes.`
- `Payments require Tyler approval before creation or changes.`

**Blocked MCP tools and REST writes** (agents should draft recommendations as `studio_create_agent_task` or `project_sources` instead):

| Tool / REST write | Blocked action |
| --- | --- |
| `studio_create_invoice` / `POST /api/agent/projects/[id]/invoices` | Create invoice + payment schedule |
| `studio_update_invoice` / `PATCH /api/agent/projects/[id]/invoices` | Revise invoice or schedule |
| `studio_record_invoice_payment` / `POST /api/agent/invoices/[id]/payments` | Record installment payment |
| `studio_update_invoice_payment` / `PATCH /api/agent/invoices/[id]/payments` | Correct payment row |
| `studio_record_scheduler_booking_payment` / `POST /api/agent/scheduler/bookings/[id]/payment` | Record scheduler booking payment |
| `studio_update_scheduler_booking_payment` / `PATCH /api/agent/scheduler/bookings/[id]/payment` | Correct scheduler booking payment |

**Still permitted for agents** (not finance-ledger mutations): `studio_create_invoice_payment_checkout` / `POST /api/agent/invoices/[id]/payments/[paymentId]/checkout` (Stripe Checkout link only — does not mark paid), `studio_log_invoice_reminder`, expense create/update, proposal create/update, and all read tools.

**Other Tyler-only facts:** agents cannot change a project's wedding `eventDate` via `studio_update_project`; suggest a date change through a task or source note instead.

Implementation: `requireTylerApprovalForAgentFinance` in `src/lib/sales.ts`, `requireTylerApprovalForAgentSchedulerPayment` in `src/lib/scheduler.ts`. Covered by `src/lib/studio-mcp.test.ts` and agent route tests.

## Remaining Live Integration Requirements

Before treating production as fully operational for client-facing flows:

- [ ] Admin Google OAuth restricted to Tyler's account (browser admin; agents use bearer token, not Google session).
- [ ] All production secrets set per [`deployment-live-testing.md`](deployment-live-testing.md) (`GOOGLE_*`, `STRIPE_*`, `RESEND_*`, `STUDIO_AGENT_API_TOKEN`, `SCHEDULER_LINK_SECRET`, etc.).
- [ ] Custom domains attached and DNS stable (`studio.bythereeses.com`, `schedule.bythereeses.com` → Pages front door).
- [ ] Remote D1 schema current (`npm run db:migrate` against production before deploy).
- [ ] First live scheduler test completed (booking, client record, Google Calendar event, Resend confirmations).
- [ ] Token rotation drill + "who has the token" inventory documented (keychain, CF secrets, launchd) — see ops checklist item 6.
- [ ] Backup freshness and MCP assertions in deploy gate where cheap — see ops checklist item 5.

Agent/MCP surface is live today; finance mutations remain approval-gated until Tyler explicitly opens them.

## Authentication

Set `STUDIO_AGENT_API_TOKEN` in the Studio runtime.

Every agent request must include:

```http
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

If the token is not configured, Studio returns `503`. If the token is missing or wrong, Studio returns `401`.

## MCP Endpoint

Streamable HTTP MCP endpoint:

```text
POST /api/mcp
```

Required request headers:

```http
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Accept: application/json, text/event-stream
Content-Type: application/json
```

The MCP endpoint currently supports JSON responses and returns `405` for `GET`.

### Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {
      "name": "trusted-agent",
      "version": "1.0.0"
    }
  }
}
```

### List Tools

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

Available tools:

- `studio_search_projects`: finds canonical project ids by project name, client name, client email, venue, city, or state.
- `studio_get_project_context`: reads canonical project, client, event, location, timeline, source, communication, proposal, invoice, payment ledger, and project expense context before the agent writes anything.
- `studio_get_client_context`: reads one canonical client/contact profile with linked projects, bookings, proposals, invoices, questionnaire responses, and recent activity before updating contact facts or drafting follow-up.
- `studio_get_agenda`: reads the canonical Studio agenda for upcoming weddings, sessions, and scheduler calls.
- `studio_list_activity`: reads recent canonical Studio activity before deciding whether an agent action is new work, follow-up, or a duplicate.
- `studio_get_data_health`: reads canonical project/client link health before reconciling drift or creating new records.
- `studio_get_finance_report`: reads the canonical payment ledger and expense ledger for bookkeeping or executive-assistant reporting, including source evidence links.
- `studio_get_settings`: reads sanitized business/profile and enabled payment settings before drafting proposals, invoices, or payment instructions.
- `studio_list_templates`: reads canonical Studio templates for contracts, proposal packages, reminders, emails, questionnaires, and workflow prompts before drafting copy.
- `studio_list_questionnaires`: reads canonical active questionnaires and question ids before creating questionnaire links or filling responses.
- `studio_list_scheduler_meeting_types`: reads canonical scheduler meeting types, invitee questions, and booking URLs before handing off discovery, planning, or paid-consult links.
- `studio_create_project`: creates a canonical project, primary client, optional canonical event row, and optional intake source from trusted inquiry or discovery-call material.
- `studio_update_project`: updates canonical project facts such as stage, venue, date, budget, and notes from trusted source material.
- `studio_link_client_to_project`: links an existing canonical client to an existing canonical project without duplicating either record.
- `studio_update_client`: updates one canonical client/contact row, such as corrected email, phone, Instagram, communication preference, referral source, preferred name, or notes from discovery-call source material.
- `studio_merge_clients`: merges a duplicate canonical client into the chosen survivor and moves linked project/client records instead of creating drift.
- `studio_list_project_workflow_automations`: lists Studio workflow steps and any configured workflow runs for a project without changing anything.
- `studio_setup_project_workflow_automation`: opts one project into selected Studio workflow steps without queueing tasks or sending messages.
- `studio_queue_project_workflow_steps`: queues selected configured workflow steps into the Studio Inbox as agent tasks, without duplicating already queued steps.
- `studio_create_agent_task`: creates a durable task assignment for the agent.
- `studio_claim_agent_task`: claims the next queued task for a specialist or generic Studio agent and marks it in progress.
- `studio_start_agent_task_run`: claims or resumes a task and returns the task, project context, workflow context, safety rules, and completion contract in one execution packet.
- `studio_create_project_event`: creates a canonical project event/session row used by the Studio agenda and project page.
- `studio_update_project_event`: updates a canonical project event/session row in place so agent schedule edits persist across the Studio.
- `studio_create_project_location`: creates a canonical logistics location used by the Studio project page and agent project context.
- `studio_update_project_location`: updates an existing canonical logistics location in place.
- `studio_create_project_source`: stores canonical project source material, such as discovery-call notes or transcripts, before the agent creates proposals, timelines, invoices, or tasks from it.
- `studio_update_project_source`: revises existing canonical source material so linked tasks and outputs keep pointing at the corrected source row.
- `studio_list_agent_tasks`: lists durable task assignments, optionally filtered by project, status, or claimable assigned agent.
- `studio_update_agent_task`: updates task status, source link, result summary, and structured output references.
- `studio_submit_workflow_task_result`: stores a project workflow task result as canonical project source material, then completes the linked agent task and workflow step.
- `studio_run_workflow_draft_task`: claims or resumes a workflow-created task, generates a conservative draft/brief from canonical project context, and optionally stores it while completing the task.
- `studio_create_questionnaire_link`: creates a signed project-scoped questionnaire URL plus the matching timeline-call URL for a linked project client.
- `studio_upsert_questionnaire_response`: creates/reuses a project questionnaire draft, saves agent-provided answers, optionally submits it, and syncs the response into canonical project source material.
- `studio_create_timeline_item`: creates one canonical `project_timeline_items` row and logs agent activity.
- `studio_create_timeline_items`: creates an ordered batch of canonical `project_timeline_items` rows from one source, optionally replacing the prior batch for that same source, and logs agent activity for each row.
- `studio_update_timeline_item`: updates one canonical `project_timeline_items` row in place (time, title, notes, sort order) and logs agent activity.
- `studio_create_proposal`: creates a canonical `proposals` row plus `proposal_line_items`, calculates package total from included items, and logs agent activity.
- `studio_update_proposal`: revises an existing unaccepted canonical proposal and replaces package line items when provided.
- `studio_create_proposal_link`: creates a secure client proposal URL through the canonical hashed-token proposal access flow.
- `studio_create_portal_link`: creates a secure client portal URL for a canonical project, scoped to a linked client when `clientId` is provided.
- `studio_create_invoice`: **blocked — Tyler approval required.** Tool remains listed for discovery; agents draft invoice recommendations as tasks instead.
- `studio_update_invoice`: **blocked — Tyler approval required.** Agents draft revision recommendations as tasks instead.
- `studio_record_invoice_payment`: **blocked — Tyler approval required.** Agents draft reconciliation recommendations as tasks instead.
- `studio_create_invoice_payment_checkout`: creates a Stripe-hosted Checkout Session for an open installment and saves URL/session id on the payment row (does not mark paid).
- `studio_update_invoice_payment`: **blocked — Tyler approval required.** Agents draft correction recommendations as tasks instead.
- `studio_log_invoice_reminder`: records that an agent prepared or performed a manual invoice follow-up without sending anything automatically.
- `studio_record_scheduler_booking_payment`: **blocked — Tyler approval required.** Agents draft reconciliation recommendations as tasks instead.
- `studio_update_scheduler_booking_payment`: **blocked — Tyler approval required.** Agents draft correction recommendations as tasks instead.
- `studio_create_expense`: creates a canonical project-linked `expenses` row, canonizes the vendor, and logs agent activity for receipt/bookkeeping intake.
- `studio_update_expense`: revises an existing canonical project expense and vendor link from receipt/bookkeeping corrections.
- `studio_create_communication`: creates a canonical project communication draft or logged message, usually from discovery-call source material.
- `studio_update_communication`: updates an existing canonical communication draft/log, such as marking a drafted follow-up sent.

### Get Settings

Use this before creating invoices, drafting proposals, or preparing client-facing payment copy. The response is intentionally sanitized: it includes business profile fields and enabled payment methods, but no secrets, tokens, session data, or private provider credentials. The same payload is available to REST agents at `GET /api/agent/settings` with the Studio agent bearer token.

```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "tools/call",
  "params": {
    "name": "studio_get_settings",
    "arguments": {}
  }
}
```

### List Templates

Use this before drafting proposal packages, contracts, invoice reminders, questionnaire copy, or reusable client messages. The same payload is available to REST agents at `GET /api/agent/templates`, with optional `type` and `includeArchived=true` query parameters.

```json
{
  "jsonrpc": "2.0",
  "id": 31,
  "method": "tools/call",
  "params": {
    "name": "studio_list_templates",
    "arguments": {
      "type": "proposal_package"
    }
  }
}
```

### Search Projects

Use this first when the agent has a client/project name, email, venue, or location but does not yet have the canonical Studio project id. Search is paged and backed by the same canonical project index as the Studio project list. It can return projects that do not yet have a linked client, which is important for data-health repair; when `primaryClient` is `null`, inspect the project context and link or create the correct client rather than creating a duplicate project.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "studio_search_projects",
    "arguments": {
      "query": "Alex Taylor",
      "limit": 10,
      "page": 1,
      "sort": "eventDate"
    }
  }
}
```

The response includes `projects` plus `pagination` with `totalCount`, `filteredCount`, `currentPage`, `totalPages`, `pageSize`, `rangeStart`, and `rangeEnd`.

### Create Project

Use this when a trusted agent is handling a new inquiry or discovery call that does not already have a canonical Studio project. Studio reuses an existing client by normalized email instead of creating duplicates, or accepts `primaryClient.clientId` when data health already identified an orphan canonical client. It creates the project and primary participant, syncs the canonical event row when event/venue details are present, and can store the intake notes as the first `project_sources` row.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "studio_create_project",
    "arguments": {
      "name": "Morgan and Riley Wedding",
      "type": "wedding",
      "stage": "inquiry",
      "eventDate": "2026-11-07",
      "venueName": "Stone Mill",
      "city": "Beacon",
      "state": "NY",
      "budgetCents": 1200000,
      "primaryClient": {
        "firstName": "Morgan",
        "lastName": "Lee",
        "email": "morgan@example.com",
        "phone": "555-0199",
        "instagramHandle": "morganlee",
        "communicationPreference": "Email for contracts; text for timeline logistics.",
        "referralSource": "Planner referral",
        "role": "bride"
      },
      "intakeSource": {
        "kind": "discovery_call",
        "title": "Morgan inquiry call",
        "body": "Transcript or cleaned inquiry notes go here.",
        "summary": "Inquiry notes for project intake.",
        "sourceType": "call_transcript",
        "sourceId": "upstream-call-id"
      }
    }
  }
}
```

When `intakeSource.body` is provided, the response includes `sourceType: "project_source"` and `sourceId` pointing at the new canonical project source. Use that source id for follow-up timeline, proposal, invoice, task, or project-update calls.

If `studio_get_data_health` reports a client without a project, first inspect the client with `studio_get_client_context`, then create the project without retyping or duplicating the client:

```json
{
  "jsonrpc": "2.0",
  "id": 41,
  "method": "tools/call",
  "params": {
    "name": "studio_create_project",
    "arguments": {
      "name": "Bailey and Parker Wedding",
      "type": "wedding",
      "eventDate": "2027-05-15",
      "budgetCents": 750000,
      "primaryClient": {
        "clientId": "client-id-from-data-health",
        "role": "bride"
      }
    }
  }
}
```

### Get Project Context

Use this first when the agent has a Studio project id. It returns canonical database records and intentionally excludes portal tokens and private activity logs. Source records include discovery-call notes/transcripts, submitted questionnaire responses, receipts, or other project source material the agent should cite before writing. Questionnaire responses include structured answers and are also synced into `project_sources` when submitted or edited, so downstream timeline/proposal tasks can point to one durable project source. Event, location, and communication records include source links when they came from canonical project material. Proposal records include canonical package line items and signed-contract evidence when present: signer name/email, signed timestamp, acceptance IP, user agent, consent version, and selected optional line-item ids. Invoice records include accepted payment methods, payment instructions, payment schedules, and ledger fields such as paid amount, gross collected, client fee, processor fee, net deposit, open balance, and external payment reference. For invoice context, `balanceCents` is kept as a legacy alias of `clientPayableBalanceCents`, so both represent the remaining client-facing amount due including pass-through card fees. Project `financialSummary.openCents` remains payment-schedule open amount, while `financialSummary.clientPayableOpenCents` is the project-level client-facing receivable including pass-through card fees. Project `financialSummary.paidExpenseCents` tracks paid project costs, `financialSummary.openPayableCents` tracks unpaid vendor obligations, and `financialSummary.expenseCents` remains total project costs for projected margin. Scheduler bookings include paid booking ledger fields, checkout link references, and labeled `inviteeAnswers` from discovery/planning call booking forms so an agent can draft proposals or timelines from call intake without guessing what a raw question id means. Project-linked expenses include vendor, category, amount, paid date, payment method, receipt URL, tax-deductible flag, and external payment reference.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "studio_get_project_context",
    "arguments": {
      "projectId": "project-id-from-studio"
    }
  }
}
```

### Get Agenda

Use this when the agent needs executive-assistant schedule context, such as preparing the day, checking upcoming discovery calls, or identifying wedding/session work before creating follow-up tasks.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "studio_get_agenda",
    "arguments": {
      "fromDate": "2026-05-29",
      "toDate": "2026-07-10",
      "types": ["wedding", "engagement", "call"],
      "limit": 20,
      "timeZone": "America/New_York"
    }
  }
}
```

### List Activity

Use this before creating follow-up tasks, drafting reminders, or repeating operational work. It reads the same canonical `activity_logs` surface used by the Studio `/activity` audit view and returns formatted action labels, actor attribution, related project/client records, and compact metadata. Use `actorType: "agent"` to review recent agent work, or `projectId` to scope the audit trail to one project.

```json
{
  "jsonrpc": "2.0",
  "id": 31,
  "method": "tools/call",
  "params": {
    "name": "studio_list_activity",
    "arguments": {
      "actorType": "agent",
      "projectId": "project-id-from-studio",
      "limit": 25
    }
  }
}
```

### Get Data Health

Use this before reconciling clients/projects, importing source material, creating records, or repairing finance drift when Tyler reports missing or drifting data. It reads the same canonical checks used by the Studio `/data-health` page and returns counts plus issue rows such as projects without linked clients, projects without a primary contact, clients not linked to any project, submitted questionnaire answers that disagree with project date/venue/location fields, invoice paid totals that disagree with payment rows, and invoice payment schedules that do not equal invoice totals.

Each issue includes `repair` guidance with a Studio href, a human label, an `agentWorkflow`, and the ordered `agentTools` to use. Follow that repair workflow instead of guessing:

- `project_without_client`: identify the existing client, call `studio_link_client_to_project`, then optionally call `studio_update_project` with `primaryClientId`.
- `project_without_primary_client`: inspect linked clients with `studio_get_project_context`, then call `studio_update_project` with the correct `primaryClientId`.
- `questionnaire_project_field_mismatch`: inspect project context and submitted questionnaire answers, decide which source is correct, then call `studio_update_project` with the correct date, venue, and location facts.
- `client_without_project`: read the client first. If the project exists, call `studio_link_client_to_project`; if it does not, call `studio_create_project` with `primaryClient.clientId`.
- `invoice_paid_amount_mismatch`: inspect project context and the invoice ledger, then reconcile the canonical payment rows with `studio_record_invoice_payment` for a new receipt or `studio_update_invoice_payment` for an existing ledger row correction.
- `invoice_payment_schedule_mismatch`: inspect project context and proposal scope, then update the invoice payment schedule so scheduled payments equal the canonical invoice total.

```json
{
  "jsonrpc": "2.0",
  "id": 32,
  "method": "tools/call",
  "params": {
    "name": "studio_get_data_health",
    "arguments": {}
  }
}
```

### Create Project Source

Use this before asking the agent to create a proposal, timeline, or invoice from a discovery call. It makes the call notes/transcript a canonical Studio record so later tasks and outputs can point back to `sourceType: "project_source"` plus the returned `sourceId`.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "studio_create_project_source",
    "arguments": {
      "projectId": "project-id-from-studio",
      "kind": "discovery_call",
      "title": "Discovery call with Alex and Jordan",
      "body": "Transcript or cleaned call notes go here.",
      "summary": "Notes for proposal and timeline drafting.",
      "occurredAt": "2026-05-28T19:00:00.000Z",
      "sourceType": "call_transcript",
      "sourceId": "upstream-call-id"
    }
  }
}
```

### Update Project Source

Use this when a discovery transcript, notes summary, receipt OCR, or imported source is corrected after downstream tasks already point at it. Studio updates the existing `project_sources` row by id, preserves omitted fields, and logs `project.source.updated_by_agent`.

```json
{
  "jsonrpc": "2.0",
  "id": 51,
  "method": "tools/call",
  "params": {
    "name": "studio_update_project_source",
    "arguments": {
      "projectId": "project-id-from-studio",
      "projectSourceId": "project-source-id-from-studio",
      "title": "Discovery call with Alex and Jordan - final cleaned source",
      "body": "Final cleaned transcript or notes go here.",
      "summary": "Corrected source for proposal and timeline drafting.",
      "metadata": {
        "final": true
      }
    }
  }
}
```

### Get Finance Report

Use this when the agent needs bookkeeping or executive-assistant finance context without writing records. The report is read-only and is built from the same canonical payment and expense ledgers used by Studio finance pages and CSV exports, including `/api/finance/bookkeeping-summary.csv` for accountant-ready period snapshots. Payment rows include `paymentSourceType` and `paymentSourceId`; expense rows include `sourceType` and `sourceId`. `paymentStatus` and `expenseStatus` accept normal statuses plus `needs_reconciliation`, which returns paid invoice/scheduler payments and paid expenses missing settlement, receipt, or source evidence. Use `financeReport.reconciliation` as the repair queue before claiming the books are reconciled; it includes payment/expense counts, missing-evidence counts, and direct `href` values for the rows that need repair. `openCents` stays tied to concrete payment-schedule/A-R rows, while `clientPayableOpenCents` is the client-facing amount still due, including pass-through card fees. Project finance summaries de-duplicate invoice-level `clientPayableOpenCents` so multi-payment invoices are not double counted. Project `collectedProfitCents` is based on `netDepositCents - paidExpenseCents`; project `projectedProfitCents` is based on scheduled revenue minus total `expenseCents`, including open payables. Bookkeeping totals expose `revenueCents`, `grossCollectedCents`, `clientFeeCents`, `processingFeeCents`, `netDepositCents`, `paidExpenseCents`, and `openPayableCents`; `netIncomeCents` is based on net deposits after processor fees and paid expenses.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "studio_get_finance_report",
    "arguments": {
      "paymentStatus": "paid",
      "expenseStatus": "paid"
    }
  }
}
```

For settlement cleanup:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "studio_get_finance_report",
    "arguments": {
      "paymentStatus": "needs_reconciliation",
      "expenseStatus": "needs_reconciliation"
    }
  }
}
```

### Update Project

Use this when trusted source material changes the canonical project record itself, such as a discovery call confirming venue, budget, event date, current stage, or the primary project client. Omitted fields are left unchanged. Use `primaryClientId` only for a client already linked to the project; Studio demotes the old primary contact, promotes the selected client, and keeps the unique primary-contact database guard intact. Use `sourceType: "project_source"` plus `sourceId` when the update comes from a stored source; Studio validates that the source belongs to the same project and syncs the canonical event row used elsewhere in the platform.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "studio_update_project",
    "arguments": {
      "projectId": "project-id-from-studio",
      "stage": "planning",
      "eventDate": "2026-10-03",
      "venueName": "The Garden House",
      "city": "Rhinebeck",
      "state": "NY",
      "budgetCents": 950000,
      "primaryClientId": "linked-client-id-from-project-context",
      "notes": "Updated from discovery call.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Link Client To Project

Use this when `studio_get_data_health`, search, or client context shows that the correct client and project both already exist but are not connected. Link first, then call `studio_update_project` with `primaryClientId` if that linked client should become the primary contact.

```json
{
  "jsonrpc": "2.0",
  "id": 71,
  "method": "tools/call",
  "params": {
    "name": "studio_link_client_to_project",
    "arguments": {
      "projectId": "project-id-from-studio",
      "clientId": "client-id-from-studio",
      "role": "bride"
    }
  }
}
```

The response returns `linked`, `updated`, and the canonized `role`. This tool never creates a new client or project.

### Update Client

Use this when trusted source material corrects the canonical client/contact record itself, such as email, phone, Instagram, communication preference, referral source, preferred name, or notes. Omitted fields are left unchanged. The updated client row is the same row read by project context, project search, client pages, portal context, proposals, and invoices.

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "studio_update_client",
    "arguments": {
      "clientId": "client-id-from-project-context",
      "preferredName": "Lex",
      "email": "lex@example.com",
      "phone": "555-0199",
      "instagramHandle": "lex.reese",
      "communicationPreference": "Text for logistics; email for contracts.",
      "referralSource": "Planner referral",
      "notes": "Updated from discovery call."
    }
  }
}
```

### Merge Clients

Use this only after reading both records with `studio_get_client_context` and deciding which canonical client should survive. The merge moves linked project participant rows, bookings, questionnaire responses, communications, portal/proposal access tokens, and activity references to the survivor, then removes the duplicate client row.

```json
{
  "jsonrpc": "2.0",
  "id": 81,
  "method": "tools/call",
  "params": {
    "name": "studio_merge_clients",
    "arguments": {
      "survivorClientId": "client-id-to-keep",
      "duplicateClientId": "duplicate-client-id-to-remove"
    }
  }
}
```

The response returns the survivor id, duplicate id, and every project id touched by the merge.

### Create Agent Task

Use this when Tyler assigns work to the agent. It creates a durable Studio task record instead of leaving the assignment only in chat history.
When a task uses `sourceType: "project_source"`, Studio task create/list/claim/update responses include `linkedSource` with the canonical source title, body, summary, timestamps, and upstream source ids.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "studio_create_agent_task",
    "arguments": {
      "projectId": "project-id-from-studio",
      "title": "Create proposal from discovery call",
      "instructions": "Draft package, scope, invoice, and next steps from the discovery transcript.",
      "requestedBy": "Tyler",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Claim Agent Task

Use this when an agent is ready to take ownership of work. Omit `taskId` to claim the next eligible queued task, or include a `taskId` from `studio_list_agent_tasks` to claim that exact durable task. Studio only claims tasks assigned to that specialist or generic `The Reeses Studio Agent` tasks.

```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "tools/call",
  "params": {
    "name": "studio_claim_agent_task",
    "arguments": {
      "taskId": "agent-task-id-from-studio",
      "projectId": "project-id-from-studio",
      "assignedAgent": "Proposal Agent"
    }
  }
}
```

### Create Or Update Project Event

Use this when trusted source material creates or changes a dated project event such as an engagement session, rehearsal, welcome dinner, brunch, portrait session, or wedding day. These rows feed the Studio agenda and project page. Use `sourceType: "project_source"` plus `sourceId` when the event comes from stored planning-call or discovery-call material.

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "tools/call",
  "params": {
    "name": "studio_create_project_event",
    "arguments": {
      "projectId": "project-id-from-studio",
      "type": "rehearsal",
      "title": "Welcome dinner",
      "eventDate": "2026-06-18",
      "venueName": "Harbor Room",
      "city": "Charleston",
      "state": "SC",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "tools/call",
  "params": {
    "name": "studio_update_project_event",
    "arguments": {
      "projectId": "project-id-from-studio",
      "eventId": "event-id-from-context",
      "eventDate": "2026-06-19",
      "venueName": "River House"
    }
  }
}
```

### Create Or Update Project Location

Use this when trusted source material creates or corrects wedding-day logistics locations such as getting-ready suites, ceremony sites, reception spaces, portrait locations, or after-party stops. These rows feed the Studio project page and `studio_get_project_context`. Use `sourceType: "project_source"` plus `sourceId` when the location comes from stored planning-call, discovery-call, or questionnaire source material.

```json
{
  "jsonrpc": "2.0",
  "id": 19,
  "method": "tools/call",
  "params": {
    "name": "studio_create_project_location",
    "arguments": {
      "projectId": "project-id-from-studio",
      "type": "portrait",
      "name": "Garden portrait path",
      "address": "12 Garden Lane",
      "city": "Hudson",
      "state": "NY",
      "notes": "Best light before ceremony.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "tools/call",
  "params": {
    "name": "studio_update_project_location",
    "arguments": {
      "projectId": "project-id-from-studio",
      "locationId": "location-id-from-context",
      "name": "Garden portrait path west",
      "notes": "Updated after planner call."
    }
  }
}
```

### List Agent Tasks

Source-linked task rows include `linkedSource`, so a trusted agent can claim/list a task and immediately see the discovery-call source material it should use.
When `assignedAgent` is supplied, listing includes tasks assigned to that specialist plus generic `The Reeses Studio Agent` tasks, matching claim behavior.
Queued task lists are returned in claim order, oldest first, so the first row is the same task `studio_claim_agent_task` would claim next for the same filters.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "studio_list_agent_tasks",
      "arguments": {
        "projectId": "project-id-from-studio",
        "status": "queued",
        "assignedAgent": "Proposal Agent",
        "limit": 20
      }
  }
}
```

### Update Agent Task

Use this when a durable Studio task changes state, produces structured output, or needs to be relinked to corrected source material. Omitted `sourceType` and `sourceId` preserve the current task source. When relinking to `project_source`, Studio validates the source belongs to the same project as the task. Include `assignedAgent` when a specialist updates a task; Studio verifies the task belongs to that specialist or to the generic `The Reeses Studio Agent` queue. Specialist-owned tasks require `assignedAgent` on trusted agent updates.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "studio_update_agent_task",
    "arguments": {
      "taskId": "agent-task-id-from-studio",
      "status": "completed",
      "assignedAgent": "Proposal Agent",
      "sourceType": "project_source",
      "sourceId": "corrected-project-source-id-from-studio",
      "resultSummary": "Proposal and invoice were drafted from the discovery call.",
      "outputJson": {
        "clientIds": ["client-id-from-project-context"],
        "proposalIds": ["proposal-id-from-studio"],
        "invoiceIds": ["invoice-id-from-studio"],
        "paymentIds": ["invoice-payment-id-from-studio"],
        "activityLogIds": ["activity-log-id-from-studio"],
        "eventIds": ["project-event-id-from-studio"],
        "locationIds": ["project-location-id-from-studio"],
        "timelineIds": ["timeline-item-id-from-studio"],
        "communicationIds": ["communication-id-from-studio"],
        "expenseIds": ["expense-id-from-studio"],
        "projectSourceIds": ["project-source-id-from-studio"],
        "questionnaireResponseIds": ["questionnaire-response-id-from-studio"],
        "schedulerBookingIds": ["scheduler-booking-id-from-studio"]
      }
    }
  }
}
```

Studio validates all singular and array output references, including linked project clients, proposals, invoices, invoice payments (`paymentId`/`paymentIds` or `invoicePaymentId`/`invoicePaymentIds`), activity logs, project events, project locations, timeline items, communications, expenses, project sources, questionnaire responses, and scheduler bookings, against the task project before storing completion output. Supported output reference fields must contain non-empty string ids; malformed ids are rejected instead of being silently dropped. When the task is linked to `sourceType: "project_source"`, generated source-aware outputs (`proposal`, `invoice`, timeline item, project event, project location, communication, and expense rows) must also cite that exact project source before the task can be completed.

### Submit Workflow Task Result

Use this for tasks created by `studio_queue_project_workflow_steps`. The agent still drafts the work externally, but Studio owns the lifecycle: it claims a queued workflow task when needed, stores the submitted draft/checklist/brief as a canonical `project_sources` row linked to the workflow step, marks the agent task completed, and marks the workflow step completed. This does not send emails or texts.

For a full execution handoff, call `studio_start_agent_task_run` first. It claims or resumes the task and returns canonical project context, workflow step/run context when applicable, safety rules, and the exact completion endpoint/tool to call next.

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "studio_start_agent_task_run",
    "arguments": {
      "taskId": "workflow-agent-task-id-from-studio",
      "projectId": "project-id-from-studio",
      "assignedAgent": "Proposal Agent"
    }
  }
}
```

For Studio-generated first drafts and briefs, call `studio_run_workflow_draft_task`. Use `previewOnly: true` to generate without storing or completing. Omit `previewOnly` after review or when the caller is allowed to store a reviewable draft. This still does not send client-facing communication.

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "studio_run_workflow_draft_task",
    "arguments": {
      "taskId": "workflow-agent-task-id-from-studio",
      "projectId": "project-id-from-studio",
      "assignedAgent": "Communications Agent",
      "previewOnly": true
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "studio_submit_workflow_task_result",
    "arguments": {
      "taskId": "workflow-agent-task-id-from-studio",
      "assignedAgent": "Communications Agent",
      "outputTitle": "Day 1 intro text draft",
      "outputBody": "Draft text or operational brief for Tyler to review.",
      "outputSummary": "Prepared the Day 1 intro text for approval.",
      "outputKind": "workflow_draft",
      "metadata": {
        "approvalRequired": true,
        "channel": "sms"
      }
    }
  }
}
```

### Create Questionnaire Link

Use `studio_list_questionnaires` first so the agent has the canonical questionnaire id and question ids. Then use this when the agent needs to hand off an active questionnaire to a project client. Studio signs the project/client context into the URL, validates that `clientId` is already linked to the project when provided, returns the matching timeline-call scheduling URL, and logs `questionnaire.link_created_by_agent`.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "studio_list_questionnaires",
    "arguments": {
      "status": "active"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "studio_create_questionnaire_link",
    "arguments": {
      "projectId": "project-id-from-studio",
      "questionnaireId": "questionnaire-id-from-studio",
      "clientId": "client-id-from-studio"
    }
  }
}
```

### Upsert Questionnaire Response

Use this when a trusted agent needs to fill client/project intake from a discovery call, planning call, or other canonical source. If `responseId` is omitted, Studio creates or reuses the open draft for the given project, questionnaire, and client. When `submit` is true, the same questionnaire response becomes submitted and syncs into `project_sources` with `sourceType: "questionnaire_response"` so future proposal/timeline tasks can cite it.

Questionnaire answers with clear field labels also update canonical records directly. Client answers such as Instagram, phone, communication preference, referral source, preferred name, full name, and email sync to the linked client when they apply to that participant role. Project answers such as `Wedding date`, `Event date`, `Venue name`, `Venue address`, `Wedding city`, and `Wedding state` sync to the project row so project pages, search, agenda context, proposal drafting, and MCP context read the same facts.

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "studio_upsert_questionnaire_response",
    "arguments": {
      "projectId": "project-id-from-studio",
      "questionnaireId": "questionnaire-id-from-studio",
      "clientId": "client-id-from-studio",
      "answers": {
        "question-id-timeline-notes": "First look, family formals, and ceremony emotion matter most.",
        "question-id-family-priorities": "Keep grandparents comfortable and photographed early."
      },
      "submit": true
    }
  }
}
```

### Create Timeline Item

Use `sourceType: "project_source"` plus a `sourceId` from `studio_create_project_source` when the timeline is being generated from stored discovery-call notes. Studio validates that the source belongs to the same project before writing timeline rows.

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "studio_create_timeline_item",
    "arguments": {
      "projectId": "project-id-from-studio",
      "title": "Golden hour portraits",
      "description": "Couple portraits near the garden.",
      "startAt": "2026-09-19T22:30:00.000Z",
      "endAt": "2026-09-19T23:00:00.000Z",
      "sourceType": "discovery_call",
      "sourceId": "call-or-transcript-id"
    }
  }
}
```

### Create Timeline Items

Use this when the agent turns one discovery call, questionnaire, or planning source into several ordered timeline rows at once. Studio appends the batch after the existing project timeline sort order and applies the shared source link to every item unless an item provides its own source override. When regenerating from corrected source material, send `replaceExistingForSource: true` with the same `sourceType` and `sourceId` so the corrected batch replaces older rows from that source instead of duplicating them.

```json
{
  "jsonrpc": "2.0",
  "id": 18,
  "method": "tools/call",
  "params": {
    "name": "studio_create_timeline_items",
    "arguments": {
      "projectId": "project-id-from-studio",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio",
      "replaceExistingForSource": true,
      "timelineItems": [
        {
          "title": "Getting ready",
          "description": "Document final prep and detail photos.",
          "startAt": "2026-09-19T16:00:00.000Z",
          "endAt": "2026-09-19T17:00:00.000Z"
        },
        {
          "title": "Ceremony",
          "description": "Outdoor garden ceremony.",
          "startAt": "2026-09-19T20:00:00.000Z",
          "endAt": "2026-09-19T20:30:00.000Z"
        }
      ]
    }
  }
}
```

### Create Proposal

Use `sourceType: "project_source"` plus the `sourceId` returned by `studio_create_project_source` when the proposal is generated from stored discovery-call notes. Studio stores the source link on the proposal row and validates that the source belongs to the same project. Agents can call `studio_list_templates` first and pass `proposalPackageTemplateId` or `contractTemplateId`; when package or contract copy fields are omitted, Studio renders the selected canonical template into the proposal.

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "studio_create_proposal",
    "arguments": {
      "projectId": "project-id-from-studio",
      "title": "Discovery Call Proposal",
      "proposalPackageTemplateId": "proposal-package-template-id-from-studio",
      "contractTemplateId": "contract-template-id-from-studio",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio",
      "lineItems": [
        {
          "name": "Wedding photography coverage",
          "quantity": 1,
          "unitPriceCents": 900000
        },
        {
          "name": "Engagement session",
          "quantity": 1,
          "unitPriceCents": 150000,
          "isOptional": true
        }
      ]
    }
  }
}
```

### Update Proposal

Use this when follow-up discovery notes revise an existing proposal. Studio updates the existing proposal row, replaces package line items only when `lineItems` is provided, recalculates the included package total, preserves omitted fields, validates same-project source links, and rejects accepted or signed proposals. Passing `proposalPackageTemplateId` or `contractTemplateId` applies the active templates when matching copy fields are omitted.

```json
{
  "jsonrpc": "2.0",
  "id": 91,
  "method": "tools/call",
  "params": {
    "name": "studio_update_proposal",
    "arguments": {
      "projectId": "project-id-from-studio",
      "proposalId": "proposal-id-from-studio",
      "title": "Discovery Call Proposal Revised",
      "proposalPackageTemplateId": "proposal-package-template-id-from-studio",
      "contractTemplateId": "contract-template-id-from-studio",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio",
      "lineItems": [
        {
          "name": "Wedding photography coverage",
          "quantity": 1,
          "unitPriceCents": 950000
        },
        {
          "name": "Rehearsal dinner coverage",
          "quantity": 1,
          "unitPriceCents": 125000
        }
      ]
    }
  }
}
```

### Create Proposal Link

Use this after creating or revising a proposal when the agent needs to hand off a secure client-facing proposal URL. The proposal must include at least one priced required package line item and ready contract text before Studio will create the client link; incomplete packages stay editable as drafts instead of being sent. Studio stores only the token hash, scopes the link to the proposal/project and optional linked client, marks the proposal sent, and logs `proposal.link_created`.

```json
{
  "jsonrpc": "2.0",
  "id": 92,
  "method": "tools/call",
  "params": {
    "name": "studio_create_proposal_link",
    "arguments": {
      "projectId": "project-id-from-studio",
      "proposalId": "proposal-id-from-studio",
      "clientId": "client-id-from-studio",
      "label": "Discovery call proposal link"
    }
  }
}
```

### Create Portal Link

Use this when the agent needs to hand off the project portal after the canonical project/client context is ready. Studio stores only the token hash, validates that `clientId` is already linked to the project when provided, and logs `portal_token.generated` with agent attribution.

REST endpoint: `POST /api/agent/projects/:projectId/portal`

```json
{
  "jsonrpc": "2.0",
  "id": 93,
  "method": "tools/call",
  "params": {
    "name": "studio_create_portal_link",
    "arguments": {
      "projectId": "project-id-from-studio",
      "clientId": "client-id-from-studio",
      "label": "Planning portal link"
    }
  }
}
```

### Create Invoice

> **Blocked for agents.** `studio_create_invoice` and `POST /api/agent/projects/[id]/invoices` return a Tyler-approval error. Draft invoice recommendations with `studio_create_agent_task` or store structured notes in `studio_create_project_source`; Tyler creates the invoice in Studio admin.

Use this after a proposal exists, or for a standalone project invoice (Tyler or future approval-enabled callers only). When `proposalId` is supplied, Studio uses the proposal total unless `totalCents` is provided, creates the retainer/installment schedule, and marks the proposal invoice status as created. If credit card is accepted and Settings has card fees passed to the client, the invoice snapshots that card-fee policy at creation time. Use `sourceType: "project_source"` plus `sourceId` when the invoice is generated from canonical discovery-call notes; Studio validates the source belongs to the same project and stores the link on the invoice row.

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "studio_create_invoice",
    "arguments": {
      "projectId": "project-id-from-studio",
      "proposalId": "proposal-id-from-studio",
      "invoiceNumber": "INV-20260529-EXAMPLE",
      "retainerPercent": 30,
      "installmentCount": 1,
      "acceptedPaymentMethods": ["stripe", "zelle"],
      "stripePaymentLink": "https://pay.stripe.com/example",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Update Invoice

> **Blocked for agents.** Draft revision recommendations as tasks; Tyler applies invoice changes in Studio admin.

Use this before payments are recorded when follow-up notes revise an invoice total, due date, payment schedule, payment methods, Stripe payment link, or payment instructions (Tyler or future approval-enabled callers only). Studio updates the existing invoice row, rebuilds the pending payment schedule when total/schedule fields are provided, recalculates client-paid card fees from current settings, validates same-project source links, and rejects invoices that already have recorded payments.

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "tools/call",
  "params": {
    "name": "studio_update_invoice",
    "arguments": {
      "projectId": "project-id-from-studio",
      "invoiceId": "invoice-id-from-studio",
      "status": "sent",
      "totalCents": 1000000,
      "retainerPercent": 20,
      "installmentCount": 2,
      "dueDate": "2026-06-15",
      "paymentNotes": "Updated payment instructions.",
      "acceptedPaymentMethods": ["stripe", "zelle"],
      "stripePaymentLink": "https://pay.stripe.com/example-revised",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Record Invoice Payment

> **Blocked for agents.** Draft payment reconciliation as a task with linked `project_source` evidence; Tyler records the payment in Studio admin.

Use this after `studio_get_project_context` returns an invoice payment schedule (Tyler or future approval-enabled callers only). Studio records the payment in the same canonical ledger used by the admin invoice page and finance reports. For card payments where the invoice has client-paid card fees, Studio calculates client fee, gross collected, processor fee, and net deposit. A trusted agent may also attach per-installment Stripe Checkout fields (`stripeCheckoutUrl`, `stripeCheckoutSessionId`, `stripeCheckoutStatus`) so the client portal can show the same checkout link Tyler sees on the invoice payment row. Use `sourceType: "project_source"` plus `sourceId` when the receipt, Stripe evidence, or bank export was stored through `studio_create_project_source`; Studio validates that source belongs to the invoice project and stores the link on the payment row.

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "studio_record_invoice_payment",
    "arguments": {
      "invoiceId": "invoice-id-from-context",
      "paymentId": "payment-id-from-context",
      "status": "paid",
      "paymentMethod": "stripe",
      "paidAmountCents": 30000,
      "paidAt": "2026-06-02T10:00:00.000Z",
      "externalPaymentId": "stripe-payment-intent-or-bank-reference",
      "stripeCheckoutUrl": "https://checkout.stripe.com/c/pay/cs_live_example",
      "stripeCheckoutSessionId": "cs_live_example",
      "stripeCheckoutStatus": "paid",
      "notes": "Recorded from processor receipt.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Create Invoice Payment Checkout

Use this before a client needs a card-payment link for a specific open invoice installment. Studio creates a Stripe-hosted Checkout Session, calculates the same client-payable open amount shown in the portal including any pass-through card fee allocation, and saves the returned Checkout URL/session id on the canonical `invoice_payments` row. This only creates the payment link; it does not mark the installment paid. Record or update payment separately after Stripe receipt, webhook, or bank evidence exists.

```json
{
  "jsonrpc": "2.0",
  "id": 1100,
  "method": "tools/call",
  "params": {
    "name": "studio_create_invoice_payment_checkout",
    "arguments": {
      "invoiceId": "invoice-id-from-context",
      "paymentId": "payment-id-from-context"
    }
  }
}
```

### Update Invoice Payment

> **Blocked for agents.** Draft correction recommendations as tasks; Tyler updates payment rows in Studio admin.

Use this when processor settlement, a bank export, checkout-link creation, or a bookkeeping correction changes an existing payment row (Tyler or future approval-enabled callers only). Studio updates the same canonical invoice payment, recalculates invoice paid state and card-fee fields, validates corrected `project_source` links, preserves existing checkout fields unless replacements are provided, and logs `invoice.payment_updated_by_agent`. If `sourceType` and `sourceId` are omitted, Studio preserves the payment's existing source link.

```json
{
  "jsonrpc": "2.0",
  "id": 1101,
  "method": "tools/call",
  "params": {
    "name": "studio_update_invoice_payment",
    "arguments": {
      "invoiceId": "invoice-id-from-context",
      "paymentId": "payment-id-from-context",
      "status": "paid",
      "paymentMethod": "stripe",
      "paidAmountCents": 29000,
      "paidAt": "2026-06-02T11:00:00.000Z",
      "externalPaymentId": "corrected-stripe-payment-intent-or-bank-reference",
      "stripeCheckoutUrl": "https://checkout.stripe.com/c/pay/cs_live_corrected",
      "stripeCheckoutSessionId": "cs_live_corrected",
      "stripeCheckoutStatus": "paid",
      "notes": "Corrected from processor balance transaction.",
      "sourceType": "project_source",
      "sourceId": "corrected-project-source-id-from-studio"
    }
  }
}
```

### Log Invoice Reminder

Use this after the agent drafts or manually performs invoice follow-up. Studio stores a canonical audit entry on the invoice/project activity feed and returns the linked invoice/project ids plus `activityLogId` for task completion output. This endpoint does not send email, SMS, or automated payment reminders.

```json
{
  "jsonrpc": "2.0",
  "id": 1102,
  "method": "tools/call",
  "params": {
    "name": "studio_log_invoice_reminder",
    "arguments": {
      "invoiceId": "invoice-id-from-context",
      "paymentId": "payment-id-from-context",
      "channel": "email",
      "note": "Drafted final balance follow-up for Tyler to send.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Record Scheduler Booking Payment

> **Blocked for agents.** Draft scheduler payment reconciliation as a task; Tyler records booking payments in Studio admin.

Use `studio_list_scheduler_meeting_types` when the agent needs to hand off a booking link. Pass `projectId` and optional linked `clientId` to receive signed project-scoped booking URLs. The payload includes active meeting type ids/slugs, generic booking URLs, project booking URLs, invitee questions, duration, payment flags, and Stripe payment links for paid consults.

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "studio_list_scheduler_meeting_types",
    "arguments": {
      "projectId": "project-id-from-studio",
      "clientId": "client-id-from-studio"
    }
  }
}
```

Use payment recording after `studio_get_project_context` returns a paid scheduler booking or after a trusted checkout/processor receipt references a canonical booking id. Studio records the payment on the same `scheduler_bookings` row used by project context and finance totals. For Stripe or credit-card payments, Studio calculates client fee, processor fee, gross collected, and net deposit unless the agent supplies exact processor values. When the checkout receipt or processor evidence has been stored through `studio_create_project_source`, pass `sourceType: "project_source"` plus that `sourceId`; Studio validates the source belongs to the booking project and returns the same source link in payment responses and project context.

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "studio_record_scheduler_booking_payment",
    "arguments": {
      "bookingId": "booking-id-from-context",
      "status": "paid",
      "paymentMethod": "stripe",
      "paidAmountCents": 25000,
      "paidAt": "2026-05-29T13:00:00.000Z",
      "externalPaymentId": "stripe-payment-intent-or-bank-reference",
      "notes": "Recorded from scheduler checkout receipt.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Update Scheduler Booking Payment

> **Blocked for agents.** Draft correction recommendations as tasks; Tyler updates booking payment rows in Studio admin.

Use this when processor settlement, a bank export, or a bookkeeping correction changes an existing scheduler booking payment (Tyler or future approval-enabled callers only). Studio updates the same canonical `scheduler_bookings` row, recalculates client fee, processor fee, gross collected, and net deposit, validates corrected `project_source` links, and logs `scheduler.booking_payment_updated_by_agent`. If `sourceType` and `sourceId` are omitted, Studio preserves the booking payment's existing source link.

```json
{
  "jsonrpc": "2.0",
  "id": 1201,
  "method": "tools/call",
  "params": {
    "name": "studio_update_scheduler_booking_payment",
    "arguments": {
      "bookingId": "booking-id-from-context",
      "status": "paid",
      "paymentMethod": "stripe",
      "paidAmountCents": 24000,
      "paidAt": "2026-05-29T13:30:00.000Z",
      "externalPaymentId": "corrected-stripe-payment-intent-or-bank-reference",
      "notes": "Corrected from scheduler checkout settlement."
    }
  }
}
```

### Create Expense

Use this when the agent extracts project costs from a receipt, bank/card export, or bookkeeping note. Studio canonizes the vendor by normalized name, links the expense to the project, stores the source link on the expense row, and logs `expense.created_by_agent`. Use `sourceType: "project_source"` plus `sourceId` when the receipt/OCR/import has been stored through `studio_create_project_source`; Studio validates that source belongs to the same project.

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "studio_create_expense",
    "arguments": {
      "projectId": "project-id-from-studio",
      "vendorName": "Canon Professional Services",
      "category": "equipment",
      "description": "Lens calibration from receipt intake.",
      "amountCents": 12500,
      "status": "paid",
      "paidAt": "2026-05-11",
      "paymentMethod": "amex",
      "externalPaymentId": "card-charge-or-bank-reference",
      "receiptUrl": "r2://receipts/example.pdf",
      "taxDeductible": true,
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Update Expense

Use this when a trusted agent corrects a receipt OCR/import, vendor name, amount, category, tax-deductible flag, receipt URL, or external payment reference. Studio updates the existing expense row, reuses/canonizes the vendor by normalized name, validates same-project source links, rejects duplicate external payment ids, and logs `expense.updated_by_agent`.

```json
{
  "jsonrpc": "2.0",
  "id": 131,
  "method": "tools/call",
  "params": {
    "name": "studio_update_expense",
    "arguments": {
      "projectId": "project-id-from-studio",
      "expenseId": "expense-id-from-studio",
      "vendorName": "B&H Photo",
      "category": "equipment rental",
      "description": "Corrected receipt from OCR review.",
      "amountCents": 13500,
      "status": "paid",
      "paidAt": "2026-05-13",
      "paymentMethod": "visa",
      "externalPaymentId": "corrected-card-charge-reference",
      "receiptUrl": "r2://receipts/example-corrected.pdf",
      "taxDeductible": true,
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Create Communication

Use this when the agent drafts a follow-up email, SMS, call note, or internal note from source material. Studio stores the draft as a canonical project communication, defaults the recipient to the primary project client when no `clientId` or recipient override is supplied, validates `sourceType: "project_source"` links, and logs `project.communication.created_by_agent`.

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "tools/call",
  "params": {
    "name": "studio_create_communication",
    "arguments": {
      "projectId": "project-id-from-studio",
      "channel": "email",
      "status": "draft",
      "subject": "Proposal next steps",
      "body": "Hi Alex, here is the follow-up from our discovery call.",
      "sourceType": "project_source",
      "sourceId": "project-source-id-from-studio"
    }
  }
}
```

### Update Communication

Use this after a drafted follow-up has been sent, queued, revised, archived, or relinked to corrected source material. Omitted fields stay unchanged; Studio updates the existing communication row, validates corrected `project_source` links, and logs `project.communication.updated_by_agent`.

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "tools/call",
  "params": {
    "name": "studio_update_communication",
    "arguments": {
      "projectId": "project-id-from-studio",
      "communicationId": "communication-id-from-studio",
      "status": "sent",
      "sentAt": "2026-05-29T14:30:00.000Z",
      "sourceType": "project_source",
      "sourceId": "corrected-project-source-id-from-studio"
    }
  }
}
```

## REST Agent Endpoints

These remain available for simpler clients:

- `GET /api/agent/questionnaires`
- `GET /api/agent/scheduler/meeting-types`
- `GET /api/agent/projects/[id]/context`
- `GET /api/agent/projects`
- `POST /api/agent/projects`
- `PATCH /api/agent/projects/[id]`
- `POST /api/agent/projects/[id]/clients`
- `GET /api/agent/clients/[id]`
- `PATCH /api/agent/clients/[id]`
- `POST /api/agent/clients/[id]/merge`
- `GET /api/agent/agenda`
- `GET /api/agent/activity`
- `GET /api/agent/data-health`
- `GET /api/agent/finance/report`
- `GET /api/agent/tasks`
- `POST /api/agent/tasks`
- `PATCH /api/agent/tasks/[id]`
- `POST /api/agent/projects/[id]/events`
- `PATCH /api/agent/projects/[id]/events?id=event-id`
- `POST /api/agent/projects/[id]/locations`
- `PATCH /api/agent/projects/[id]/locations?id=location-id`
- `GET /api/agent/projects/[id]/sources`
- `POST /api/agent/projects/[id]/sources`
- `PATCH /api/agent/projects/[id]/sources?id=project-source-id`
- `POST /api/agent/projects/[id]/questionnaire-links`
- `POST /api/agent/projects/[id]/questionnaire-responses`
- `POST /api/agent/projects/[id]/timeline`
- `POST /api/agent/projects/[id]/proposals`
- `PATCH /api/agent/projects/[id]/proposals?id=proposal-id`
- `POST /api/agent/projects/[id]/proposals/[proposalId]/link`
- `POST /api/agent/projects/[id]/invoices`
- `PATCH /api/agent/projects/[id]/invoices?id=invoice-id`
- `POST /api/agent/invoices/[id]/payments`
- `PATCH /api/agent/invoices/[id]/payments`
- `POST /api/agent/invoices/[id]/payments/[paymentId]/checkout`
- `POST /api/agent/invoices/[id]/reminders`
- `POST /api/agent/scheduler/bookings/[id]/payment`
- `PATCH /api/agent/scheduler/bookings/[id]/payment`
- `POST /api/agent/projects/[id]/expenses`
- `PATCH /api/agent/projects/[id]/expenses?id=expense-id`
- `POST /api/agent/projects/[id]/communications`
- `PATCH /api/agent/projects/[id]/communications?id=communication-id`

All use the same bearer token and route through the same canonical Studio library functions as MCP.

### REST Activity

Read recent canonical activity before creating duplicate tasks or repeating follow-up:

```http
GET /api/agent/activity?actor=agent&projectId=project-id-from-studio&limit=25
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Query parameters:

- `actor` or `actorType`: `all`, `admin`, `agent`, `client`, or `system`.
- `projectId`: optional canonical project id filter.
- `limit`: optional row limit, capped at 150 for REST.

### REST Data Health

Read canonical project/client data-health checks:

```http
GET /api/agent/data-health
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

### REST Project Context

Find canonical project ids before calling project-specific endpoints. Optional query parameters: `q` or `query`, `limit` (1-25), `page`, and `sort=eventDate|createdAt|name`.

```http
GET /api/agent/projects?q=Alex%20Taylor&limit=10&page=1&sort=eventDate
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Returns `projects` plus `pagination`. Project summaries include primary client, location, proposal count, open invoice count, and open invoice balance. Projects with no linked client are included with `primaryClient: null` and `clientCount: 0` so agents can repair the canonical project/client relationship instead of missing the project.

Create a canonical project and primary client from trusted inquiry or discovery-call material:

```http
POST /api/agent/projects
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "name": "Morgan and Riley Wedding",
  "type": "wedding",
  "stage": "inquiry",
  "eventDate": "2026-11-07",
  "venueName": "Stone Mill",
  "city": "Beacon",
  "state": "NY",
  "budgetCents": 1200000,
  "primaryClient": {
    "firstName": "Morgan",
    "lastName": "Lee",
    "email": "morgan@example.com",
    "phone": "555-0199",
    "instagramHandle": "morganlee",
    "communicationPreference": "Email for contracts; text for timeline logistics.",
    "referralSource": "Planner referral",
    "role": "bride"
  },
  "intakeSource": {
    "kind": "discovery_call",
    "title": "Morgan inquiry call",
    "body": "Transcript or cleaned inquiry notes go here.",
    "summary": "Inquiry notes for project intake.",
    "sourceType": "call_transcript",
    "sourceId": "upstream-call-id"
  }
}
```

Studio normalizes the client email, reuses an existing client record when one exists, creates the project participant row, syncs the canonical event row, and returns the optional intake source id for later agent calls.

```http
GET /api/agent/projects/project-id-from-studio/context
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Update canonical project facts from trusted source material:

```http
PATCH /api/agent/projects/project-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "stage": "planning",
  "eventDate": "2026-10-03",
  "venueName": "The Garden House",
  "city": "Rhinebeck",
  "state": "NY",
  "budgetCents": 950000,
  "primaryClientId": "linked-client-id-from-project-context",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

Link an existing canonical client to an existing canonical project:

```http
POST /api/agent/projects/project-id-from-studio/clients
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "clientId": "client-id-from-studio",
  "role": "planner"
}
```

### REST Get Client Context

Read a canonical client/contact profile before updating facts or drafting follow-up. The response is the same context used by the Studio client page: linked projects, scheduler bookings, proposals, invoices with open balances and next unpaid due dates, questionnaire responses, and recent activity.

```http
GET /api/agent/clients/client-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

```json
{
  "clientContext": {
    "client": {
      "id": "client-id-from-studio",
      "firstName": "Alex",
      "email": "alex@example.com",
      "instagramHandle": "@alexreese",
      "communicationPreference": "Email for contracts; text for logistics.",
      "referralSource": "Planner referral"
    },
    "projects": [],
    "bookings": [],
    "proposals": [],
    "invoices": [],
    "questionnaireResponses": [],
    "activity": []
  }
}
```

### REST Update Client

Update canonical client/contact facts from trusted source material. Omitted fields are left unchanged, and duplicate email updates are rejected.

```http
PATCH /api/agent/clients/client-id-from-project-context
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "preferredName": "Lex",
  "email": "lex@example.com",
  "phone": "555-0199",
  "instagramHandle": "lex.reese",
  "communicationPreference": "Text for logistics; email for contracts.",
  "referralSource": "Planner referral",
  "notes": "Updated from discovery call."
}
```

### REST Merge Clients

Merge a duplicate client into a survivor after inspecting both canonical client contexts. This route uses the same merge helper as the Studio admin merge screen and MCP tool.

```http
POST /api/agent/clients/client-id-to-keep/merge
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "duplicateClientId": "duplicate-client-id-to-remove"
}
```

The response contains:

```json
{
  "merge": {
    "survivorClientId": "client-id-to-keep",
    "duplicateClientId": "duplicate-client-id-to-remove",
    "linkedProjectIds": ["project-id"]
  }
}
```

### REST Create Or Update Project Event

Create or update canonical project events used by the Studio agenda and project page.

```http
POST /api/agent/projects/project-id-from-studio/events
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "type": "engagement",
  "title": "Engagement session",
  "eventDate": "2026-06-10",
  "venueName": "Downtown",
  "city": "Charleston",
  "state": "SC"
}
```

```http
PATCH /api/agent/projects/project-id-from-studio/events?id=event-id-from-context
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "title": "Engagement portraits",
  "venueName": "Rainbow Row"
}
```

### REST Create Or Update Project Location

Create or update canonical project logistics locations used by the Studio project page and agent project context.

```http
POST /api/agent/projects/project-id-from-studio/locations
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "type": "portrait",
  "name": "Portrait garden",
  "address": "12 Garden Lane",
  "city": "Hudson",
  "state": "NY",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

```http
PATCH /api/agent/projects/project-id-from-studio/locations?id=location-id-from-context
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "name": "Portrait garden west path",
  "notes": "Updated from agent logistics pass."
}
```

### REST Agenda

Read the same canonical agenda used by the Studio `/agenda` page and the MCP `studio_get_agenda` tool.

```http
GET /api/agent/agenda?fromDate=2026-05-29&toDate=2026-07-10&types=wedding,call&limit=20&timeZone=America/New_York
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

`types` accepts `wedding`, `engagement`, `other`, and `call`, either comma-separated or repeated as `type=call&type=wedding`.

### REST Project Sources

Create canonical discovery-call notes or other source material:

```http
POST /api/agent/projects/project-id-from-studio/sources
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "kind": "discovery_call",
  "title": "Discovery call with Alex and Jordan",
  "body": "Transcript or cleaned call notes go here.",
  "summary": "Notes for proposal and timeline drafting.",
  "occurredAt": "2026-05-28T19:00:00.000Z",
  "sourceType": "call_transcript",
  "sourceId": "upstream-call-id"
}
```

List project source records:

```http
GET /api/agent/projects/project-id-from-studio/sources?kind=discovery_call&limit=20
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Correct an existing project source without changing its canonical id:

```http
PATCH /api/agent/projects/project-id-from-studio/sources?id=project-source-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "title": "Discovery call with Alex and Jordan - final cleaned source",
  "body": "Final cleaned transcript or notes go here.",
  "summary": "Corrected source for proposal and timeline drafting.",
  "metadata": {
    "final": true
  }
}
```

### REST Questionnaire Links

Read active questionnaires first, including their canonical question ids:

```http
GET /api/agent/questionnaires
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Optional query parameters: `status=active|draft|archived`, `includeArchived=true`, and `includeQuestions=false`.

Then create a signed project-scoped questionnaire URL and matching timeline-call URL for agent handoff. The project id in the URL is authoritative, and `clientId` must already be linked to that project when provided.

```http
POST /api/agent/projects/project-id-from-studio/questionnaire-links
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "questionnaireId": "questionnaire-id-from-studio",
  "clientId": "client-id-from-studio"
}
```

### REST Questionnaire Responses

Create or update a project questionnaire response from trusted agent intake. The project id in the URL is authoritative, submitted responses sync into `project_sources`, client profile fields, and recognized project fields. Later updates reuse the same response when `responseId` is provided.

```http
POST /api/agent/projects/project-id-from-studio/questionnaire-responses
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "questionnaireId": "questionnaire-id-from-studio",
  "clientId": "client-id-from-studio",
  "answers": {
    "question-id": "Discovery-call answer text",
    "checkbox-question-id": ["Option A", "Option B"]
  },
  "submit": true
}
```

To revise an existing canonical response, send `responseId`; Studio confirms the response belongs to the URL project before writing.

### REST Create Communication

Use this when the agent drafts or logs a client follow-up from source material. If `clientId`, `recipientName`, and `recipientEmail` are omitted, Studio uses the primary project client as the recipient.

```http
POST /api/agent/projects/project-id-from-studio/communications
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "channel": "email",
  "status": "draft",
  "subject": "Proposal next steps",
  "body": "Hi Alex, here is the follow-up from our discovery call.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

Update a communication lifecycle state or correct its source link:

```http
PATCH /api/agent/projects/project-id-from-studio/communications?id=communication-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "sent",
  "sentAt": "2026-05-29T14:30:00.000Z",
  "sourceType": "project_source",
  "sourceId": "corrected-project-source-id-from-studio"
}
```

### REST Project Workflow Automations

List available Studio workflow steps and any workflow runs already configured for a project:

```http
GET /api/agent/projects/project-id-from-studio/workflows
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Set up the workflow for a project. This stores the selected steps only; it does not create agent tasks and does not send any client messages.

```http
POST /api/agent/projects/project-id-from-studio/workflows
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "stepKeys": ["lead-introduction-text", "proposal-retainer-package"]
}
```

Queue selected configured steps into the Studio Inbox as agent tasks. Already queued steps are skipped, so this can be safely retried.

```http
PATCH /api/agent/projects/project-id-from-studio/workflows
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "workflowRunId": "project-workflow-run-id-from-studio",
  "stepKeys": ["proposal-retainer-package"]
}
```

Use this when Tyler says to turn on a workflow for a specific project or to queue only specific steps. These workflow routes never send emails or texts directly; they create approval-oriented Studio Inbox work for the appropriate specialist agent.

Post-wedding delivery foundation step keys (drafts only; Tyler approves and sends):

- `day-after-touchpoint`
- `sneak-peek-delivery`
- `gallery-delivery`
- `review-request`
- `referral-follow-up`

Example post-delivery setup:

```json
{
  "stepKeys": ["day-after-touchpoint", "sneak-peek-delivery", "gallery-delivery", "review-request", "referral-follow-up"]
}
```

Submit the result of a workflow-created task after the agent drafts the work:

Start or resume a task run and receive the execution packet:

```http
POST /api/agent/tasks/run
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "taskId": "workflow-agent-task-id-from-studio",
  "projectId": "project-id-from-studio",
  "assignedAgent": "Proposal Agent"
}
```

Generate a Studio draft/brief for a workflow-created task:

```http
POST /api/agent/tasks/agent-task-id-from-studio/workflow-draft-run
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "projectId": "project-id-from-studio",
  "assignedAgent": "Communications Agent",
  "previewOnly": true
}
```

```http
POST /api/agent/tasks/agent-task-id-from-studio/workflow-result
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "assignedAgent": "Proposal Agent",
  "outputTitle": "Proposal and retainer task brief",
  "outputBody": "Drafted proposal package notes, contract-ready assumptions, and retainer invoice plan.",
  "outputSummary": "Prepared proposal/retainer handoff for Tyler approval.",
  "outputKind": "workflow_draft",
  "metadata": {
    "approvalRequired": true
  }
}
```

### REST Agent Tasks

Create a durable task assignment:

```http
POST /api/agent/tasks
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "projectId": "project-id-from-studio",
  "title": "Create proposal from discovery call",
  "instructions": "Draft package, scope, invoice, and next steps from the discovery transcript.",
  "priority": "high",
  "requestedBy": "Tyler",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

For source-linked tasks, REST task create/list/claim/update responses include `linkedSource` with the canonical source details.

List tasks:

```http
GET /api/agent/tasks?projectId=project-id-from-studio&status=queued&assignedAgent=Proposal%20Agent&limit=20
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

When `assignedAgent` is supplied, the response includes tasks assigned to that specialist plus generic `The Reeses Studio Agent` tasks, so a specialist can preview the same queue it is allowed to claim.
Queued task lists are returned in claim order, oldest first.

Claim the next eligible task, or include `taskId` to claim a specific task from the list:

```http
PATCH /api/agent/tasks
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "taskId": "agent-task-id-from-studio",
  "projectId": "project-id-from-studio",
  "assignedAgent": "Proposal Agent"
}
```

Update task state, source link, and outputs:

```http
PATCH /api/agent/tasks/agent-task-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "completed",
  "assignedAgent": "Proposal Agent",
  "sourceType": "project_source",
  "sourceId": "corrected-project-source-id-from-studio",
  "resultSummary": "Proposal and invoice were drafted from the discovery call.",
  "outputJson": {
    "clientIds": ["client-id-from-project-context"],
    "proposalIds": ["proposal-id-from-studio"],
    "invoiceIds": ["invoice-id-from-studio"],
    "paymentIds": ["invoice-payment-id-from-studio"],
    "activityLogIds": ["activity-log-id-from-studio"],
    "eventIds": ["project-event-id-from-studio"],
    "locationIds": ["project-location-id-from-studio"],
    "projectSourceIds": ["project-source-id-from-studio"]
  }
}
```

Omit `sourceType` and `sourceId` when the task should remain linked to its existing source. When relinking to `project_source`, Studio validates the source belongs to the task project.

Studio validates all output ids against the task project before marking the task completed, including both singular keys such as `proposalId` and array keys such as `proposalIds`. Supported output references include linked project clients, proposals, invoices, invoice payment ledger rows (`paymentId`/`paymentIds` or `invoicePaymentId`/`invoicePaymentIds`), activity logs, project events, project locations, timeline items, communications, expenses, project sources, questionnaire responses, and scheduler bookings. Supported reference ids must be non-empty strings; malformed values are rejected instead of ignored. For tasks linked to `sourceType: "project_source"`, any referenced generated proposal, invoice, timeline item, project event, project location, communication, or expense must carry the same `sourceType` and `sourceId`, so a proposal created from discovery-call notes cannot be completed against a task without preserving the discovery-call citation.

### REST Create Timeline Item Or Timeline Batch

Use this when the agent turns planning notes into canonical project timeline rows. The endpoint appends after the existing timeline sort order and logs `project.timeline_item.created` as agent activity. Send a single item shape to create one row, or send `timelineItems` to create an ordered batch from one source. For regenerated batches from corrected source material, include `replaceExistingForSource: true` with `sourceType` and `sourceId` so Studio replaces prior rows for that source before inserting the new batch.

```http
POST /api/agent/projects/project-id-from-studio/timeline
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "title": "Golden hour portraits",
  "description": "Couple portraits near the garden.",
  "startAt": "2026-09-19T22:30:00.000Z",
  "endAt": "2026-09-19T23:00:00.000Z",
  "sourceType": "discovery_call",
  "sourceId": "call-or-transcript-id"
}
```

```json
{
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio",
  "replaceExistingForSource": true,
  "timelineItems": [
    {
      "title": "Getting ready",
      "description": "Document final prep and detail photos.",
      "startAt": "2026-09-19T16:00:00.000Z",
      "endAt": "2026-09-19T17:00:00.000Z"
    },
    {
      "title": "Ceremony",
      "description": "Outdoor garden ceremony.",
      "startAt": "2026-09-19T20:00:00.000Z",
      "endAt": "2026-09-19T20:30:00.000Z"
    }
  ]
}
```

### REST Create Proposal

Use this when the agent drafts a proposal from discovery-call notes. The endpoint creates one canonical proposal plus line items, calculates the package total from included items only, infers readiness from package and contract content, stores the source link on the proposal row, and logs `proposal.created_by_agent`.

```http
POST /api/agent/projects/project-id-from-studio/proposals
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "title": "Discovery Call Proposal",
  "packageName": "Heritage Day",
  "validUntil": "2026-06-15",
  "scopeSummary": "Generated from discovery call notes.",
  "contractTitle": "Photography Agreement",
  "contractBody": "Draft terms from the call.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio",
  "lineItems": [
    {
      "name": "Wedding photography coverage",
      "quantity": 1,
      "unitPriceCents": 900000
    },
    {
      "name": "Engagement session",
      "quantity": 1,
      "unitPriceCents": 150000,
      "isOptional": true
    }
  ]
}
```

To revise the same proposal instead of creating a duplicate, call:

```http
PATCH /api/agent/projects/project-id-from-studio/proposals?id=proposal-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "title": "Discovery Call Proposal Revised",
  "packageName": "Heritage Weekend",
  "scopeSummary": "Revised from follow-up discovery notes.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio",
  "lineItems": [
    {
      "name": "Wedding photography coverage",
      "quantity": 1,
      "unitPriceCents": 950000
    },
    {
      "name": "Rehearsal dinner coverage",
      "quantity": 1,
      "unitPriceCents": 125000
    }
  ]
}
```

To create a secure proposal link for client handoff, call:

```http
POST /api/agent/projects/project-id-from-studio/proposals/proposal-id-from-studio/link
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "clientId": "client-id-from-studio",
  "label": "Discovery call proposal link"
}
```

### REST Create Invoice

> **Blocked for agents.** Returns Tyler-approval error. See [Finance Mutation Approval Guard](#finance-mutation-approval-guard).

Use this after creating or locating a proposal, or for a standalone project invoice (Tyler or future approval-enabled callers only). The endpoint uses the same canonical invoice creation path as MCP, including proposal invoice-status updates, payment schedule creation, card-fee snapshotting, and `invoice.created_by_agent` activity logging.

```http
POST /api/agent/projects/project-id-from-studio/invoices
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "proposalId": "proposal-id-from-studio",
  "invoiceNumber": "INV-20260529-EXAMPLE",
  "status": "draft",
  "retainerPercent": 30,
  "installmentCount": 1,
  "acceptedPaymentMethods": ["stripe", "zelle"],
  "stripePaymentLink": "https://pay.stripe.com/example",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

To revise an existing unpaid invoice instead of creating a duplicate, call:

```http
PATCH /api/agent/projects/project-id-from-studio/invoices?id=invoice-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "sent",
  "totalCents": 1000000,
  "retainerPercent": 20,
  "installmentCount": 2,
  "dueDate": "2026-06-15",
  "paymentNotes": "Updated payment instructions.",
  "acceptedPaymentMethods": ["stripe", "zelle"],
  "stripePaymentLink": "https://pay.stripe.com/example-revised",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

### REST Record Invoice Payment

> **Blocked for agents.** Returns Tyler-approval error. Draft reconciliation as a task instead.

Use the same canonical source-link flow as MCP when recording payment evidence from a stored project source (Tyler or future approval-enabled callers only).

```http
POST /api/agent/invoices/invoice-id-from-context/payments
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "paymentId": "payment-id-from-context",
  "status": "paid",
  "paymentMethod": "stripe",
  "paidAmountCents": 30000,
  "paidAt": "2026-06-02T10:00:00.000Z",
  "externalPaymentId": "stripe-payment-intent-or-bank-reference",
  "notes": "Recorded from processor receipt.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

Correct an existing invoice payment row (**blocked for agents** — Tyler-approval error):

```http
PATCH /api/agent/invoices/invoice-id-from-context/payments
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "paymentId": "payment-id-from-context",
  "status": "paid",
  "paymentMethod": "stripe",
  "paidAmountCents": 29000,
  "paidAt": "2026-06-02T11:00:00.000Z",
  "externalPaymentId": "corrected-stripe-payment-intent-or-bank-reference",
  "notes": "Corrected from processor balance transaction.",
  "sourceType": "project_source",
  "sourceId": "corrected-project-source-id-from-studio"
}
```

Omit `sourceType` and `sourceId` when correcting settlement amount, paid timestamp, payment method, external id, or notes from the same evidence source; Studio keeps the existing source link on the canonical payment row.

### REST Create Invoice Checkout

Use this when an agent needs a Stripe-hosted checkout link for a canonical open invoice installment. The endpoint creates or reuses the Stripe Checkout Session for that invoice payment, stores the checkout URL/session id on the canonical `invoice_payments` row, and logs `invoice.checkout_session_created` with agent attribution. It does not mark the payment paid; Stripe webhook settlement is the canonical payment-recording path.

```http
POST /api/agent/invoices/invoice-id-from-context/payments/payment-id-from-context/checkout
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

Response:

```json
{
  "checkout": {
    "invoiceId": "invoice-id-from-context",
    "projectId": "project-id-from-studio",
    "paymentId": "payment-id-from-context",
    "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
    "checkoutSessionId": "cs_test_...",
    "checkoutStatus": "link_ready",
    "clientPayableOpenCents": 72030,
    "reused": false
  }
}
```

### REST Log Invoice Reminder

Use this after the agent drafts or performs a manual invoice follow-up. Studio logs the reminder as `invoice.reminder_logged_by_agent`, returns `activityLogId` for task completion output, and does not send the reminder.

```http
POST /api/agent/invoices/invoice-id-from-context/reminders
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "paymentId": "payment-id-from-context",
  "channel": "email",
  "note": "Drafted final balance follow-up for Tyler to send.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

### REST Scheduler Meeting Types

Read active scheduler meeting types and booking URLs for agent handoff. Add `projectId` and optional linked `clientId` to receive signed project-scoped booking links. Add `includeInactive=true` only for audit/admin workflows.

```http
GET /api/agent/scheduler/meeting-types?projectId=project-id-from-studio&clientId=client-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
```

### REST Record Scheduler Booking Payment

> **Blocked for agents.** Returns Tyler-approval error. Draft reconciliation as a task instead.

```http
POST /api/agent/scheduler/bookings/booking-id-from-context/payment
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "paid",
  "paymentMethod": "stripe",
  "paidAmountCents": 25000,
  "paidAt": "2026-05-29T13:00:00.000Z",
  "externalPaymentId": "stripe-payment-intent-or-bank-reference",
  "notes": "Recorded from scheduler checkout receipt.",
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

Correct an existing scheduler booking payment row (**blocked for agents** — Tyler-approval error):

```http
PATCH /api/agent/scheduler/bookings/booking-id-from-context/payment
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "status": "paid",
  "paymentMethod": "stripe",
  "paidAmountCents": 24000,
  "paidAt": "2026-05-29T13:30:00.000Z",
  "externalPaymentId": "corrected-stripe-payment-intent-or-bank-reference",
  "notes": "Corrected from scheduler checkout settlement."
}
```

Omit `sourceType` and `sourceId` when correcting settlement amount, paid timestamp, payment method, external id, or notes from the same evidence source; Studio keeps the existing source link on the canonical booking payment row.

### REST Create Expense

Use this for trusted agents that need to write project costs from receipt or bookkeeping intake without using MCP. The endpoint uses the same canonical expense creation path as MCP, including vendor canonization, same-project source validation, source-link persistence, and `expense.created_by_agent` activity logging.

```http
POST /api/agent/projects/project-id-from-studio/expenses
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "vendorName": "Canon Professional Services",
  "category": "equipment",
  "description": "Lens calibration from receipt intake.",
  "amountCents": 12500,
  "status": "paid",
  "paidAt": "2026-05-11",
  "paymentMethod": "amex",
  "externalPaymentId": "card-charge-or-bank-reference",
  "receiptUrl": "r2://receipts/example.pdf",
  "taxDeductible": true,
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

To correct an existing expense instead of creating a duplicate, call:

```http
PATCH /api/agent/projects/project-id-from-studio/expenses?id=expense-id-from-studio
Authorization: Bearer <STUDIO_AGENT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "vendorName": "B&H Photo",
  "category": "equipment rental",
  "description": "Corrected receipt from OCR review.",
  "amountCents": 13500,
  "status": "paid",
  "paidAt": "2026-05-13",
  "paymentMethod": "visa",
  "externalPaymentId": "corrected-card-charge-reference",
  "receiptUrl": "r2://receipts/example-corrected.pdf",
  "taxDeductible": true,
  "sourceType": "project_source",
  "sourceId": "project-source-id-from-studio"
}
```

Returns:

```json
{
  "projectContext": {
    "project": {},
    "clients": [],
    "events": [],
    "locations": [],
    "timelineItems": [],
    "questionnaireResponses": [
      {
        "id": "questionnaire-response-id",
        "questionnaireTitle": "Timeline Questionnaire",
        "status": "submitted",
        "sourceType": "questionnaire_response",
        "sourceId": "questionnaire-response-id",
        "answers": [
          {
            "title": "Timeline notes",
            "formattedValue": "Family formals after first look."
          }
        ]
      }
    ],
    "schedulerBookings": [
      {
        "id": "booking-id-from-context",
        "meetingTypeName": "Paid Consultation",
        "paymentStatus": "paid",
        "paidAmountCents": 25000,
        "clientFeeCents": 755,
        "processingFeeCents": 755,
        "grossCollectedCents": 25755,
        "netDepositCents": 25000,
        "externalPaymentId": "stripe-payment-intent-or-bank-reference",
        "paymentSourceType": "project_source",
        "paymentSourceId": "project-source-id-from-studio"
      }
    ],
    "proposals": [
      {
        "id": "proposal-id-from-context",
        "title": "Discovery Call Proposal",
        "status": "draft",
        "totalCents": 900000,
        "lineItems": [
          {
            "name": "Wedding photography coverage",
            "quantity": 1,
            "unitPriceCents": 900000,
            "totalCents": 900000,
            "isOptional": false
          }
        ],
        "selectedOptionalLineItems": [
          {
            "name": "Engagement session",
            "quantity": 1,
            "unitPriceCents": 120000,
            "totalCents": 120000,
            "isOptional": false
          }
        ],
        "signatureEvidence": {
          "selectedOptionalLineItemIds": ["proposal-line-item-id"]
        }
      }
    ],
    "invoices": [
      {
        "invoiceNumber": "INV-20260529-EXAMPLE",
        "clientPayableCents": 926130,
        "clientPayableBalanceCents": 648270,
        "paymentNotes": "Pay by card or Zelle.",
        "acceptedPaymentMethods": [
          {
            "key": "stripe",
            "displayName": "Credit card",
            "passFees": true
          },
          {
            "key": "zelle",
            "displayName": "Zelle",
            "instructions": "hello@bythereeses.com"
          }
        ],
        "stripePaymentLink": "https://pay.stripe.com/example",
        "zelleInfo": "hello@bythereeses.com",
        "paymentSummary": {
          "scheduledCents": 900000,
          "paidCents": 270000,
          "grossCollectedCents": 277860,
          "clientFeeCents": 7860,
          "processingFeeCents": 7860,
          "netDepositCents": 270000,
          "openCents": 630000
        },
        "payments": []
      }
    ],
    "expenses": [
      {
        "vendorName": "Canon Professional Services",
        "category": "equipment",
        "description": "Lens calibration",
        "amountCents": 12500,
        "status": "paid",
        "paidAt": "2026-05-11"
      }
    ]
  }
}
```
