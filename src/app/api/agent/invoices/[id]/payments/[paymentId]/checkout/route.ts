import { guardAgentApiRequest } from "@/lib/agent-api";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { createInvoicePaymentCheckoutSession } from "@/lib/stripe-checkout";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; paymentId: string }> },
) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const blockedAgent = await guardAgentApiRequest(request);
  if (blockedAgent) return blockedAgent;

  try {
    const { id, paymentId } = await params;
    const checkout = await createInvoicePaymentCheckoutSession(id, paymentId, {
      actorType: "agent",
      actorName: "The Reeses Studio Agent",
    });
    return NextResponse.json({ checkout }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invoice payment checkout creation failed." },
      { status: 400 },
    );
  }
}
