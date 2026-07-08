// Phase 13 — the new Stripe money-mutation + card-token surface for autopay (task 4). Raw `fetch`
// against api.stripe.com with the pinned `stripe-version` header — NOT the `stripe` npm SDK — mirroring
// stripe-checkout.ts:57-79 byte-for-byte (auth header, stripe-version, x-www-form-urlencoded body,
// stripeErrorMessage cleanup, Idempotency-Key header). The ONLY new POST that CAUSES money to move is
// createOffSessionPaymentIntent (POST /v1/payment_intents). It is called ONLY by the CAS-guarded
// charge engine, with the pinned amount + pinned idempotency key set BEFORE this call.

const STRIPE_API_VERSION = "2026-02-25.clover"; // match stripe-checkout.ts

// Fail-closed secret, never logged — identical to stripe-checkout.ts:17.
function stripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before autopay can move money.");
  return key;
}

function stripeErrorMessage(body: Record<string, unknown>) {
  const error = body.error;
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function stripeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Customer — find-or-create for the project's primary client. Idempotency-Key
// = autopay-cus:<projectId> so a double-click makes ONE customer (§4.1 step 2).
// ---------------------------------------------------------------------------
export async function createStripeCustomer({
  projectId,
  email,
  name,
}: {
  projectId: string;
  email: string;
  name?: string | null;
}): Promise<{ id: string }> {
  const params = new URLSearchParams();
  params.set("email", email);
  if (name && name.trim()) params.set("name", name.trim());
  params.set("metadata[project_id]", projectId);

  const response = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
      "idempotency-key": `autopay-cus:${projectId}`,
    },
    body: params,
  });

  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(stripeErrorMessage(body) ?? "Stripe customer creation failed.");
  }
  const id = stripeString(body.id);
  if (!id) throw new Error("Stripe did not return a customer id.");
  return { id };
}

// ---------------------------------------------------------------------------
// Card capture — a Checkout Session in `mode=setup` (§4.1 step 3): all card entry
// is on Stripe-hosted UI (I4), no client-side Stripe JS beyond the redirect. The
// resulting SetupIntent carries our metadata (via setup_intent_data[metadata]) so
// the setup_intent.succeeded webhook can find the consent row by consent_id.
// ---------------------------------------------------------------------------
export async function createAutopaySetupCheckoutSession({
  customerId,
  projectId,
  consentId,
  successUrl,
  cancelUrl,
}: {
  customerId: string;
  projectId: string;
  consentId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string; setupIntentId: string | null }> {
  const params = new URLSearchParams();
  params.set("mode", "setup");
  params.set("customer", customerId);
  params.set("payment_method_types[0]", "card");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("metadata[project_id]", projectId);
  params.set("metadata[consent_id]", consentId);
  params.set("setup_intent_data[metadata][project_id]", projectId);
  params.set("setup_intent_data[metadata][consent_id]", consentId);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
      "idempotency-key": `autopay-setup:${consentId}`,
    },
    body: params,
  });

  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(stripeErrorMessage(body) ?? "Stripe setup session creation failed.");
  }
  const id = stripeString(body.id);
  const url = stripeString(body.url);
  if (!id || !url) throw new Error("Stripe did not return a setup checkout URL.");
  return { id, url, setupIntentId: stripeString(body.setup_intent) || null };
}

// ---------------------------------------------------------------------------
// The money-moving call (POST /v1/payment_intents, off_session + confirm). Sends
// the ROW's PINNED amount + PINNED idempotency key (materialized in the claiming
// UPDATE before this call). Returns a DISCRIMINATED result:
//   succeeded | requires_action (SCA) | failed (PROVABLE decline — money did NOT move).
// THROWS only on a NETWORK error / 5xx / timeout (AMBIGUOUS — money MAY have moved;
// the engine leaves the row 'charging' TERMINAL-UNKNOWN and never blind-retries, §6.4).
// A provable card decline (402 with error.payment_intent) is NOT a throw — it is a
// definite "no money moved" result the engine can retry with a NEW key.
// ---------------------------------------------------------------------------
export type OffSessionPaymentIntentResult =
  | { outcome: "succeeded"; paymentIntentId: string; stripeStatus: string }
  | { outcome: "requires_action"; paymentIntentId: string | null; stripeStatus: string; declineCode: string | null; code: string | null }
  | { outcome: "failed"; paymentIntentId: string | null; stripeStatus: string | null; declineCode: string | null; code: string | null; message: string | null }
  | { outcome: "other"; paymentIntentId: string | null; stripeStatus: string | null };

export async function createOffSessionPaymentIntent({
  customerId,
  paymentMethodId,
  amountCents,
  currency,
  idempotencyKey,
  metadata,
}: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}): Promise<OffSessionPaymentIntentResult> {
  const params = new URLSearchParams();
  params.set("amount", String(amountCents)); // the ROW's pinned amount, never a re-computed one
  params.set("currency", currency);
  params.set("customer", customerId);
  params.set("payment_method", paymentMethodId);
  params.set("off_session", "true");
  params.set("confirm", "true");
  for (const [key, value] of Object.entries(metadata)) {
    params.set(`metadata[${key}]`, value);
  }

  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
      "idempotency-key": idempotencyKey, // pinned BEFORE this call; dedupes a transport retry within the attempt window
    },
    body: params,
  });

  const body = asObject(await response.json().catch(() => ({})));

  if (!response.ok) {
    // 5xx / server error → AMBIGUOUS. Throw so the engine leaves the row TERMINAL-UNKNOWN.
    if (response.status >= 500) {
      throw new Error(stripeErrorMessage(body) ?? "Stripe payment intent server error.");
    }
    const error = asObject(body.error);
    const code = stripeString(error.code) || null;
    const declineCode = stripeString(error.decline_code) || null;
    const pi = asObject(error.payment_intent);
    const paymentIntentId = stripeString(pi.id) || null;
    const stripeStatus = stripeString(pi.status) || null;
    if (!code && !paymentIntentId) {
      // A non-error, non-OK body with no PI attached is not a provable decline — treat as AMBIGUOUS.
      throw new Error(stripeErrorMessage(body) ?? "Stripe payment intent failed.");
    }
    if (code === "authentication_required") {
      return { outcome: "requires_action", paymentIntentId, stripeStatus: stripeStatus ?? "requires_action", declineCode, code };
    }
    // A provable decline (card_declined, insufficient_funds, expired_card, ...) — money did NOT move.
    return {
      outcome: "failed",
      paymentIntentId,
      stripeStatus,
      declineCode,
      code,
      message: stripeErrorMessage(body),
    };
  }

  const id = stripeString(body.id);
  const status = stripeString(body.status);
  if (id && status === "succeeded") {
    return { outcome: "succeeded", paymentIntentId: id, stripeStatus: status };
  }
  if (id && status === "requires_action") {
    return { outcome: "requires_action", paymentIntentId: id, stripeStatus: status, declineCode: null, code: "authentication_required" };
  }
  // requires_payment_method / processing / other → not a definite success; leave the engine to
  // treat it conservatively (persist the PI id, wait for the webhook / reconcile).
  return { outcome: "other", paymentIntentId: id || null, stripeStatus: status || null };
}

// ---------------------------------------------------------------------------
// GET a PaymentIntent (reconcile a stuck 'charging' row; confirm status after a
// cancel rejection — R-5). Returns null on any failure (caller treats null
// conservatively). GET moves no money.
// ---------------------------------------------------------------------------
export async function getStripePaymentIntent(paymentIntentId: string): Promise<{ id: string; status: string } | null> {
  try {
    const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${stripeSecretKey()}`,
        "stripe-version": STRIPE_API_VERSION,
      },
    });
    if (!response.ok) return null;
    const body = asObject(await response.json().catch(() => ({})));
    const id = stripeString(body.id);
    if (!id) return null;
    return { id, status: stripeString(body.status) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cancel a still-cancelable PaymentIntent before the manual fallback (MINOR-2) so
// no residual completion path can later double-charge. THROWS on non-OK (the
// engine inspects the rejection: if the PI just SUCCEEDED it converges instead of
// minting a manual link — R-5).
// ---------------------------------------------------------------------------
export async function cancelStripePaymentIntent(paymentIntentId: string): Promise<void> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
    },
  });
  if (!response.ok) {
    const body = asObject(await response.json().catch(() => ({})));
    throw new Error(stripeErrorMessage(body) ?? "Stripe payment intent cancel failed.");
  }
}

// ---------------------------------------------------------------------------
// Best-effort detach on revoke (§4.3) — the token is gone provider-side too.
// Never throws into the caller (revoke succeeds locally regardless).
// ---------------------------------------------------------------------------
export async function detachStripePaymentMethod(paymentMethodId: string): Promise<void> {
  try {
    await fetch(`https://api.stripe.com/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stripeSecretKey()}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": STRIPE_API_VERSION,
      },
    });
  } catch {
    // Best-effort: a failed detach does not block local revocation.
  }
}
