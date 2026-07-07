import { recordJobRun } from "@/lib/job-runs";
import {
  handleStripeCheckoutWebhook,
  StripeWebhookSignatureError,
  verifyStripeWebhookPayload,
} from "@/lib/stripe-checkout";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("stripe-signature");

  // Phase 21 signature-reject carve-out (spec §2.3, MAJOR 1). This route is in origin-guard
  // PUBLIC_API_PREFIXES, so on *.workers.dev it is reachable UNAUTHENTICATED by any scanner.
  // A pre-verification reject (missing/invalid signature, or an unconfigured webhook secret)
  // must NOT increment the `stripe-webhook` CRITICAL counter, or three junk POSTs would fire a
  // false "money state drift" email (attacker-triggerable cry-wolf). We verify FIRST, OUTSIDE
  // the recorded region: a pre-verify throw returns 400 recorded ONLY under the separate,
  // NON-ALERTING `stripe-webhook-rejected` key (kept out of the CRITICAL catalog).
  try {
    verifyStripeWebhookPayload({ rawBody, signatureHeader });
  } catch (error) {
    await recordJobRun(
      "stripe-webhook-rejected",
      false,
      error instanceof Error ? error.message : "Stripe signature rejected.",
    );
    if (error instanceof StripeWebhookSignatureError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Non-signature pre-verify failure (e.g. STRIPE_WEBHOOK_SECRET unset) — still unrecorded
    // against the CRITICAL counter (not attacker-triggerable, and surfaced by config checks).
    console.error("Stripe webhook pre-verification failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe webhook failed." },
      { status: 400 },
    );
  }

  // Signature verified. A throw from HERE is a REAL processing failure on a legitimate event
  // (settle/refund/dispute not landing = money state drift) and DOES count toward
  // `stripe-webhook` consecutive_failures, which can legitimately escalate to CRITICAL. The
  // heartbeat is additive: recording a failure still returns the same non-2xx as before.
  try {
    const result = await handleStripeCheckoutWebhook(rawBody, signatureHeader);
    await recordJobRun("stripe-webhook", true);
    return NextResponse.json({ received: true, result });
  } catch (error) {
    console.error("Stripe webhook failed", error);
    // Double-verify edge (MINOR): handleStripeCheckoutWebhook RE-verifies the signature. A legit
    // event at the 300s tolerance boundary can pass the route pre-verify above yet fail this
    // re-verify — that throw is a StripeWebhookSignatureError, a signature REJECT, NOT a
    // money-state-drift processing failure. Classify it to the non-alerting 'stripe-webhook-
    // rejected' key so it never poisons the CRITICAL 'stripe-webhook' counter.
    if (error instanceof StripeWebhookSignatureError) {
      await recordJobRun("stripe-webhook-rejected", false, error.message);
    } else {
      await recordJobRun("stripe-webhook", false, error instanceof Error ? error.message : "Stripe webhook failed.");
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe webhook failed." },
      { status: 400 },
    );
  }
}
