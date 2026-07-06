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

## Delivery status (as of 2026-07-05)

Phases 1–5 are **built and in production**. See [`qa-production-workflows-2026-07-04.md`](qa-production-workflows-2026-07-04.md) for the latest QA + security pass (0 critical/0 high; medium/low booking-hardening fixes).

**Phase 6 is DEPLOYED to production (2026-07-05)** on branch `claude/reese-crm-production-qa-4caxz0`. See [`deploy-record-2026-07-05.md`](deploy-record-2026-07-05.md). All 7 tasks Fable-gated; Worker `d1cd7b34` (rollback `b9751424`), Pages-proxy `6d6df58a`, real D1 backup taken pre-deploy, `asset_objects` table applied. **M4 and CSP ship OFF** (`ADMIN_PROOF_ENFORCE`/`CSP_MODE` unset) — zero behavior change until deliberately enabled; R2 storage/serving is live but dark (no consumer mints assets yet). Enable runbook is in the deploy record.

Phases 6.5–10 below are **planned**; 6.5 + 8a specs written and Fable-reviewed (revising per feedback). Sequenced by client-facing value × revenue proximity and dependency order. Each phase is independently shippable and builds on existing modules — none is a rewrite. AI review runs on Fable before merge; enforcement flags (M4/CSP) flip only after observation windows.

## Phase 6: Hardening + R2 private access (prerequisite) — ✅ DEPLOYED 2026-07-05

- ✅ Deferred security items closed: signed proxy header for in-app admin authz (M4, off), `Referrer-Policy` on `/proposal/**` (L7, live), CSP `script-src` via nonce (L8, off/report-capable), finance dead-code cleanup (live).
- ✅ Ops drills: D1 restore-verify (`drill:restore`), agent-token rotation runbook + "who has access" inventory.
- ✅ **R2 private object access** for files and generated PDFs — live (dark), prerequisite for galleries.

## Phase 7: Client galleries + image delivery (integration-first)

Decision (2026-07-04): **integrate an existing gallery/delivery tool** (Pixieset / Pic-Time / Cloudinary) rather than build in-house first — fastest to revenue, proven proofing + print fulfillment. Trade-off accepted: per-image/subscription cost and client images living outside owned data; an in-house R2 build can revisit later.

- Evaluate + select provider; wire delivery links into the client portal and project record.
- Sync gallery status/links into Studio (project record + agent/MCP context) so the assistant can reference and send them.
- Keep R2 private object access (Phase 6) available for any owned-asset needs (contracts, PDFs) independent of the gallery provider.
- ✅ **Phase 7a — provider-agnostic gallery delivery-link MVP** deployed dark (`docs/specs/phase-7a-gallery-delivery-link.md`, migration 0086): `project_galleries` table, https-only URL validation/normalization, admin create/update/delete with `gallery.*` activity logging, always-on (missing-table-resilient) agent/MCP read of all statuses, flag-gated (`PORTAL_GALLERY_ENABLED`, off by default) delivered-only "Your Gallery" portal section, and an optional draft/attach-only agent tool (`studio_attach_gallery_link`) with a guard test. 7b (provider API integration — OAuth, proofing sync, print-store status) remains `🅣`, gated on Tyler's provider choice.

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

- ✅ **Phase 9a — DEPLOYED dark 2026-07-06** (`docs/specs/phase-9a-finance-completeness.md`, migration 0089, Worker `d29fe5c6`): Stripe refund/dispute/chargeback **webhook recording** (extends the existing signature-verified webhook; idempotent via per-object convergence, monotonic out-of-order guards, moves ZERO money), reconciliation surfacing (net-of-refunds, needs-reconciliation queue, unlinked-money-events section), QuickBooks/Xero-compatible accountant CSV export, quarterly tax estimate, 1099 vendor tracking (TIN last4 only), and mileage log — all read/report + guarded admin CRUD, no agent-write. Ships behind `FINANCE_REFUND_RECORDING` (default `record_only`; the `refunded` status transition is gated to `enforce`, Tyler-flipped). Spec Fable-gated ×2 (caught a D1-transaction BLOCKER + a gross-deletion BLOCKER), code Fable-gated ×1. Direct QuickBooks/Xero **API sync** (OAuth journal posting) deferred — needs Tyler's platform choice + credentials.
- 🅣 **Phase 9b — refund INITIATION** (admin-triggered Stripe refund that MOVES money): under the money-movement pause — may be built, but its first live deploy requires Tyler's explicit go.

## Phase 10: Intelligence + forecasting — ✅ DEPLOYED dark 2026-07-06

- ✅ Revenue forecast (contracted facts vs statistical run-rate, cold-start `dataPoints` labeling), booking-conversion (key-set-union inquiry identity, cohort-maturation honesty), lead-source **performance** (refund-adjusted revenue-by-source; true ROI deferred — no ad-spend data captured), average-package-value trend, seasonal capacity — all read-only derived analytics (`src/lib/intelligence.ts`, migration 0090, Worker `1ae4b9cb`). Admin report page `/finance/intelligence` + 5 guarded CSV routes + admin settings; spec Fable-gated ×2, code Fable-gated ×1.
- ✅ Agent-drafted weekly "state of the business" review via the read-only `studio_get_business_review` MCP tool (agent composes prose from the JSON; never auto-sends). A scheduled auto-drafting Worker is **deferred** (specced, not built).
- Moves ZERO money, writes ZERO canonical rows. Settings (forecast horizon/trailing, capacity target, lead-source taxonomy) are admin-entered; safe code defaults when unset.

## Phase 11 (future, if the team grows): Multi-user + RBAC

- Scoped roles (bookkeeper, second shooter) on the existing activity-log foundation. Deferred until a real second user exists.
