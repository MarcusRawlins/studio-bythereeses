# Roadmap

## Phase 1: Projects + Portal

- Project/client CRUD.
- Magic-link portal.
- Activity log.
- Local SQLite and D1-shaped migrations.

## Phase 2: Proposals, Contracts, Invoices

- Proposal templates and versions.
- Native contract fields and signatures.
- Stripe invoices and payment schedules.
- Manual Zelle/Venmo payment instructions.

## Phase 3: Questionnaires

- Questionnaire templates.
- Client responses.
- Timeline, family formal list, shot list, and blog intake outputs.

## Phase 4: Scheduling

- Google Calendar connection.
- Availability rules.
- Booking links.
- Static Zoom link first, Zoom API later if needed.

## Phase 5: MCP

- Admin-only MCP tools and resources.
- Narrow, auditable actions only.

---

## Delivery status (as of 2026-07-04)

Phases 1–5 are **built and in production**. See [`qa-production-workflows-2026-07-04.md`](qa-production-workflows-2026-07-04.md) for the latest QA + security pass (0 critical/0 high; medium/low booking-hardening fixes landed on branch `claude/reese-crm-production-qa-4caxz0`).

Phases 6–10 below are **planned, not yet built**. They are sequenced by client-facing value × revenue proximity and by dependency order (Phase 6 unblocks Phase 7). Each phase is independently shippable and builds on existing modules (portal, `project-workflow-automation`, agent/MCP, finance ledger) — none is a rewrite. No Phase 6–10 work merges to `main` or deploys without explicit human (Tyler) approval; AI review runs on Fable before any phase branch is proposed.

## Phase 6: Hardening + R2 private access (prerequisite)

- Close deferred security items: signed proxy header for in-app admin authz (M4), `Referrer-Policy` on `/proposal/**` (L7), CSP `script-src` via Next.js nonce (L8), finance dead-code cleanup.
- Ops drills: D1 restore drill, agent-token rotation + "who has access" inventory.
- **R2 private object access** for files and generated PDFs — prerequisite for galleries.

## Phase 7: Client galleries + image delivery (integration-first)

Decision (2026-07-04): **integrate an existing gallery/delivery tool** (Pixieset / Pic-Time / Cloudinary) rather than build in-house first — fastest to revenue, proven proofing + print fulfillment. Trade-off accepted: per-image/subscription cost and client images living outside owned data; an in-house R2 build can revisit later.

- Evaluate + select provider; wire delivery links into the client portal and project record.
- Sync gallery status/links into Studio (project record + agent/MCP context) so the assistant can reference and send them.
- Keep R2 private object access (Phase 6) available for any owned-asset needs (contracts, PDFs) independent of the gallery provider.

## Phase 8: Communications engine

- Inbound email capture into the project thread (currently send-only via Resend).
- SMS via Twilio (schema already has `smsOptIn`); all sends stay behind the existing Tyler-approval guard.
- Automated sequences on existing workflow-automation rails: invoice dunning, pre-event timeline nudges, post-delivery review requests.

## Phase 9: Financial completeness

- Stripe refund / dispute / chargeback webhook handling (money-integrity gap today).
- QuickBooks or Xero export/sync.
- Quarterly tax estimates, mileage, 1099 / second-shooter vendor tracking.

## Phase 10: Intelligence + forecasting

- Revenue forecast, booking-conversion rate, lead-source ROI, average-package-value trend, seasonal capacity.
- Agent-driven weekly "state of the business" review over finance/agenda data.

## Phase 11 (future, if the team grows): Multi-user + RBAC

- Scoped roles (bookkeeper, second shooter) on the existing activity-log foundation. Deferred until a real second user exists.
