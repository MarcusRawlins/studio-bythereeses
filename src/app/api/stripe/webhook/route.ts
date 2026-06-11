import { handleStripeCheckoutWebhook } from "@/lib/stripe-checkout";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const result = await handleStripeCheckoutWebhook(rawBody, request.headers.get("stripe-signature"));
    return NextResponse.json({ received: true, result });
  } catch (error) {
    console.error("Stripe webhook failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe webhook failed." },
      { status: 400 },
    );
  }
}
