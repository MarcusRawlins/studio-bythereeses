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
| Client‑initiated Stripe Checkout mint | `createInvoicePaymentCheckoutSession` | `src/lib/stripe-checkout.ts:159` | **Reuse verbatim** for the money‑moving portion (`mode=payment`, one‑time, `customer_email`, service/fee split, metadata). Reuses a `link_ready` session (`:201`), throws for `paid`/`waived`/`refunded` (`:195`). Additive, **non‑money** changes only (§4.3): optional return‑URL override; a **conditional `link_ready` CAS write + canonical re‑read** (fixes the concurrent double‑mint, Finding 1 — the reuse read↔write at `:201`↔`:250‑255` has no lock and D1 has no transactions); and **expire‑and‑remint** when a reused session carries the wrong (admin `/portal`) return URLs (Finding 3). None touch `mode`/`line_items`/`unit_amount`/`customer_email`/`metadata`. |
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
                        │  (conditional link_ready CAS write, then RE-READ the row — §4.3/§6)
                        │
                        ├── success → 303 → the STORED canonical `stripeCheckoutUrl`
                        │                    (NEVER the in-flight `session.url`; converges all racers
                        │                     onto ONE session — mirrors how /portal serves the stored URL)
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

**Submit‑disable / pending state (required — double‑POST defense, Finding 1).** The sign form is a
plain POST with **no** pending guard today (`ClientProposalExperience.tsx:406‑438`). On submit, the
button **must** disable itself and enter a pending state (e.g. React `useFormStatus`/`pending`, or a
one‑shot `onSubmit` that sets `disabled`), so a double‑click cannot fire two concurrent accept POSTs.
This is a client‑side latency guard only; the **server‑side** convergence (§4.3 canonical CAS + stored
URL re‑read) is the authoritative no‑double‑session guarantee. Both ship together (task #6 + task #4/5).

## 3. Retainer‑selection rule (exact) + edge cases

New helper `resolveProposalRetainerCheckout(proposalId)` in `src/lib/sales.ts` (server‑only), sourced
**entirely** from the token's own proposal — never from request input:

1. Load the proposal's linked invoices (`invoices.proposalId = proposalId`, `status ∉ {void}`) and
   their `invoicePayments` — the same relation `getProposalPackageByToken` already reads
   (`sales.ts:1223‑1235`). Call this **ALL payments** (the full set on those invoices — settled or not).
2. **Identify the ONE retainer** with the *shared* predicate `isRetainerPayment(payment, ALL payments)`
   (`stripe-refund-initiation.ts:137‑139`) — **do NOT fork it and do NOT restrict its `allPayments`
   argument to the payable subset.** The retainer is:
   - the labeled retainer if any payment satisfies `isRetainerPaymentLabel(label)` (`sales.ts:104`); else
   - the **earliest of ALL payments** by `earliestPaymentId(ALL payments)` (min `dueDate` NULLS LAST,
     tie‑break `createdAt`, tie‑break `id`) — computed over **all** payments, **not** the payable subset.
3. **Payability gate on that single pick** (never on a different payment):
   - If the identified retainer is **payable** (`invoicePaymentOpenCents(retainer) > 0`, which is `0`
     for `paid`/`waived`/`refunded` via `isSettledInvoicePaymentStatus`, `invoice-balances.ts:66`) →
     return `{ invoiceId, paymentId, clientPayableOpenCents }` for it.
   - If the identified retainer is **settled** (`open == 0`) → return **`null`** (skip → confirmation),
     **even when later installments are still open.** We NEVER fall through to a later installment.
4. Return **`null`** if there are no payments at all.

**Why this exact shape (Finding 2).** The predicate's `allPayments` argument determines *which* payment
is the retainer. Computing `earliestPaymentId` over only the *payable* subset forks the predicate: once
the true retainer is paid and only the final balance remains, the payable subset's "earliest" becomes
the **final balance**, and the flow would 303 the client into Checkout for the ENTIRE remaining balance
under a "Pay retainer $X" button, months early. Identifying the retainer over ALL payments first, then
gating that single pick on payability, makes "retainer already paid ⇒ null (skip)" hold regardless of
what else is open. Extract the ordering + `isRetainerPayment` predicate into the shared exported helper
so this selector and the refund module use **one** definition (Active‑Learning: "factor the shared
helper, don't fork the predicate").

### 3.1 Edge cases

| Case | Behavior |
| --- | --- |
| **Multi‑installment schedule** | Identify the retainer/first installment over ALL payments (§3 step 2), pay **only** that one. Remaining installments are untouched and stay payable from `/portal`. We never mint or charge the later installments here. |
| **Single lump‑sum (one payment = full total)** | It is the earliest of ALL payments → identified → payable → client pays it in full as the "retainer" (a pay‑in‑full deposit). Correct. |
| **Deposit vs full** | Only ever the one identified retainer is checked out. The balance is never auto‑charged (that would be Phase 13 off‑session). |
| **Retainer already paid, final balance still OPEN** | The retainer is identified over ALL payments (§3 step 2), found **settled** → selector returns `null` → skip payment. We do **NOT** fall through to the still‑open final balance and do **NOT** mint "Pay retainer $X" for the whole balance. `page.tsx` computes all‑payable‑settled server‑side and, if so, renders the booked state; otherwise `?accepted=1` (signed; remaining installments payable from `/portal`). No second charge. See §5.6. |
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
  const base = proposalBaseUrl().replace(/\/$/, "");  // MINOR 4: proposalBaseUrl() must be EXPORTED
  const session = await createInvoicePaymentCheckoutSession(retainer.invoiceId, retainer.paymentId, {
    actorType: "client",
    actorName: signature.signerName,
    returnUrls: {
      successUrl: `${base}/proposal/${token}?booked=1`,
      cancelUrl:  `${base}/proposal/${token}?accepted=1&checkout=cancelled`,
    },
  });
  // Finding 1: `session.checkoutUrl` is the STORED canonical URL — the mint does the conditional
  // link_ready CAS write and RE-READS the row before returning (§4.3), so concurrent racers all
  // receive and redirect to the SAME session URL. Never redirect to a raw in-flight `session.url`.
  return NextResponse.redirect(session.checkoutUrl, 303); // canonical Stripe checkout URL, one flow
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

**MINOR 4 — `proposalBaseUrl()` is currently private** (`sales.ts:80`, a bare `function`, not
exported). The pseudocode above does not compile until it is **exported** (`export function
proposalBaseUrl()`), OR the route constructs the base inline from the same envs
(`process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000"`).
Prefer exporting so there is one definition. Task #5 includes this export.

### 4.3 `createInvoicePaymentCheckoutSession` — additive, non‑money changes (+ concurrency & reuse hardening)

**(a) Additive `returnUrls` override.** Add an **optional** `returnUrls?: { successUrl: string;
cancelUrl: string }` to the existing `activityOptions` param object. Default = today's
`/portal?checkout=success|cancelled…` strings (`stripe-checkout.ts:234‑235`), so **every existing
caller is byte‑identical**. When provided, use them for `success_url`/`cancel_url`. This changes
**only** the return routing — `mode`, `line_items`, `unit_amount`, `customer_email`, and all
`metadata` are untouched, so **no money‑moving code is added or altered**. Guard against open‑redirect
by asserting each override URL `startsWith(appBaseUrl())` (server‑constructed from constants + the
path token, but the assertion is cheap defense‑in‑depth).

**(b) Concurrency: conditional CAS write + canonical re‑read (Finding 1 — BLOCKER).** Today there is
**no lock/CAS** between the reuse read (`:201`) and the `link_ready` write (`:250‑255`), and D1 has no
transactions. Two concurrent accepts both pass the reuse check while `stripeCheckoutStatus` is `null`,
both mint, and produce **two** live Stripe sessions; last DB write wins as canonical, and a client who
pays the non‑canonical one is charged with the payment never recorded (`settleInvoicePaymentCheckoutSession`
THROWS at `:312‑314`, and `checkout.session.expired` THROWS at `:477‑479`) → retainer stays open →
double collection. Fix, both parts:
  1. Make the `link_ready` write a **conditional single statement**:
     `UPDATE invoicePayments SET stripeCheckoutSessionId=?, stripeCheckoutUrl=?, stripeCheckoutStatus='link_ready', updatedAt=? WHERE id=? AND (stripeCheckoutSessionId IS NULL OR stripeCheckoutSessionId=?)`
     so only the **first** racer's session is stored; a losing racer's write no‑ops.
  2. **Immediately RE‑READ** the payment row and return the **stored** `stripeCheckoutUrl` /
     `stripeCheckoutSessionId` as `checkoutUrl`/`checkoutSessionId` — **never** the local in‑flight
     `session.url`. Every racer therefore returns and redirects to the **one** canonical session
     (mirrors how `/portal` only ever serves the stored URL). The loser's freshly‑minted Stripe session
     is simply never handed to a browser; it later `checkout.session.expired`s harmlessly (its
     `stripeCheckoutSessionId` is not the stored one, so that expired‑webhook path is the no‑op branch,
     not the throw branch — because the canonical row's `stripeCheckoutSessionId` never matched it).
     Combined with the client‑side submit‑disable (§2.4) this closes the double‑charge path.
  For a single (non‑concurrent) caller — every existing installment mint — the CAS `WHERE` is
  satisfied (`stripeCheckoutSessionId IS NULL` on a fresh mint) and the re‑read returns exactly the URL
  just written, so the returned value and all side effects are **byte‑identical** to today; the CAS is
  purely a concurrency‑safety refinement, not a behavior change.

**(c) Reuse with DIFFERENT return URLs: expire‑and‑remint (Finding 3 — MAJOR).** The reuse branch
(`:201`, already `link_ready`) currently returns the prior URL unchanged. But a pre‑existing
`link_ready` session at first client sign was minted by the **admin/agent/MCP** (only they mint today)
with `success_url=/portal?checkout=success` (`:234`) — the client has **no portal session**, so paying
it returns them to the `/portal` "Open a secure portal link from Tyler" lock wall (`portal/page.tsx:24‑45`)
seconds after paying. That is the exact failure §7 says the override prevents, on a **common** path
(admin pre‑mints links before sending the proposal). So the old "a reused session means the client
already had a live checkout" rationale is **false and removed.** Fix: on the reuse branch, when
`returnUrls` is provided **and** the stored session was minted with **different** return URLs (compare
the stored session's `success_url`/`cancel_url`, or a persisted marker, against the requested override):
  - **EXPIRE** the stored Stripe session (`POST /v1/checkout/sessions/{id}/expire`) — Stripe sessions
    are immutable, so we cannot mutate its return URLs; expiring makes the old one **uncompletable**.
  - Then fall through to a **fresh mint** with the client return URLs (reusing all the money fields).
  Because the old session is expired first, this can **NOT** create two payable sessions — it composes
  with (b)'s canonical‑converge (the fresh mint's conditional write + re‑read still applies). When the
  stored session's return URLs already **match** the requested override (e.g. the resume‑CTA re‑POST,
  §4.4), reuse it verbatim as today — no expire, no re‑mint. When `returnUrls` is **not** provided
  (every existing installment caller), the reuse branch is unchanged and byte‑identical.

This section changes **only** return routing, session lifecycle (expire of a session that carries the
WRONG return URLs), and the concurrency write shape — `mode`, `line_items`, `unit_amount`,
`customer_email`, and all `metadata` remain untouched, so **no money‑moving code is added or altered**;
expiring a session moves **no** money (it is the opposite — it renders a session uncompletable).

### 4.4 Confirmation UI (`ClientProposalExperience.tsx` / `proposal/[token]/page.tsx`)

- `page.tsx`: extend `searchParams` with `booked?: string` and `checkout?: string`; pass through.
  Also compute server‑side (from the already‑loaded `data.invoices[].payments` via the §3 selector):
  `retainerDueCents` (the identified retainer's `clientPayableOpenCents`, `0` when settled),
  `allPayableSettled` (no payment on a non‑void invoice has `invoicePaymentOpenCents > 0`), the
  recorded `signerName` (for the resume CTA below), and `unifiedSignPay = unifiedSignPayEnabled()`.
  Pass them as props.
- `ClientProposalExperience`:
  - `?booked=1` **OR** (`isSigned ∧ allPayableSettled`) → render "**Signed ✓ Paid ✓ — you're booked.**"
    success panel (optimistic — see §5.3). Computing `allPayableSettled` server‑side is what lets an
    all‑settled re‑visit render the booked state **without** relying on a `?booked=1` query param the
    route never emits on that path (Finding 5).
  - **Resume‑to‑pay CTA (Finding 6).** Render a prominent **"Pay retainer $X"** button whenever
    **`unifiedSignPay ∧ isSigned ∧ retainerDueCents > 0`** — **NOT** only on `?checkout=cancelled`.
    A client returning days later after their session `expired` (which clears `link_ready`, hiding the
    `/portal` + invoice‑step pay links) otherwise has **no** client‑visible way to pay; `retainerDueCents`
    is already computed, so this closes the resumability gap for free. The `?checkout=cancelled` copy
    ("**Signed ✓** — your retainer of `$X` is still due") is just the highlighted variant of the same CTA.
  - **The resume CTA re‑POSTs the accept form and MUST carry the hidden fields the route re‑validates
    (Finding 6).** The signed proposal no longer renders the sign form (`!isSigned` gate,
    `ClientProposalExperience.tsx:405`), and the accept route validates **before** the idempotent
    short‑circuit: `normalizeProposalSignature` rejects unless `signatureName` is non‑empty **and**
    `signatureConsent === "on"` (`proposal-client-experience.ts:91‑93`). So the CTA is its **own** POST
    form to `/api/proposal/{token}/accept` with hidden inputs: `signatureName = <recorded signerName>`,
    `signatureConsent = "on"` (and `signatureEmail` if available). Without these the re‑POST 303s to
    `?signature=signature_name_required` instead of re‑entering the checkout chain. It is idempotent
    (no double‑sign; `acceptProposalByToken` short‑circuits), re‑enters the §2.2 chain, and — via §4.3(b/c)
    — converges on the one canonical session (or expire‑and‑reminted client‑return‑URL session), so **no
    double charge**.
  - Contract submit button label per §2.4, **with submit‑disable/pending** on both the sign form and
    the resume CTA form (§2.4, Finding 1).
  - Everything else unchanged; with the flag off none of these branches are reachable
    (`?booked` never emitted, `unifiedSignPay` false so no resume CTA, label stays "Sign and accept proposal").

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
6. **All‑settled case (confirmation routing — Finding 5).** The route emits **only** `?accepted=1` on
   the null‑selector path (it never emits `?booked=1` there — that param is set **only** by Stripe's
   `success_url` after a live payment). So the "you're booked" state on a settled re‑visit is driven
   **server‑side**, not by a query param: `page.tsx` computes `allPayableSettled` (§4.4) and, when a
   signed proposal has nothing payable left, `ClientProposalExperience` renders the booked panel
   regardless of the incoming param. Standardized confirmation routing:
   - retainer just paid (external return) → `?booked=1` → booked panel (optimistic, §5.3);
   - signed, retainer settled, nothing else payable, any later re‑visit → `?accepted=1` +
     `allPayableSettled` computed true → booked panel;
   - signed, retainer settled, later installments still open → `?accepted=1` + `allPayableSettled`
     false → "signed; remaining installments payable from `/portal`" (no retainer CTA, since
     `retainerDueCents == 0`).
   No re‑mint on any of these. There is **no `§5.4`** anywhere in this spec — earlier drafts' `§5.4`
   references were dangling and now point here (`§5.6`).

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
  `signed‑unpaid` with the retainer due. The client resumes via the resume‑to‑pay CTA (rendered
  whenever `signed ∧ retainerDueCents > 0`, §4.4 Finding 6 — not only after a cancel) or from
  `/portal` — either hits the same canonical session. If the session `expired` (clearing `link_ready`
  and hiding `/portal`/invoice pay links), the resume CTA re‑POST re‑mints a fresh canonical session.
- **Concurrent double‑POST (Finding 1 — corrected).** The prior claim ("the second reuses the first's
  `link_ready` session") was **false**: with no CAS between the reuse read (`:201`) and the write
  (`:250‑255`) and no D1 transaction, two simultaneous POSTs both see `stripeCheckoutStatus === null`,
  both mint, producing TWO live Stripe sessions — last write wins as canonical, and paying the
  non‑canonical one strands the charge (settle throws `:312‑314`; expired throws `:477‑479`) → double
  collection. **Corrected guarantee:** the mint's `link_ready` write is a **conditional single‑statement
  CAS** (`WHERE stripeCheckoutSessionId IS NULL OR = ?`) and the function **re‑reads and returns the
  stored canonical URL** (§4.3(b)); both racers therefore redirect to the **one** canonical session, and
  the loser's session is never handed to a browser (it expires via the no‑op branch, not the throw
  branch). The client‑side submit‑disable (§2.4) is the first line of defense; the server CAS + canonical
  re‑read is the authoritative one. Exactly one canonical, payable session per retainer.

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
- **`/portal` mismatch avoided (incl. admin‑pre‑minted sessions — Finding 3):** the client on
  `/proposal/[token]` has **no** portal session, so the default `/portal?checkout=success` lands on
  the "Open a secure portal link from Tyler" wall (`portal/page.tsx:24‑45`). The `returnUrls` override
  routes back to the token surface instead. Critically, a `link_ready` session that already exists at
  first client sign was minted by the **admin/agent/MCP** (only they mint today) with the **`/portal`**
  return URLs — so naive reuse would drop a paying client onto the wall seconds after paying. §4.3(c)
  therefore **expires** any stored session whose return URLs differ from the client override and
  **re‑mints** with the token‑surface return URLs (Stripe sessions are immutable; expiring the old one
  guarantees no second payable session). A UX correctness fix, not a security widening — no bypass list
  changes, and the money fields are identical.
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
- No labeled retainer, multiple payments → returns the **earliest of ALL payments** (dueDate NULLS LAST, then createdAt, then id).
- Single lump‑sum → returns that payment.
- Retainer already `paid` → returns `null`.
- **Retainer PAID + final balance OPEN (Finding 2 — the regression this fix prevents):** identify the
  retainer over ALL payments, find it settled → selector returns **`null`** (skip → confirmation). It
  must **NOT** fall through to the open final balance and must **NOT** return the whole remaining
  balance. Assert `null` even though a later installment is payable.
- **Predicate not forked:** the retainer is identified with `isRetainerPayment(payment, ALL payments)`
  over the full payment set; assert the pick is unchanged when only later installments are settled/open.
- `$0` / no invoice / no payments → returns `null`.
- Payment on a `void` invoice excluded.
- **IDOR:** two proposals with distinct invoices — selector for proposal A never returns proposal B's payment.

### 9.3 Accept route — flag OFF (unchanged)
- POST with valid signature → 303 to `/proposal/{token}?accepted=1`; **zero** `api.stripe.com` calls.

### 9.4 Accept route — flag ON, retainer due
- Valid signature → 303 to the **stored canonical** checkout URL (the re‑read `stripeCheckoutUrl`, not
  the raw in‑flight `session.url`); exactly **one** checkout‑session create call;
  `success_url` = `…/proposal/{token}?booked=1`, `cancel_url` = `…?accepted=1&checkout=cancelled`;
  `metadata.payment_id` = the retainer.

### 9.5 Flag ON, no retainer ($0 / all settled)
- Valid signature → 303 to `?accepted=1`; **zero** Stripe calls.

### 9.6 Abandon‑at‑checkout resumability + resume‑CTA payload (Finding 6)
- Sign (flag on) → session minted; simulate no webhook (payment stays open) → proposal `signedAt`
  set, retainer still open. Re‑POST accept **with the resume‑CTA payload** (hidden `signatureName` =
  recorded `signerName`, `signatureConsent="on"`) → **reuses** the same canonical session (no second
  create call, return URLs already match); `signedAt` unchanged (no double‑sign).
- **Resume CTA render conditions:** props with `unifiedSignPay ∧ isSigned ∧ retainerDueCents > 0`
  render the "Pay retainer $X" CTA even with **no** `?checkout=cancelled` param (a days‑later revisit
  after `expired` cleared `link_ready`). With `retainerDueCents == 0` the CTA is absent.
- **Resume CTA validation guard:** a re‑POST **missing** `signatureConsent="on"` (or blank name) 303s
  to `?signature=signature_name_required` and mints **zero** Stripe sessions (documents that the CTA
  must carry the hidden fields).

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

### 9.12 Concurrent accept → exactly one canonical session (Finding 1 — BLOCKER)
- Fire **two** concurrent accept POSTs for the same freshly‑signable proposal (both observe
  `stripeCheckoutStatus === null`). Assert: **both** redirects land on the **SAME** session URL; the
  stored `stripeCheckoutSessionId` is a single canonical value; the losing racer's `link_ready` write
  no‑ops (conditional CAS `WHERE stripeCheckoutSessionId IS NULL OR = ?`). If a second Stripe session
  was minted, assert it is **not** the stored/canonical one and that redirecting the browser to the
  **stored** URL (not the in‑flight `session.url`) is what both callers return.
- Follow‑through: settling the canonical session records the payment (no throw); a stray non‑canonical
  session's `checkout.session.expired` hits the **no‑op** branch (not the `:477‑479` throw).

### 9.13 Reuse with different return URLs → expire + re‑mint, no second payable session (Finding 3)
- Seed a `link_ready` session minted by the **admin** with `success_url=/portal?checkout=success`.
  Client signs (flag on) → the flow detects the stored return URLs differ from the token‑surface
  override → **expires** the old Stripe session (assert one `.../expire` call) and **re‑mints** with
  `success_url=…/proposal/{token}?booked=1`. Assert: money fields (`unit_amount`, `mode`,
  `customer_email`, `metadata`) identical to a normal mint; at no point are **two payable** sessions
  live (old one expired before/independent of the new mint); redirect goes to the fresh canonical URL.
- Control: a stored session whose return URLs **already match** the override → reused verbatim, **no**
  expire call, **no** re‑mint.

### 9.14 All‑settled confirmation routing (Finding 5)
- Signed proposal, retainer settled, **nothing** else payable → `page.tsx` computes
  `allPayableSettled = true` → `ClientProposalExperience` renders the **booked** panel on a plain
  `?accepted=1` visit (no `?booked=1` param required). Assert no re‑mint.
- Signed, retainer settled, later installment **open** → `allPayableSettled = false`,
  `retainerDueCents == 0` → "signed; installments payable from /portal", **no** retainer CTA, no mint.

## 10. Ordered task breakdown (effort / risk)

| # | Task | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| 1 | `unifiedSignPayEnabled()` flag helper + test (§9.1) | XS | Low | Copy `refundInitiationEnabled` shape; strict `=== "1"`, body read. |
| 2 | Factor shared retainer predicate `isRetainerPayment(payment, ALL payments)` so selector + refund module share one definition (**Finding 2** — do not fork; `allPayments` is the FULL set) | S | Low | Export `earliestPaymentId`/`isRetainerPayment` (or a thin wrapper); no behavior change. |
| 3 | `resolveProposalRetainerCheckout(proposalId)` in `sales.ts` + tests (§9.2): identify retainer over ALL payments, gate payability on that single pick, `null` when settled even if later installments open (**Finding 2**) | S | Low | Pure selection over already‑loaded relations; server‑only; no request input. |
| 4 | `createInvoicePaymentCheckoutSession`: additive `returnUrls` + open‑redirect guard; **conditional link_ready CAS write + canonical re‑read** (**Finding 1**); **expire‑and‑remint on differing return URLs** (**Finding 3**) + tests (§9.9/§9.12/§9.13) | M | **High** | Touches the money‑mint file — assert money fields byte‑identical; default preserves all callers; concurrency + session lifecycle are the double‑charge close. |
| 5 | Flag‑gated tail in accept route (resolve → mint → redirect to STORED canonical URL; fallbacks) + **export `proposalBaseUrl`** (**Minor 4**) + tests (§9.3‑9.8, 9.11) | M | **Med** | Signature commits before mint; catch‑all falls back to `?accepted=1`. Awaited mint (no `waitUntil`). Redirect uses `session.checkoutUrl` (canonical), never in‑flight `session.url`. |
| 6 | UI: `?booked`/`?checkout` params, `retainerDueCents`/`allPayableSettled`/`signerName`/`unifiedSignPay` props, confirmation + all‑settled booked panels, **resume‑to‑pay CTA with hidden `signatureName`/`signatureConsent="on"` and render‑when‑`signed ∧ due` conditions** (**Finding 6**), CTA label, **submit‑disable/pending on both forms** (**Finding 1**) (§2.4/§4.4/§5.6) | M | Low | Pending state is a client‑side latency guard; server CAS is authoritative. Unreachable with flag off. |
| 7 | Verify: build **exit code 0**, lint, full test run; manual dark walkthrough (flag off = unchanged) | S | Low | Build‑exit‑code gate is the hard pass/fail. |

**Total ≈ 1.5–2 days.** Highest‑risk item is #4 (edits the money‑mint file **and** adds the
concurrency CAS + session‑expire lifecycle — mitigated by the byte‑identical‑money‑fields test, the
concurrent‑accept → one‑session test (§9.12), and the expire‑remint test (§9.13)); then #5 (redirect
chaining — mitigated by commit‑signature‑first + catch‑all fallback + no‑double‑charge tests).

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
- **D1 note (no transactions — the concurrency risk, Finding 1):** D1 has no multi‑statement
  transactions, and the mint's reuse read (`:201`) and `link_ready` write (`:250‑255`) are **not**
  atomic — so two concurrent accepts can each pass the `null` reuse check and both mint. The fix does
  **not** rely on a transaction: it uses a **single‑statement conditional CAS**
  (`UPDATE … WHERE stripeCheckoutSessionId IS NULL OR = ?`, atomic in D1) plus a **canonical re‑read**
  so all racers converge on one stored session URL (§4.3(b)/§6). The rest of the flow stays per‑object
  convergent (`INSERT ON CONFLICT`/idempotent settle in the unchanged webhook path). Beyond the CAS
  shape and an optional `.../expire` call on a wrong‑return‑URL reuse (Finding 3), this spec adds no new
  writes beyond the existing `acceptProposalByToken` + mint side‑effects.
```

## 12. Changelog

### Rev 2 (Fable spec‑review)

Each fix mapped to its finding; verified against the cited code as amended.

| Finding | Sev | Fix in this rev |
| --- | --- | --- |
| **1** — concurrent double‑POST → two live sessions → stranded charge → double collection (no CAS between reuse read `:201` and `link_ready` write `:250‑255`; no D1 txn; sign form has no submit‑disable, `ClientProposalExperience.tsx:406‑438`; non‑canonical settle throws `:312‑314`, expired throws `:477‑479`) | **BLOCKER** | §4.3(b): conditional single‑statement `link_ready` **CAS** (`WHERE stripeCheckoutSessionId IS NULL OR = ?`) + **re‑read**, return/redirect to the **stored canonical** `stripeCheckoutUrl`, never the in‑flight `session.url` — all racers converge on one session. §2.4/§6/task #6: **submit‑disable/pending** on the sign (and resume) form. New test §9.12: two concurrent accepts → same session URL, one canonical. Diagram §2.2, §6, §11 D1 note, §1 reuse‑map updated. |
| **2** — retainer selector forked the predicate (label ∪ earliest over the PAYABLE set) → with retainer paid + final balance open, charged the ENTIRE balance under "Pay retainer $X" (contradicts §3.1 / §5.6 / `isRetainerPayment` computing over ALL payments, `stripe-refund-initiation.ts:137‑139`) | **MAJOR** | §3: identify the retainer with `isRetainerPayment(payment, **ALL** payments)`; gate payability on **that single pick**; return `null` (skip) when it is settled **even if later installments are open** — never fall through. §3.1 row 4 rewritten; §9.2 adds "retainer paid + final open → null". |
| **3** — reuse‑branch premise false: an admin‑pre‑minted `link_ready` session carries `/portal?checkout=success` (`:234`); reusing it drops a paying client on the `/portal` lock wall (`portal/page.tsx:24‑45`) | **MAJOR** | §4.3(c): when `returnUrls` provided AND stored session's return URLs differ → **expire** the old Stripe session (immutable → uncompletable, so no second payable session) and **re‑mint** with client return URLs; composes with Finding 1's canonical‑converge. False "client already had a live checkout" rationale removed (§4.3, §7). New test §9.13. |
| **4** — `proposalBaseUrl()` is private (`sales.ts:80`); §4.2 pseudocode didn't compile | MINOR | §4.2: **export** `proposalBaseUrl` (or build the base inline from the same envs); task #5 includes the export. |
| **5** — dangling `§5.4` refs; false "all‑settled re‑POST lands on `?booked=1`" (route only emits `?accepted=1` on the null path) | MINOR | §5.6 standardized: route emits `?accepted=1` on null; `page.tsx` computes `allPayableSettled` **server‑side** and renders the booked panel without a param. `§5.4` refs repointed to `§5.6`; §3.1 row 4 aligned. New test §9.14. |
| **6** — resume CTA payload + render conditions: signed proposal drops the sign form (`!isSigned`, `:405`); route validates before the idempotent short‑circuit (`normalizeProposalSignature` needs name + `consent==="on"`, `proposal-client-experience.ts:91‑93`); `expired` clears `link_ready`, hiding portal/invoice pay links | MINOR | §4.4: resume CTA is its own POST with hidden `signatureName` (recorded `signerName`) + `signatureConsent="on"`; render whenever **`unifiedSignPay ∧ isSigned ∧ retainerDueCents > 0`**, not only on `?checkout=cancelled`. §9.6 extended. |

**Invariants preserved:** money‑boundary framing unchanged (client‑initiated Checkout, **not**
money‑movement‑gated; no charge/refund API added — expiring a session moves no money); flag‑off path
**byte‑identical** (§2.3/§8); existing installment callers of `createInvoicePaymentCheckoutSession`
**byte‑identical** (default `returnUrls`, single‑caller CAS is a no‑behavior‑change refinement, §4.3(b)).
