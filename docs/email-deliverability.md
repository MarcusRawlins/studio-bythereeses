# Email Deliverability Audit

Audit date: 2026-07-07. Scope: everything in this repo that sends real client-facing or owner-facing email through Resend, plus the DNS/provider setup Tyler must verify by hand before ramping up real send volume (booking confirmations/reminders, sequences, and the soon-to-launch two-way project email). Read-only audit — no code was changed by this pass. All line numbers below are current as of this commit; re-check them if `src/lib/email.ts` changes shape.

**Bottom line:** the sending side is architecturally solid — one consistent From address, correct List-Unsubscribe scoping, content-hash-gated sends, fail-closed suppression checks on the two paths that check it. The real gaps are (1) nothing ever feeds Resend bounce/complaint events back into the suppression list even though the schema has a slot for it, (2) one send path duplicates the Resend transport and skips the suppression check, and (3) the DNS/provider side is entirely unverified from the repo — it lives in the Resend dashboard and Cloudflare zone, which this audit cannot query.

---

## 1. Current state — sender inventory

| Sender (function) | From | Reply-To | List-Unsubscribe | Suppression check | Text/HTML | Trigger | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `resendRequest` (private transport primitive) | `RESEND_FROM_EMAIL` env, default `"The Reeses <hello@bythereeses.com>"` | passthrough `headers.replyTo` if given | passthrough `headers` if given | none (caller's job) | text only, no `html` field ever set | n/a (shared plumbing) | `src/lib/email.ts:32-74` |
| `sendProjectEmail` (Phase 14 two-way project thread) | same default | `projectReplyToAddress(projectId)` → `reply+<token>@inbox.bythereeses.com` when `REPLY_TOKEN_SECRET` is set, else omitted | none | done by caller (`sendApprovedProjectEmail`, below) | text only | Tyler clicks "Send" on an approved project-communication draft | Reply-To domain (`inbox.bythereeses.com`) differs from From domain (`bythereeses.com`) — see §1a. `src/lib/email.ts:81-88`; wired at `src/lib/project-communications.ts:638-647` |
| `sendApprovedProjectEmail` (caller of the above) | — | — | — | **yes** — `isEmailSuppressed` at `src/lib/project-communications.ts:617` | — | admin-only send action, `EMAIL_SENDING_ENABLED` gated | Correctly gated; content-hash + recipient-hash binding prevents TOCTOU swaps (`project-communications.ts:596-614`) |
| `sendSequenceEmail` (dunning / pre-event / review) | same default | none set | **yes** — RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`, signed token link + `mailto:` fallback | **yes** — `isEmailSuppressed` at `src/lib/email.ts:138`, before any Resend call | text only, footer appended as plain text (`src/lib/email.ts:149`) | cron-driven sequence runner (`src/lib/sequences.ts:632,733`), or admin draft-send | This is the one path built to spec — correct unsubscribe scoping, correct suppression-before-send ordering. `src/lib/email.ts:128-163` |
| `sendAdminAlertEmail` (Phase 21 ops digest/critical alert) | same default | none | none (correct — transactional, owner-only) | none (recipient is always `ALERT_EMAIL`, never client-derived, so suppression is moot) | text only | daily digest + immediate critical cron | Low risk; single fixed recipient (Tyler). `src/lib/email.ts:172-181` |
| `sendPortalMagicLinkEmail` | same default | none | none (correct — transactional) | none | text only | client requests a portal sign-in link | Low risk, single-use link, short TTL. `src/lib/email.ts:188-213` |
| `sendBookingEmails` (client confirmation + admin notify) | same default | none | none (correct — transactional, tied to a specific booking action) | none | text only | scheduler booking created | Low risk. Failures are swallowed via `Promise.allSettled` (`src/lib/email.ts:250-261`) — not a deliverability issue, but Tyler gets no signal if Resend starts rejecting these. |
| `sendBookingReminderEmail` | same default | none | none (correct — transactional) | none | text only | hourly cron, `src/app/api/cron/scheduler-reminders/route.ts` | Low risk. `src/lib/email.ts:264-287` |
| `sendBookingCancellationEmail` | same default | none | none (correct) | none | text only | booking cancelled | Low risk. `src/lib/email.ts:289-315` |
| `sendInquiryReplyEmail` (inbound-inquiry approve-and-reply) | same default, **re-derived independently** | none | none | **none** — does not call `isEmailSuppressed` | text only | Tyler approves an inbound-inquiry draft reply, `src/lib/inbound-inquiry.ts:691-730` | **Duplicate transport, drifted from the canonical sender.** See §2, fix #2. `src/lib/inbound-inquiry.ts:750-764` |

### 1a. Envelope / From consistency

- **From is genuinely consistent.** Every sender above resolves the same env var, `RESEND_FROM_EMAIL`, and production (`wrangler.jsonc:33`) sets it to `"The Reeses <hello@bythereeses.com>"`. There is one sending identity today — good, this is the single biggest deliverability lever (a stable, consistent From builds domain reputation) and it's already correct.
- **Reply-To mismatch (Phase 14, not yet live).** `src/lib/project-reply-token.ts:25,33-35,89` mints `reply+<token>@inbox.bythereeses.com` — a *subdomain* of the sending domain, not the sending domain itself. This is **not a DMARC/SPF/DKIM alignment problem** (those only ever evaluate the `From` header domain, never `Reply-To`), and because `inbox.bythereeses.com` shares the same organizational domain (`bythereeses.com`) as `hello@`, it reads as "the same business," not a spoofed third party. The residual risk is purely UX/heuristic: a client who notices "sent from hello@, reply goes to a weird inbox@ address" may hesitate, and some corporate secure-email-gateways score From/Reply-To domain mismatches (even same-org ones) slightly. This is an accepted, documented tradeoff per `docs/specs/phase-14-two-way-email.md:130` (the alternative — replying to `hello@` directly — would require parsing arbitrary inbound `hello@` mail for project routing, a much bigger surface). No action needed beyond what's in §3.
- **Rollout-ordering gap worth flagging explicitly:** `projectReplyToAddress` (and therefore the `Reply-To` header) starts firing the moment `REPLY_TOKEN_SECRET` is set (`src/lib/project-communications.ts:638`) — it does **not** check `INBOUND_PROJECT_EMAIL_ENABLED` or whether the `inbox.bythereeses.com` MX/Cloudflare Email Routing rule actually exists yet. If Tyler sets `REPLY_TOKEN_SECRET` before finishing the Phase 14 DNS runbook (`docs/specs/phase-14-two-way-email.md:308-312`), every project email will carry a Reply-To that hard-bounces when a client actually hits "reply." That bounce lands on the *client's* mail server (their MUA telling them "message undeliverable"), not on Reeses' sending reputation directly — but it's a broken, confusing client experience and a support headache. **Set `REPLY_TOKEN_SECRET` only after the `inbox.bythereeses.com` MX + Email Routing rule are live and verified**, not before.

### 1b. List-Unsubscribe (marketing vs. transactional split)

This is correctly split today:
- **Has it (correct):** `sendSequenceEmail` only — dunning, pre-event nudges, review requests (`src/lib/email.ts:144-148`). These are the only recurring, non-request-triggered mail in the system, so RFC 8058 one-click unsubscribe belongs exactly there.
- **Does NOT have it (correct):** booking confirmations/reminders/cancellations, portal magic links, admin alerts, project-thread email. All of these are transactional (triggered by a specific client action or Tyler's direct reply) — attaching an unsubscribe header to transactional mail is itself a deliverability anti-pattern some ISPs flag, so the current omission is the right call, not an oversight.

### 1c. Text vs. HTML

Every single sender in this file sends `text` only — there is no `html` field anywhere in the Resend request bodies (`src/lib/email.ts`, `src/lib/inbound-inquiry.ts:753-762`). This is **not inherently a deliverability problem** — plain-text transactional mail is well-tolerated and sometimes preferred by spam filters over unstyled HTML — but it does mean Tyler is leaving rendering/branding on the table for client-facing mail (booking confirmations, sequences) once volume justifies it. Low priority; not a deliverability risk today.

### 1d. Content quality (inbox placement factors)

Checked all rendered templates in `src/lib/sequences.ts:114-235` and `src/lib/email.ts:215-323`:
- **Personalization:** every template opens with `Hi ${clientFirstName}` / `Hi ${booking.attendeeName}` — good, this is a real spam-score factor.
- **Subjects:** all sentence-case, no ALL-CAPS, no excessive punctuation or spam trigger words ("A gentle reminder about invoice X", "Reminder: {meeting name}", etc.) — good.
- **Body:** no URL-only bodies; every message has substantive prose around any link, and links are always paired with plain-language context ("Reschedule: {url}"). Good.
- **One caution, low stakes:** `buildHealthDigest` (`src/lib/system-health.ts:459-464`) produces subjects like `"Reese CRM Systems: 2 CRITICAL, 1 warning"` — capitalized "CRITICAL" is a stylistic choice for Tyler's own ops inbox, not client-facing, so it's not a real deliverability risk, just noting it was the only near-miss found.

---

## 2. Top 5 prioritized fixes

| # | Fix | Why | Effort |
| --- | --- | --- | --- |
| 1 | **Verify SPF/DKIM/DMARC in the Resend + Cloudflare dashboards before sending real volume.** This audit cannot query DNS from this environment — see the checklist in §3. Nothing else here matters if the domain isn't authenticated. | Foundational; without this, everything else in this doc is moot. | Low (dashboard-only, ~15 min) |
| 2 | **Wire a Resend webhook (`email.bounced`, `email.complained`) into `email_suppressions`.** Today the *only* writer of that table is the one-click unsubscribe route (`src/app/api/email/unsubscribe/route.ts:95-98`, `source: "unsubscribe_link"`). The schema already has a slot for this and nobody fills it — `src/db/schema.ts:788` literally documents `source` as `"unsubscribe_link" | "admin" | "bounce"`, but no code path ever writes `"bounce"`. Without this, a hard-bouncing or complaining address stays in the sequence rotation (`src/lib/sequences.ts:632,733` will keep trying it every run), which is exactly the kind of repeat-send-to-dead-address behavior that tanks sender reputation as volume grows. | Medium (new signed-webhook route + suppression insert, mirrors the existing Twilio/Stripe webhook pattern already in the codebase) |
| 3 | **Consolidate `sendInquiryReplyEmail` (`src/lib/inbound-inquiry.ts:750-764`) into the canonical `resendRequest`/`sendResendEmail` in `src/lib/email.ts`, and add the missing `isEmailSuppressed` check before this send.** This is currently the one outbound path that neither reuses the shared transport nor checks suppression before sending — a client who unsubscribed via a sequence link could still receive an inquiry-reply email at the same address. Low blast radius today (different flows, usually different life-cycle stage) but it's an inconsistency that will bite someone during a future refactor of `email.ts` that this path silently won't inherit. | Low (delete ~15 lines, call the shared helper) |
| 4 | **Don't set `REPLY_TOKEN_SECRET` until `inbox.bythereeses.com`'s MX + Cloudflare Email Routing rule are live and verified** (see §1a rollout-ordering gap). Consider adding a `config-preflight.mjs` check that fails/warns if `REPLY_TOKEN_SECRET` is set but `INBOUND_PROJECT_EMAIL_ENABLED` isn't — cheap insurance against exactly the "silent misconfiguration" class this script already exists to catch (see `scripts/config-preflight.mjs:1-16`). | Prevents a real but low-blast-radius client-facing bounce/confusion once Phase 14 ships. | Low (process discipline now; optional small script addition later) |
| 5 | **Optional — add an HTML multipart alternative for booking confirmations/reminders and sequence email.** Not a deliverability blocker (see §1c) but worth doing once send volume justifies the design investment — plain text is fine for now. | Polish only. | Low–Medium |

---

## 3. DNS / provider checklist (Tyler runs this by hand — this audit cannot query DNS)

Run `npm run config:preflight` first — it already does the one live check this repo can perform: `GET /v1/domains` against Resend and confirms the sending domain derived from `RESEND_FROM_EMAIL` (today: `bythereeses.com`) has `status: "verified"` (`scripts/config-preflight.mjs:225-241,419-435`). Treat everything below as what to check *in the Resend dashboard and Cloudflare DNS zone* directly — never invent record values; copy them exactly from the Resend "Domains" page.

### 3.1 SPF
- Resend's dashboard will give you a TXT record, almost always attached to a dedicated `send.` subdomain it manages (e.g. `send.bythereeses.com`), not the bare apex — this is deliberate on Resend's part specifically so it never collides with an existing MX/SPF setup on your root domain (see §3.4).
  ```
  Type: TXT
  Name: send.bythereeses.com   (copy the exact name Resend shows you)
  Value: v=spf1 include:amazonses.com ~all   (copy the exact value Resend shows you — do not hand-type this from memory)
  ```
- If Resend's dashboard instead shows a record directly on the apex, confirm there isn't already a competing SPF TXT record on `bythereeses.com` — you can only have **one** SPF TXT record per hostname; two will make SPF fail entirely, not "merge."

### 3.2 DKIM
- Resend gives you (typically) 1–3 CNAME records, host names like `resend._domainkey.bythereeses.com` (naming varies by provider version). Add exactly what the dashboard shows.
  ```
  Type: CNAME
  Name: <exact name from Resend dashboard>
  Value: <exact target from Resend dashboard>
  ```
- Confirm `status: verified` for DKIM in the Resend dashboard (and confirm `npm run config:preflight`'s Resend check passes) before sending a real campaign.

### 3.3 DMARC
- Add a DMARC TXT record at `_dmarc.bythereeses.com` (the apex's `_dmarc` subdomain, always — DMARC has no per-subdomain equivalent to SPF/DKIM's per-hostname records at this step).
- **Start permissive, with reporting on:**
  ```
  Type: TXT
  Name: _dmarc.bythereeses.com
  Value: v=DMARC1; p=none; rua=mailto:<an address you can actually read — e.g. hello@bythereeses.com or a dedicated forward>; pct=100
  ```
- `p=none` means "monitor only, take no action on failures" — the safe starting point. Watch the `rua` aggregate reports for a few weeks (most mailbox providers send them daily) to confirm SPF/DKIM are passing and aligned for 100% of your real mail before tightening.
- **Tighten later, once reports show clean alignment:** move to `p=quarantine` (suspicious mail goes to spam) and eventually `p=reject` (suspicious mail is refused outright) — normally a multi-week-to-multi-month glide path, not a same-week change.
- Because `From` is always `hello@bythereeses.com` (the apex), this one DMARC record governs every sender in §1 — you do not need a separate DMARC record for `inbox.bythereeses.com` or `schedule.bythereeses.com` for outbound-authentication purposes (DMARC only ever evaluates the domain in the `From:` header of outbound mail).

### 3.4 MX coexistence — `inbox.bythereeses.com` (Phase 14 inbound) vs. the sending domain
- Today, Cloudflare Email Routing already owns inbound MX for the apex `bythereeses.com` (routing `hello@`, and per `docs/specs/phase-8a-inquiry-email-intake.md:66-67`, `inquiries@`, to Workers/forwards).
- Phase 14 (two-way project email, currently dark — `INBOUND_PROJECT_EMAIL_ENABLED` off) needs its **own** MX + Cloudflare Email Routing catch-all rule on the **subdomain** `inbox.bythereeses.com`, per `docs/specs/phase-14-two-way-email.md:308-309`: add `inbox.bythereeses.com` to Cloudflare Email Routing (MX + verification), then a catch-all rule `*@inbox.bythereeses.com` → **Send to a Worker** → `reese-project-email-inbound`.
- Because `inbox.bythereeses.com` is a distinct hostname from the apex, this MX record **cannot conflict** with the apex's existing inbound routing — DNS MX records are scoped per-hostname, not inherited from the parent domain. The one thing to double check: Resend's own SPF/DKIM setup (§3.1) should land on `send.bythereeses.com` or the apex, never on `inbox.bythereeses.com` — keep those two subdomains' DNS records from ever touching the same hostname.
- Sequencing reminder: don't flip `REPLY_TOKEN_SECRET` on in production until this MX + routing rule are confirmed live (see fix #4 in §2).

### 3.5 Dedicated sending subdomain (e.g. `mail.bythereeses.com`) — is it worth it?
**Recommendation: no, not at solo-photographer volume.** Reasoning:
- Dedicated sending subdomains earn their keep when (a) you're sending high enough volume that a reputation problem on one *type* of mail (e.g. a bad marketing blast) could drag down deliverability for unrelated mail (e.g. transactional receipts) sharing the same domain, or (b) you're sending from multiple distinct products/brands that shouldn't share reputation.
- At Reese Photography's actual volume — booking confirmations for a handful of shoots, a few dunning/pre-event/review sequence emails per active project — there's no meaningfully separable "bulk" stream to isolate. The sequence emails are already the most marketing-like traffic in the system, and they're a tiny fraction of total send volume, well within what one warmed-up domain handles fine.
- A dedicated subdomain also means a second SPF/DKIM/DMARC setup to maintain and a fresh domain reputation to warm up from zero — real ongoing overhead for a benefit that only shows up at meaningfully higher volume or multi-brand sending.
- **Revisit this if:** Reese Photography starts sending genuine bulk/marketing campaigns (a real newsletter, promotional blasts) at a volume where isolating that stream from booking-confirmation deliverability becomes worth the setup cost — not before.

---

## 4. Before you send your first real campaign — 10-minute test plan

Run this once SPF/DKIM/DMARC are verified (§3) and before the first sequence auto-send or real project-email is fired at an actual client address.

1. **Build a seed list.** At minimum: a Gmail address, an Outlook/Microsoft 365 or outlook.com address, and an iCloud address. Add a Yahoo address if you have one — its filtering behaves differently enough to be worth the extra check.
2. **Send one of each real template to every seed address:**
   - A booking confirmation (`sendBookingEmails`) — exercises the plain transactional path.
   - A sequence email if `SEQUENCES_*` flags are on, or trigger a draft manually and send it — exercises the List-Unsubscribe path (RFC 8058 headers).
   - A project-thread email if Phase 14 is live — exercises the Reply-To path.
3. **Check the inbox tab, not just "did it arrive."** Confirm it landed in Primary/Focused inbox, not Spam/Junk or (Gmail) the Promotions tab.
4. **Inspect headers via "Show original" / "View message source":**
   - Gmail: open the message → ⋮ menu → "Show original."
   - Outlook/Microsoft 365 (web): message → ⋯ → "View" → "View message details," or download the `.eml`.
   - iCloud Mail (web): the header-inspection UI is limited — for a full header dump, use Gmail/Outlook as your primary test targets and treat iCloud as an inbox-placement-only check.
   - Confirm: `SPF: PASS`, `DKIM: PASS` (or `'PASS' with domain=bythereeses.com` — the signing domain should match), `DMARC: PASS` (aligned).
5. **Confirm the From line renders as expected** ("The Reeses <hello@bythereeses.com>"), and for a project-thread test, confirm the Reply-To shows the `inbox.bythereeses.com` address and that replying actually reaches the inbound pipeline (only once Phase 14 is live — see §3.4).
6. **On the sequence-email test only:** confirm the List-Unsubscribe header is present (visible in raw headers, and most mail clients surface an "Unsubscribe" affordance next to the sender name when it's there) and that clicking it lands on the confirm page (`GET /api/email/unsubscribe`), not an immediate suppression (that's deliberate — see `src/app/api/email/unsubscribe/route.ts:33-38`).
7. **On the booking-confirmation test only:** confirm there is *no* Unsubscribe affordance shown by the mail client — its presence would mean a List-Unsubscribe header leaked onto transactional mail.
8. **Check rendering on a phone** for at least one template — plain text should still read cleanly, no orphaned raw URLs wrapping awkwardly.
9. **If anything fails SPF/DKIM/DMARC in step 4,** stop — do not proceed to real client sends. Go back to §3, confirm the exact record Resend's dashboard shows matches what's in Cloudflare DNS, and re-run `npm run config:preflight`.
10. **Re-run this whole test plan any time the sending domain, `RESEND_FROM_EMAIL`, or DNS records change** — not just once at launch.

---

## Related docs

- `docs/specs/phase-14-two-way-email.md` — full Phase 14 design, including the `inbox.bythereeses.com` DNS runbook (§6.3) referenced throughout §1a/§3.4 above.
- `docs/specs/phase-8a-inquiry-email-intake.md` — the `inquiries@bythereeses.com` inbound intake this audit references in §3.4.
- `docs/studio-agent-access.md` — deploy/smoke checklist; agent/MCP boundary (agents draft, Tyler sends — relevant context for why every send path above is either cron-driven-and-flag-gated or admin-only).
- `scripts/config-preflight.mjs` — the one live, read-only check this repo can run against the Resend API (§3 above assumes you run this before/after DNS changes).
