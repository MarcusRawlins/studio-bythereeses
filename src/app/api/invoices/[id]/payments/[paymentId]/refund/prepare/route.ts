import { refundInitiationEnabled } from "@/lib/finance-flags";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { prepareInvoicePaymentRefund } from "@/lib/stripe-refund-initiation";
import { NextResponse } from "next/server";

// Phase 9b — admin-only refund PREPARE. Mints a pending refund_initiations row and returns
// the SERVICE-basis maxRefundable prefill. MOVES NO money (that is the /execute route). This
// route is NEVER added to any origin-guard bypass list and is NOT reachable from /api/agent/*.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  // Hard money gate before anything else (§8). Flag off ⇒ 403, no refund_initiations row.
  if (!refundInitiationEnabled()) {
    return NextResponse.json({ error: "Refund initiation is disabled." }, { status: 403 });
  }

  try {
    const { id, paymentId } = await params;
    const result = await prepareInvoicePaymentRefund({
      invoiceId: id,
      paymentId,
      actorType: "admin",
      actorName: "Tyler Reese",
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Refund prepare failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refund prepare failed." },
      { status: 400 },
    );
  }
}
