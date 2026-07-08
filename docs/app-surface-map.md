# App surface map — every screen, by host

This document is a walk-through checklist for you to capture change requests against the live site. Every route below maps directly to a URL path on either studio.bythereeses.com (admin) or schedule.bythereeses.com (public booking/portal). When you're planning work, navigate to the actual page, compare it against this table, and note the exact route name in your request. Routes marked with "(verify)" below are inferred from code structure; confirm the public/admin status on the live site if you're unsure.

---

## Public site: schedule.bythereeses.com

| Route | Screen name | What it's for | Host |
|-------|-----------|--------------|------|
| `/book/:slug` | Booking calendar | Select date and time to book a discovery call or meeting type (e.g., engagement session, wedding consultation) | schedule.bythereeses.com |
| `/book/:slug?date=YYYY-MM-DD&start=...&end=...` | Booking details form | Enter your name, email, phone, and custom questions before confirming a meeting | schedule.bythereeses.com |
| `/book/:slug/confirmed?booking=ID` | Booking confirmation | Thank you page with meeting details, calendar link, and instructions after successful booking | schedule.bythereeses.com |
| `/book/:slug/manage?token=...` | Manage booking | Reschedule or cancel an existing booking using a secure token from email | schedule.bythereeses.com |
| `/questionnaires/:id/preview?context=...` | Questionnaire preview | Answer a client intake questionnaire (e.g., wedding details, timeline, family list) | schedule.bythereeses.com |
| `/questionnaires/:id/confirmed?context=...` | Questionnaire confirmed | Thank you page after submitting a questionnaire, with next-step links | schedule.bythereeses.com |
| `/portal/login` | Portal login | Request a magic link to access your project portal by email | schedule.bythereeses.com |
| `/portal` or `/p/:token` | Client portal | Secure project dashboard showing timeline, photos, galleries, invoices, and proposal (requires token or magic link) | schedule.bythereeses.com |
| `/proposal/:token` | Proposal view | View and sign proposal, review package details, pricing, and next steps (requires secure token) | schedule.bythereeses.com |

---

## Admin app: studio.bythereeses.com

| Route | Screen name | What it's for | Host |
|-------|-----------|--------------|------|
| `/` | Dashboard (Command center) | Overview of all active projects, KPIs (booked value, open sales, active projects), upcoming weddings, this week's tasks, and calendar items | studio.bythereeses.com |
| `/activity` | Activity log | Audit trail of all changes to projects, clients, invoices, and system events (filterable by actor: admin, agent, client, system) | studio.bythereeses.com |
| `/agenda` | Agenda | Calendar view of all upcoming sessions, calls, and dated items (filterable by date range and type: weddings, engagements, other sessions, calls) | studio.bythereeses.com |
| `/clients` | Clients list | All clients with contact info, project count, and latest project; searchable and sortable | studio.bythereeses.com |
| `/clients/:id` | Client detail | Single client view with projects, invoices, portal links, communication history | studio.bythereeses.com |
| `/clients/:id/edit` | Edit client | Update client name, email, phone, preferred name, and contact preferences | studio.bythereeses.com |
| `/data-health` | Data health | Scans for incomplete projects, missing required fields, orphaned records; shows repair actions | studio.bythereeses.com |
| `/inbox` | Agent inbox | Queue of automated agent tasks (workflow steps, reminders, email drafts) with status tracking (queued, in-progress, completed, failed) | studio.bythereeses.com |
| `/invoices` | Invoices list | All invoices with status filters (draft, sent, paid, overdue, void); shows outstanding balances | studio.bythereeses.com |
| `/invoices/new` | Create invoice | Generate a new invoice from a project with line items, amounts, and payment method selection | studio.bythereeses.com |
| `/invoices/:id` | Invoice detail | View, edit, and send invoice; manage line items, payment links, and client balance | studio.bythereeses.com |
| `/projects` | Projects list | All projects filtered by stage (inquiry, proposal sent, retainer paid, planning, editing, delivered, completed); searchable and paginated | studio.bythereeses.com |
| `/projects/new` | Create project | New project form with couple names, event date, event type, venue, budget | studio.bythereeses.com |
| `/projects/:id` | Project detail | Complete project hub with sections for overview, communications, sales (proposals/retainer), finances (invoices/payments), questionnaires, timeline, client portal, and activity | studio.bythereeses.com |
| `/projects/:id/edit` | Edit project | Update project metadata (name, date, type, venue, budget, notes) | studio.bythereeses.com |
| `/proposals` | Proposals list | All proposals with status filters (draft, sent, accepted, declined); shows package name and client | studio.bythereeses.com |
| `/proposals/new` | Create proposal | New proposal with package name, description, pricing breakdown, and payment schedule | studio.bythereeses.com |
| `/proposals/:id` | Proposal detail | View, edit, and send proposal package; manage content, pricing, stripe checkout link, client signature/acceptance | studio.bythereeses.com |
| `/questionnaires` | Questionnaires list | All questionnaire templates (wedding timeline, engagement planning, family list, etc.); shows question count and response count | studio.bythereeses.com |
| `/questionnaires/:id` | Questionnaire detail | View and manage questionnaire metadata, questions, and send history | studio.bythereeses.com |
| `/questionnaires/:id/edit` | Questionnaire editor | Add, edit, delete, and reorder questions (text, textarea, select, radio, checkbox) | studio.bythereeses.com |
| `/questionnaires/:id/send` | Send questionnaire | Select client and project context, customize message, and send questionnaire link to client | studio.bythereeses.com |
| `/questionnaires/:id/responses` | Questionnaire responses | All submitted responses to this questionnaire with response status (pending, submitted, reviewed) | studio.bythereeses.com |
| `/questionnaires/:id/responses/:responseId` | Response detail | View submitted answers to questionnaire with option to review or request corrections | studio.bythereeses.com |
| `/questionnaires/:id/responses/:responseId/edit` | Edit response | Edit submitted questionnaire answers (correct missing or incorrect client responses) | studio.bythereeses.com |
| `/shooting-locations` | Shooting locations | Reference list of favorite wedding venues and portrait locations with scouting status and tags | studio.bythereeses.com |
| `/scheduler` | Scheduler (Meeting types) | Configure and manage booking calendar (discovery call, engagement session, etc.); set availability, duration, questions, pricing | studio.bythereeses.com |
| `/scheduler/bookings/:id` | Booking detail | View booking, attendee info, answers to booking questions, and reschedule/cancel history | studio.bythereeses.com |
| `/settings` | Settings | Configure business details (name, email, address), payment methods (Stripe, Zelle, Venmo, cash/check), and defaults | studio.bythereeses.com |
| `/templates` | Templates | Email, questionnaire, contract, and proposal package templates with merge field support | studio.bythereeses.com |
| `/finance` | Finance overview | Payment ledger with status filters (paid, unpaid, pending, refunded, waived); shows missing reconciliation data | studio.bythereeses.com |
| `/finance/intelligence` | Finance intelligence | Revenue forecast, lead source performance, conversion rates, seasonal capacity analysis, and package value trends | studio.bythereeses.com |
| `/finance/tax` | Finance tax | Expense tracking, receipts, and tax-relevant summaries; shows missing payment evidence | studio.bythereeses.com |
| `/system-status` | System status | Health indicators for database backups, payment processing, email delivery, and API availability | studio.bythereeses.com |

---

## API endpoints

The following API groups support the app but are not directly user-facing screens. They are listed by top-level route for reference:

| API group | Purpose |
|-----------|---------|
| `/api/scheduler/*` | Public booking calendar endpoints (check availability, create/reschedule/cancel bookings) |
| `/api/questionnaires/*` | Client questionnaire submission and response endpoints |
| `/api/proposal/*` | Proposal token verification and client experience endpoints |
| `/api/portal/*` | Portal magic-link requests and session management (autopay consent on/off is NOT here — it is a `/portal` server action, Phase 13) |
| `/api/cron/*` | Bearer-authed cron endpoints reached directly over the `*.workers.dev` origin by split workers: `scheduler-reminders`, `sequences`, `systems-monitor`, `heartbeat`, and `autopay-charge` (Phase 13 — hourly off-session installment auto-charge; dark until enabled) |
| `/api/assets/*` | Secure token-authenticated asset serving (photos, PDFs) |
| `/api/google/*` | Google OAuth callbacks for admin login |
| `/api/twilio/*` | Webhook endpoints for inbound SMS and delivery status |
| `/api/email/*` | Email list unsubscribe and email preference endpoints |
| `/api/inbound/*` | Webhook endpoints for inquiry emails and project email replies |
| `/api/agent/*` | MCP-authenticated agent task endpoints (workflow automation) |
| `/api/mcp` | MCP server endpoint for Claude Code integration |

---

**Notes:**
- All studio.bythereeses.com routes require Google login via the admin proxy (`/admin/login`).
- All schedule.bythereeses.com public routes are publicly accessible without authentication (except `/portal`, which uses a token or magic link).
- Routes with parameter notation (`:id`, `:slug`, `:token`) are dynamic; example: `/projects/abc123` or `/book/wedding-photography-discovery-call`.
