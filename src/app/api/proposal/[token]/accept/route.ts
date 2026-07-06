import { acceptProposalByToken, proposalBaseUrl, resolveProposalRetainerCheckout } from "@/lib/sales";
import { normalizeProposalSignature, proposalSignatureConsentText, proposalSignatureConsentVersion } from "@/lib/proposal-client-experience";
import { unifiedSignPayEnabled } from "@/lib/finance-flags";
import { createInvoicePaymentCheckoutSession } from "@/lib/stripe-checkout";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lastUsedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = request.headers.get("user-agent")?.trim() || null;
  const formData = await request.formData();
  const signature = normalizeProposalSignature({
    signerName: formData.get("signatureName")?.toString(),
    signerEmail: formData.get("signatureEmail")?.toString(),
    consent: formData.get("signatureConsent")?.toString(),
  });

  if (!signature.ok) {
    return NextResponse.redirect(new URL(`/proposal/${token}?signature=${signature.error}`, request.url), 303);
  }

  const selectedOptionalLineItemIds = formData
    .getAll("selectedOptionalLineItemId")
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const result = await acceptProposalByToken(token, lastUsedIp, {
    signerName: signature.signerName,
    signerEmail: signature.signerEmail,
    selectedOptionalLineItemIds,
    userAgent,
    consentText: proposalSignatureConsentText,
    consentVersion: proposalSignatureConsentVersion,
  });

  if (!result) {
    return NextResponse.json({ error: "Proposal link is invalid, expired, or unavailable." }, { status: 404 });
  }

  // Flag OFF ⇒ byte-identical to today: sign → confirmation, pay via existing per-installment links.
  if (!unifiedSignPayEnabled()) {
    return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
  }

  // Flag ON: the signature is already committed by acceptProposalByToken (BEFORE the mint), so any
  // mint failure below leaves a valid signature + a still-due retainer (resumable). The retainer's
  // invoice/payment ids derive ONLY from the token's own proposal (no request input → no IDOR).
  try {
    const retainer = await resolveProposalRetainerCheckout(result.proposalId);
    if (!retainer) {
      // No payable retainer ($0 / already paid / no schedule) → skip to the signed confirmation.
      return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
    }
    const base = proposalBaseUrl().replace(/\/$/, "");
    const session = await createInvoicePaymentCheckoutSession(retainer.invoiceId, retainer.paymentId, {
      actorType: "client",
      actorName: signature.signerName,
      returnUrls: {
        successUrl: `${base}/proposal/${token}?booked=1`,
        cancelUrl: `${base}/proposal/${token}?accepted=1&checkout=cancelled`,
      },
    });
    // session.checkoutUrl is the STORED canonical URL (the mint does the conditional link_ready CAS
    // write + re-read), so concurrent racers all redirect to the SAME session — never a raw
    // in-flight session.url.
    return NextResponse.redirect(session.checkoutUrl, 303);
  } catch (err) {
    console.error("Unified sign&pay checkout mint failed; signature stands", err);
    return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
  }
}
