import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createInvoicePaymentCheckoutSession } from "@/lib/stripe-checkout";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  try {
    const { id, paymentId } = await params;
    const result = await createInvoicePaymentCheckoutSession(id, paymentId);
    return NextResponse.redirect(
      new URL(`/invoices/${result.invoiceId}?saved=checkout#payment-${encodeURIComponent(result.paymentId)}`, request.url),
      303,
    );
  } catch (error) {
    console.error("Invoice checkout session creation failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice checkout session creation failed." },
      { status: 400 },
    );
  }
}
