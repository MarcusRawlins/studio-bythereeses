# Phase 12 — Unified accept‑sign‑PAY (fused booking flow)

Status: SPEC (build‑ready). Off‑by‑default flag `UNIFIED_SIGN_PAY`. No new money‑moving code.

## 0. Problem & goal

Today the client booking flow **stops at the signature**. In `ClientProposalExperience`
(`src/components/ClientProposalExperience.tsx`) the client walks Proposal → Invoice → Contract,
types their legal name + checks consent, and POSTs to `/api/proposal/[token]/accept`. That route
calls `acceptProposalByToken` (`src/lib/sales.ts:1278`), which marks the proposal
`accepted`/`signed` and **303‑redirects to `/proposal/${token}?accepted=1`** — a page that just says
"Proposal signed and accepted." **There is no payment step.** To pay the retainer the client must
separately find a per‑installment "Pay this installment" link (rendered in the Invoice step and in
`/portal`, both gated on `stripeCheckoutStatus === "link_ready"`, which only exists after an admin
mints it). That gap — sign here, then go hunt for a payment link — is the #1 booking‑conversion loss
versus HoneyBook/SwiftBooks "accept, sign & pay."

**Goal:** after a successful signature, if a retainer/first installment is due, carry the client
**directly into Stripe Checkout for that retainer** as one continuous flow, returning them to a
"Signed ✓ Paid ✓ — you're booked" confirmation. Reuse the **existing client‑initiated** checkout
mechanism verbatim; add no new charge path; ship behind an OFF flag so today's behavior is unchanged
until enabled.

## 1. What already exists (reuse map — ground truth)

| Concern | Existing symbol | File:line | Reuse |
| --- | --- | --- | --- |
| Sign + accept (idempotent) | `acceptProposalByToken` | `src/lib/sales.ts:1278` | **Unchanged.** Already sets `status="accepted"`, `signedAt`, `contractStatus="signed"`, logs `proposal.signed`, and short‑circuits on an already‑signed proposal (`proposalIsAcceptedOrSigned`, `sales.ts:539/1316`). |
| Accept HTTP route | `POST /api/proposal/[token]/accept` | `src/app/api/proposal/[token]/accept/route.ts` | **Extend the redirect only** (flag‑gated); signing logic untouched. |
| Token → proposal/project/invoices/payments loader | `getProposalPackageByToken` | `src/lib/sales.ts:1196` | Reuse its exact join (token → `proposalId`/`projectId`/`clientId` → linked invoices → payments) as the retainer‑selection source of truth. |
| Client‑initiated Stripe Checkout mint | `createInvoicePaymentCheckoutSession` | `src/lib/stripe-checkout.ts:159` | **Reuse verbatim** for the money‑moving portion (`mode=payment`, one‑time, `customer_email`, service/fee split, metadata). Idempotent: reuses a `link_ready` session (`:201`), throws for `paid`/`waived`/`refunded` (`:195`). One additive, non‑money change: optional return‑URL override (§4.3). |
| Webhook settle → record payment + advance stage | `settleInvoicePaymentCheckoutSession` → `autoAdvanceProjectStageForRetainerPayment` | `src/lib/stripe-checkout.ts:290/432`, `sales.ts:120` | **Unchanged.** Already records the payment and advances stage to `retainer_paid`. The fused flow adds **zero** money‑state logic. |
| Retainer predicate (label arm) | `isRetainerPaymentLabel` | `src/lib/sales.ts:104` | Reuse; do not re‑implement the regex. |
| Retainer predicate (label ∪ earliest) | `earliestPaymentId` / `isRetainerPayment` | `src/lib/stripe-refund-initiation.ts:115/137` | Mirror the exact selection rule (§3); factor the shared helper so the predicate is not forked. |
| Open‑balance helpers | `invoicePaymentOpenCents`, `invoicePaymentClientPayableOpenCents`, `isSettledInvoicePaymentStatus` | `src/lib/invoice-balances.ts:66/75`, `sales.ts` import | Reuse to decide "payable" and to skip settled/`$0` retainers. |
| Public surface classification | `PUBLIC_PAGE_PREFIXES` `/proposal/`, `PUBLIC_API_PREFIXES` `/api/proposal/` | `src/lib/origin-guard.ts:5/11` | **Unchanged.** The accept POST is already public/token‑authed. We add **no new endpoint** and widen **no** bypass list. |
| Flag helper pattern | `refundInitiationEnabled` (strict `=== "1"`, read in body) | `src/lib/finance-flags.ts:47` | Model the new `unifiedSignPayEnabled()` on this exactly. |

## 2. Flow diagram (states + page transitions + URLs)

### 2.1 Client states

```
  unsigned ──sign (valid name+consent)──▶ signed‑unpaid ──retainer paid (Stripe)──▶ signed‑paid (BOOKED)
     │                                        │                                         ▲
     │                                        └── abandon at checkout ───────────┐      │
     │                                            (signature STANDS,             │      │
     │                                             retainer still DUE)           │      │
     └── no retainer due / $0 ───────────────────────────────────────────────────┴──▶ signed (BOOKED, nothing to pay)
```

- **unsigned** — `proposal.signedAt` null.
- **signed‑unpaid** — `signedAt` set; a payable retainer payment exists (`invoicePaymentOpenCents > 0`).
- **signed‑paid (BOOKED)** — retainer payment `status="paid"` (set by the webhook), stage advanced to `retainer_paid` when the label qualifies. Terminal for this flow.
- Signature and payment are **decoupled**: `signedAt` is durable; `retainer_paid` advances only on a recorded *payment* (existing `RETAINER_STAGE_PRECEDENCE`, `sales.ts:91`). Abandoning checkout does not undo the signature.

### 2.2 Page transitions — flag ON, retainer due

```
[Contract step]  POST /api/proposal/{token}/accept
      │            (signatureName + signatureConsent + selectedOptionalLineItemId[])
      ▼
acceptProposalByToken(...)  → commits signature (idempotent)          [SIGNATURE PERSISTED FIRST]
      │
      ▼
resolveProposalRetainerCheckout(proposalId)  → { invoiceId, paymentId } | null
      │
      ├── null (no payable retainer / $0 / already paid)
      │        └── 303 → /proposal/{token}?accepted=1        (signed confirmation; today's page)
      │
      └── { invoiceId, paymentId }
               └── createInvoicePaymentCheckoutSession(invoiceId, paymentId,
                      { actorType:"client", actorName: signerName,
                        returnUrls: { successUrl, cancelUrl } })       [REUSED VERBATIM + §4.3]
                        │
                        ├── success → 303 → Stripe Checkout `session.url`  (EXTERNAL, one flow)
                        │
                        └── mint throws (no client email / Stripe error)
                                 └── 303 → /proposal/{token}?accepted=1   (graceful fallback; resumable)
```

Stripe hosted checkout then routes the browser to one of:

- **success_url** = `{APP_URL}/proposal/{token}?booked=1`
- **cancel_url**  = `{APP_URL}/proposal/{token}?accepted=1&checkout=cancelled`

```
[Stripe Checkout] ── pay ──▶ /proposal/{token}?booked=1
                                   → "Signed ✓ Paid ✓ — you're booked."
                                     (optimistic; see §5.3 — webhook settles async)
                  ── cancel ─▶ /proposal/{token}?accepted=1&checkout=cancelled
                                   → "Signed ✓ — retainer still due" + prominent
                                     "Pay retainer $X" resume CTA
```

Meanwhile, out of band: Stripe → `POST /api/stripe/webhook` → `handleStripeCheckoutWebhook` →
`settleInvoicePaymentCheckoutSession` records the payment, recomputes the invoice, and
`autoAdvanceProjectStageForRetainerPayment` advances the stage. **No change to this path.**

### 2.3 Page transitions — flag OFF (unchanged from today)

```
POST /api/proposal/{token}/accept → acceptProposalByToken → 303 → /proposal/{token}?accepted=1
```

Byte‑identical to current behavior. No mint, no retainer resolution, no Stripe.

### 2.4 Single "Sign & Pay" affordance (copy)

The Contract step's submit button changes label **only when the flag is on and a retainer is due** — computed server‑side and passed as a prop (`unifiedSignPayEnabled && retainerDueCents > 0`):

- Flag on + retainer due: **"Sign & Pay retainer $X"** (one CTA; the redirect chain in §2.2 is the "one continuous flow").
- Flag on + no retainer due, or flag off: **"Sign and accept proposal"** (today's label).

The button still POSTs the same form to the same route; the *route* decides whether to chain into
checkout. No client‑side Stripe code, no client‑supplied invoice/payment ids.

## 3. Retainer‑selection rule (exact) + edge cases

New helper `resolveProposalRetainerCheckout(proposalId)` in `src/lib/sales.ts` (server‑only), sourced
**entirely** from the token's own proposal — never from request input:

1. Load the proposal's linked invoices (`invoices.proposalId = proposalId`) and their
   `invoicePayments` — the same relation `getProposalPackageByToken` already reads (`sales.ts:1223‑1235`).
2. **Payable set** = payments where `invoicePaymentOpenCents(payment) > 0` (this already returns `0`
   for `paid`/`waived`/`refunded` via `isSettledInvoicePaymentStatus`, `invoice-balances.ts:66`), on
   invoices whose `status ∉ {void}`.
3. **Retainer pick** (mirrors `isRetainerPayment` = label ∪ earliest, `stripe-refund-initiation.ts:137`):
   - Prefer payable payments where `isRetainerPaymentLabel(label)` is true (`sales.ts:104`); among
     those, take the **earliest** by `earliestPaymentId` ordering (min `dueDate` NULLS LAST, tie‑break
     `createdAt`, tie‑break `id`).
   - Else fall back to the **earliest payable payment overall** (the earliest arm).
4. Return `{ invoiceId, paymentId, clientPayableOpenCents }` for the pick, or **`null`** if the
   payable set is empty.

Extract the ordering + `isRetainerPayment` predicate into a shared exported helper so this selector
and the refund module use one definition (Active‑Learning: "collapse duplicated predicates into one").

### 3.1 Edge cases

| Case | Behavior |
| --- | --- |
| **Multi‑installment schedule** | Select **only** the retainer/first installment (step 3). Remaining installments are untouched and stay payable from `/portal`. We never mint or charge the later installments here. |
| **Single lump‑sum (one payment = full total)** | It is the earliest → selected → client pays it in full as the "retainer" (a pay‑in‑full deposit). Correct. |
| **Deposit vs full** | Only ever one payment (the retainer) is checked out. The balance is never auto‑charged (that would be Phase 13 off‑session). |
| **Retainer already paid** (`status="paid"`/settled) | Excluded by the payable filter → selector returns `null` → 303 to `?accepted=1` (or `?booked=1` if *all* payable is settled — see §5.4). No second charge. |
| **`$0` / no retainer / no invoice / no payment schedule** | Payable set empty → `null` → skip payment, land on the signed confirmation. Signature alone books a `$0` engagement. |
| **Payment exists but `clientPayableOpenCents ≤ 0`** | `createInvoicePaymentCheckoutSession` itself throws "Checkout can only be created for an open… balance" (`:227`); route catches → `?accepted=1` fallback. |
| **No primary client email** | Mint throws (`stripe-checkout.ts:191`); route catches → `?accepted=1` fallback. Signature stands. |
| **Label is unlabeled first installment (e.g. "Payment 1")** | Selected as the retainer to *pay* (earliest arm), and the payment records normally. **Stage note:** `autoAdvanceProjectStageForRetainerPayment` advances to `retainer_paid` **only** when `isRetainerPaymentLabel(label)` is true (`sales.ts:114`). An unlabeled first installment records the payment but does **not** advance the stage — **identical to today's per‑installment checkout**; the fused flow changes no money‑state logic (§5). Not a regression. The normal split from `createInvoiceFromForm` labels the retainer, so the common case advances. |

## 4. Implementation surfaces

### 4.1 Flag helper (new)

`src/lib/sign-pay-flags.ts` (or append to `finance-flags.ts`), modeled on `refundInitiationEnabled`:

```
export function unifiedSignPayEnabled(env?: { UNIFIED_SIGN_PAY?: string }): boolean {
  return (env ?? process.env).UNIFIED_SIGN_PAY === "1";
}
```

Strict `=== "1"`; unset/`""`/`"0"`/`"true"`/typo → OFF. Read **in the body** (never as a default
param — TS2559, Active‑Learning). A **simple boolean**, not three‑state — there is no observation
window to gate here (no autonomous money movement; the client always initiates).

### 4.2 Accept route (`src/app/api/proposal/[token]/accept/route.ts`)

After the existing `acceptProposalByToken(...)` success (unchanged), add a **flag‑gated tail**:

```
// existing: signature validation, acceptProposalByToken → result
if (!unifiedSignPayEnabled()) {
  return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303); // today
}
try {
  const retainer = await resolveProposalRetainerCheckout(result.proposalId);
  if (!retainer) {
    return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
  }
  const base = proposalBaseUrl().replace(/\/$/, "");
  const session = await createInvoicePaymentCheckoutSession(retainer.invoiceId, retainer.paymentId, {
    actorType: "client",
    actorName: signature.signerName,
    returnUrls: {
      successUrl: `${base}/proposal/${token}?booked=1`,
      cancelUrl:  `${base}/proposal/${token}?accepted=1&checkout=cancelled`,
    },
  });
  return NextResponse.redirect(session.checkoutUrl, 303); // external Stripe URL, one flow
} catch (err) {
  console.error("Unified sign&pay checkout mint failed; signature stands", err);
  return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
}
```

Notes: signature is committed by `acceptProposalByToken` **before** the mint, so any mint failure
leaves a valid signature and a still‑due retainer (resumable). The mint is **awaited** (we need the
URL to redirect) — this is a synchronous request/response, **not** deferred work, so no `waitUntil`
is needed for the critical path (the existing invoice checkout route mints synchronously too). The
`token` never leaves the route; only the route builds the return URLs.

### 4.3 `createInvoicePaymentCheckoutSession` — one additive, non‑money change

Add an **optional** `returnUrls?: { successUrl: string; cancelUrl: string }` to the existing
`activityOptions` param object. Default = today's `/portal?checkout=success|cancelled…` strings
(`stripe-checkout.ts:234‑235`), so **every existing caller is byte‑identical**. When provided,
use them for `success_url`/`cancel_url`. This changes **only** the return routing — `mode`,
`line_items`, `unit_amount`, `customer_email`, and all `metadata` are untouched, so **no
money‑moving code is added or altered**. Guard against open‑redirect by asserting each override URL
`startsWith(appBaseUrl())` (they are server‑constructed from constants + the path token, but the
assertion is cheap defense‑in‑depth). The reuse branch (`:201`, already `link_ready`) returns the
prior URL and does not re‑mint; on that path the override is irrelevant (the session already carries
its return URLs) — acceptable, because a reused session means the client already had a live checkout.

### 4.4 Confirmation UI (`ClientProposalExperience.tsx` / `proposal/[token]/page.tsx`)

- `page.tsx`: extend `searchParams` with `booked?: string` and `checkout?: string`; pass through.
  Also compute `retainerDueCents` server‑side (from the already‑loaded `data.invoices[].payments`
  via the §3 selector) and `unifiedSignPay = unifiedSignPayEnabled()`, pass both as props.
- `ClientProposalExperience`:
  - `?booked=1` → render "**Signed ✓ Paid ✓ — you're booked.**" success panel (optimistic — see §5.3).
  - `?accepted=1&checkout=cancelled` → "**Signed ✓** — your retainer of `$X` is still due" with a
    prominent **"Pay retainer $X"** button that re‑POSTs the accept form (idempotent; re‑enters the
    §2.2 chain and reuses the existing `link_ready` session, so no double charge).
  - Contract submit button label per §2.4.
  - Everything else unchanged; with the flag off none of these branches are reachable
    (`?booked` never emitted, label stays "Sign and accept proposal").

## 5. Money boundary & state (explicit)

1. **This is CLIENT‑INITIATED checkout** — the *same* mechanism as the existing per‑installment
   "Pay this installment" (`createInvoicePaymentCheckoutSession`, `mode=payment`, one‑time). The
   client actively completes Stripe hosted checkout. It does **NOT** autonomously move money — no
   off‑session PaymentIntent, no saved‑card auto‑charge, no scheduled draft (that is **Phase 13**).
2. Therefore it is **NOT under the money‑movement pause** (Autonomous Build Loop guardrail 3, which
   targets *autonomous* charges/refunds). No new code calls a Stripe *charge/refund* API; we only
   mint a Checkout Session the client must complete — exactly what already ships in production for
   installments.
3. **No new money‑state logic.** Recording the payment and advancing the stage are done by the
   **unchanged** `settleInvoicePaymentCheckoutSession` + `autoAdvanceProjectStageForRetainerPayment`
   webhook path. The fused flow only chains the UX and routes the success URL.
4. **Stage:** signature sets `accepted`/`signed`/`contractStatus="signed"`; `retainer_paid` advances
   on the *recorded payment* (webhook), unchanged. Signature and stage remain decoupled per
   `RETAINER_STAGE_PRECEDENCE`.
5. **Async settle race (§5.3):** the `success_url` is reached **before** the webhook necessarily
   fires, so the DB may still show the retainer unpaid at redirect. Stripe only redirects to
   `success_url` after a completed payment, so the confirmation shows "Paid ✓" **optimistically**
   keyed on `?booked=1` — do **not** gate the confirmation copy on the DB `paid` status (it would
   flicker/regress on the webhook race). The webhook reconciles the canonical record within seconds.
6. **All‑settled case:** if a client returns to `?accepted=1` after already paying, the selector
   returns `null` (retainer settled) and the page may show the booked state; no re‑mint.

## 6. Idempotency & no‑double‑charge

- **No double‑sign:** `acceptProposalByToken` already short‑circuits when
  `proposalIsAcceptedOrSigned` (`sales.ts:1316`), returning `{proposalId, projectId}` without
  re‑writing signature fields (`?? now` guards, `:1377‑1385`).
- **No double‑charge:** the retainer is one `invoicePayments` row → one `paymentId`.
  `createInvoicePaymentCheckoutSession` reuses an existing `link_ready` session (`:201`) rather than
  minting a second, and **throws** for `paid`/`waived`/`refunded` (`:195`). A client who already
  signed **and** paid: selector returns `null` (settled) → no mint at all. A replayed
  `checkout.session.completed` is an idempotent no‑op in `settleInvoicePaymentCheckoutSession`
  (`:344`).
- **Resumable, not all‑or‑nothing:** signature commits *before* mint; abandon/cancel leaves
  `signed‑unpaid` with the retainer due. The client resumes via the cancel‑page CTA or from
  `/portal` — either hits the same idempotent session.
- **Concurrent double‑POST:** two simultaneous sign POSTs → one wins the signature; both may call
  the mint, but the second reuses the first's `link_ready` session (no second Stripe session, no
  second charge).

## 7. Security / token analysis

- **Public but token‑authed:** `/proposal/[token]` and `/api/proposal/[token]/accept` are already in
  the origin‑guard public lists (`origin-guard.ts:7,22`). We add **no new endpoint** and touch **no**
  bypass list. The mint runs **inside** the existing accept POST, which already requires a valid,
  unexpired, unrevoked token (`getProposalPackageByToken`/`acceptProposalByToken` reject otherwise,
  `sales.ts:1201/1296`) **and** a valid signature payload — so an unauthenticated caller cannot
  trigger a mint.
- **No IDOR:** `resolveProposalRetainerCheckout` derives invoice/payment **only** from
  `result.proposalId` (from the token) → `invoices.proposalId` → its payments. Request input never
  supplies an invoice or payment id. A token can only ever mint/pay **its own project's** retainer.
  `createInvoicePaymentCheckoutSession` independently re‑verifies `invoiceId`/`paymentId` belong
  together (`:187`).
- **No arbitrary‑invoice payment:** because ids come from the token's proposal, the flow cannot be
  aimed at another project's invoice. The webhook settle also re‑checks metadata `invoice_id`/
  `payment_id` against the row (`stripe-checkout.ts:309‑320`).
- **Return URLs don't leak:** success/cancel URLs carry only the **already‑public** token plus the
  proposal path — no admin origin secret, no portal session, no cross‑project id. The open‑redirect
  assertion (§4.3) keeps them same‑origin.
- **`/portal` mismatch avoided:** the client on `/proposal/[token]` has no portal session, so the
  default `/portal?checkout=success` would land on the "open a secure portal link" wall. The
  override routes back to the token surface instead — a UX fix, not a security widening.
- **No enumeration change:** the accept route's response shape is unchanged for invalid/expired
  tokens (already `404`/redirect); the new branch only runs on a **valid** signed acceptance.

## 8. Rollout & flag

- **Flag:** `UNIFIED_SIGN_PAY`, unset/OFF by default, strict `=== "1"`. Lives beside
  `REFUND_INITIATION_ENABLED` / `SMS_ENABLED` in the Worker env.
- **Deploy dark:** with the flag off, behavior is byte‑identical to today (§2.3). The additive
  `returnUrls` param defaults to the current `/portal` strings, so existing installment checkout is
  unchanged. No migration (no schema change — reuses `proposals`, `invoices`, `invoicePayments`).
- **Enablement is Tyler's** (Autonomous Build Loop guardrail 2): flip `UNIFIED_SIGN_PAY=1` after a
  real end‑to‑end test (sign a live proposal, complete a real/test retainer, confirm the webhook
  advances the stage). Because there is no autonomous money movement, this is a UX enablement, not a
  money‑pause gate — but still a deliberate flip.
- **Rollback:** unset `UNIFIED_SIGN_PAY` — instant revert to sign‑then‑pay with no redeploy. Code
  rollback via the prior Worker version if ever needed (flag‑independent).

## 9. Test plan (tsx; `npm run test` via `scripts/run-tests.mjs`; build‑exit‑code gate)

All tests are `*.test.ts`, `assert/strict`, and **stub `globalThis.fetch`** so a hit to
`api.stripe.com` is counted (as in `sms-guard.test.ts`). Seed a local SQLite DB
(`DATABASE_PATH`) like existing sales/stripe tests.

**Build gate:** `npm run build` and assert **exit code 0** (not a phrase — a type error prints after
"Compiled successfully" and exits 1). `npm run lint` clean. Then `npm run test`.

### 9.1 Flag helper
- `UNIFIED_SIGN_PAY` unset/`""`/`"0"`/`"true"`/`"on"` → `unifiedSignPayEnabled()` false; only `"1"` → true.

### 9.2 Retainer selector `resolveProposalRetainerCheckout`
- Labeled retainer + later installments → returns the retainer; ignores later payments.
- No labeled retainer, multiple payments → returns the **earliest** (dueDate NULLS LAST, then createdAt, then id).
- Single lump‑sum → returns that payment.
- Retainer already `paid` → returns `null`.
- `$0` / no invoice / no payments → returns `null`.
- Payment on a `void` invoice excluded.
- **IDOR:** two proposals with distinct invoices — selector for proposal A never returns proposal B's payment.

### 9.3 Accept route — flag OFF (unchanged)
- POST with valid signature → 303 to `/proposal/{token}?accepted=1`; **zero** `api.stripe.com` calls.

### 9.4 Accept route — flag ON, retainer due
- Valid signature → 303 to the Stripe `session.url`; exactly **one** checkout‑session create call;
  `success_url` = `…/proposal/{token}?booked=1`, `cancel_url` = `…?accepted=1&checkout=cancelled`;
  `metadata.payment_id` = the retainer.

### 9.5 Flag ON, no retainer ($0 / all settled)
- Valid signature → 303 to `?accepted=1`; **zero** Stripe calls.

### 9.6 Abandon‑at‑checkout resumability
- Sign (flag on) → session minted; simulate no webhook (payment stays open) → proposal `signedAt`
  set, retainer still open. Re‑POST accept → **reuses** the same session (no second create call);
  `signedAt` unchanged (no double‑sign).

### 9.7 No‑double‑charge after paid
- Sign → mint → run `settleInvoicePaymentCheckoutSession` (payment→`paid`). Re‑POST accept →
  selector returns `null` → 303 to `?accepted=1`/booked, **zero** new Stripe calls. A replayed
  settle is a no‑op (assert idempotent return).

### 9.8 Mint‑failure fallback (resumable)
- Proposal with no primary client email → sign (flag on) → mint throws → route 303s to `?accepted=1`;
  `signedAt` still set (signature stands).

### 9.9 `returnUrls` additivity (existing caller unchanged)
- Call `createInvoicePaymentCheckoutSession` **without** `returnUrls` → `success_url`/`cancel_url`
  are the exact current `/portal?checkout=success|cancelled…` strings (byte‑for‑byte).
- With `returnUrls` → those exact URLs; `mode=payment`, `unit_amount`, `customer_email`, and all
  `metadata` identical to the no‑override call (assert money fields unchanged).
- Open‑redirect: a `returnUrls.successUrl` off‑origin is rejected.

### 9.10 Stage advance unchanged
- Labeled retainer settled → `autoAdvanceProjectStageForRetainerPayment` advances to `retainer_paid`.
- Unlabeled first installment settled → payment recorded, stage **not** advanced (documents §3.1 parity with today).

### 9.11 Security / no‑IDOR (route level)
- Expired/revoked/invalid token POST → no mint, unchanged 404/redirect; zero Stripe calls.
- The route never reads an invoice/payment id from the form body (assert the selector is called with
  only `proposalId`).

## 10. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | `unifiedSignPayEnabled()` flag helper + test (§9.1) | XS | Low | Copy `refundInitiationEnabled` shape; strict `=== "1"`, body read. |
| 2 | Factor shared retainer predicate (label ∪ earliest) so selector + refund module share one definition | S | Low | Export `earliestPaymentId`/`isRetainerPayment` (or a thin wrapper); no behavior change. |
| 3 | `resolveProposalRetainerCheckout(proposalId)` in `sales.ts` + tests (§9.2) | S | Low | Pure selection over already‑loaded relations; server‑only; no request input. |
| 4 | Additive `returnUrls` on `createInvoicePaymentCheckoutSession` + open‑redirect guard + tests (§9.9) | S | **Med** | Touches the money‑mint file — assert money fields byte‑identical; default preserves all callers. |
| 5 | Flag‑gated tail in accept route (resolve → mint → redirect; fallbacks) + tests (§9.3‑9.8, 9.11) | M | **Med** | Signature commits before mint; catch‑all falls back to `?accepted=1`. Awaited mint (no `waitUntil`). |
| 6 | UI: `?booked`/`?checkout` params, `retainerDueCents`/`unifiedSignPay` props, confirmation panels, CTA label (§2.4/§4.4) | M | Low | Pure presentational; unreachable with flag off. |
| 7 | Verify: build **exit code 0**, lint, full test run; manual dark walkthrough (flag off = unchanged) | S | Low | Build‑exit‑code gate is the hard pass/fail. |

**Total ≈ 1–1.5 days.** Highest‑risk items are #4 (edits the money‑mint file — mitigated by the
byte‑identical‑money‑fields test and the defaulted param) and #5 (redirect chaining — mitigated by
commit‑signature‑first + catch‑all fallback + no‑double‑charge tests).

## 11. Active‑Learning pitfalls — pre‑empted

- **Off‑by‑default flag:** `UNIFIED_SIGN_PAY` strict `=== "1"`, read in the body (no `env={} =
  process.env` default param → avoids TS2559). Flag off ⇒ zero behavior change.
- **No money‑moving code beyond the existing client checkout:** reuse
  `createInvoicePaymentCheckoutSession` verbatim; the only edit is non‑money return‑URL routing. No
  new charge/refund API call. Not under the money‑movement pause.
- **Workers/OpenNext runtime:** the mint is **awaited** in the request path (its URL is the redirect
  target) — not deferred — so no dropped `waitUntil` work. No unawaited post‑response promises.
- **Token / no‑IDOR:** invoice/payment ids derive only from the token's proposal; no request input;
  webhook re‑verifies metadata. No new endpoint; no origin‑guard bypass widened.
- **Build‑exit‑code gate:** CI/verify asserts `npm run build` exit code 0 (a type error exits 1 after
  "Compiled successfully"); tsx tests don't type‑check, so the build step is the type gate.
- **D1 note:** no transactions used; the flow is already per‑object convergent
  (`INSERT ON CONFLICT`/idempotent settle in the unchanged webhook path). This spec adds no new writes
  beyond the existing `acceptProposalByToken` + mint side‑effects.
```
