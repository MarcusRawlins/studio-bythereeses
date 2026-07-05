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

## Phase 6.5 (near-term, right after Phase 6): Portal self-service magic-link login

Gap found 2026-07-04: the portal's security foundation exists (256-bit scoped tokens, SHA-256 at rest, 30-day httpOnly session, expiry/revocation, no IDOR), but there is **no self-service flow** — portal links are minted by admin/agent and sent manually. Add: a public "enter your email" page that verifies the email matches a project contact, then emails a single-use, short-TTL magic link (reusing the existing scoped-token + Resend infra). Security-sensitive: constant-time no-enumeration response, per-IP + per-email rate limiting, single-use expiring request token. Reuses Phase 6 hardening.

## Phase 8: Communications engine

- **Inquiry-email → project automation** (see decision note below): ingest inbound inquiry emails, create a triage draft + agent-proposed project via the existing `studio_create_project` canonical path, and draft a reply — Tyler approves creation + send. Recommended transport: **Cloudflare Email Routing → Worker → existing agent pipeline** (owned/tested/secure), not an external n8n instance.
- Inbound email capture into the project thread (currently send-only via Resend).
- SMS via Twilio (schema already has `smsOptIn`); all sends stay behind the existing Tyler-approval guard.
- Automated sequences on existing workflow-automation rails: invoice dunning, pre-event timeline nudges, post-delivery review requests.

### Decision note — inquiry-email automation transport (2026-07-04)
Recommendation: build inbound intake **in-house on Cloudflare** rather than an external n8n script holding email + CRM credentials. Rationale: keeps inquiries in the canonical source-of-truth model, keeps email creds + agent token inside Cloudflare secrets (avoids widening the shared-bearer exposure we are actively reducing), reuses the tested agent/MCP + D1 pipeline, and adds no new external attack surface. n8n is fine as a *day-one prototype* to validate parsing/flow, but not as the production path. Guardrail: inbound email creates a **draft/triage inquiry**, not an auto-created live project or auto-sent reply — Tyler approves, matching the existing "agents draft, Tyler sends" guard (spam/mis-parse and brand/deliverability risk otherwise).

## Phase 9: Financial completeness

- Stripe refund / dispute / chargeback webhook handling (money-integrity gap today).
- QuickBooks or Xero export/sync.
- Quarterly tax estimates, mileage, 1099 / second-shooter vendor tracking.

## Phase 10: Intelligence + forecasting

- Revenue forecast, booking-conversion rate, lead-source ROI, average-package-value trend, seasonal capacity.
- Agent-driven weekly "state of the business" review over finance/agenda data.

## Phase 11 (future, if the team grows): Multi-user + RBAC

- Scoped roles (bookkeeper, second shooter) on the existing activity-log foundation. Deferred until a real second user exists.
