import { refundInitiationEnabled } from "@/lib/finance-flags";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { initiateInvoicePaymentRefund } from "@/lib/stripe-refund-initiation";
import { NextResponse } from "next/server";

// Phase 9b — admin-only refund EXECUTE. The ONLY route that reaches POST /v1/refunds (MOVES
// REAL MONEY). guardDirectWorkerApiRequest first, then the hard flag gate (both BEFORE any
// Stripe call), then the helper (which re-checks flag + admin + all safety rails server-side).
// This route is NEVER in an origin-guard bypass list and is NOT reachable from /api/agent/*.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  if (!refundInitiationEnabled()) {
    return NextResponse.json({ error: "Refund initiation is disabled." }, { status: 403 });
  }

  try {
    const { id, paymentId } = await params;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

    const result = await initiateInvoicePaymentRefund({
      invoiceId: id,
      paymentId,
      initiationId: typeof body.initiationId === "string" ? body.initiationId : "",
      amountCents: Number(body.amountCents),
      confirmAmountCents: Number(body.confirmAmountCents),
      reason: typeof body.reason === "string" ? body.reason : null,
      serviceNotRenderedConfirmed: body.service_not_rendered_confirmed === true,
      stripeReason: typeof body.stripeReason === "string" ? body.stripeReason : null,
      actorType: "admin",
      actorName: "Tyler Reese",
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Refund execute failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refund execute failed." },
      { status: 400 },
    );
  }
}
