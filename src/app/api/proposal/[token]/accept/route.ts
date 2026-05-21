import { acceptProposalByToken } from "@/lib/sales";
import { normalizeProposalSignature } from "@/lib/proposal-client-experience";
import { NextResponse } from "next/server";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lastUsedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
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
  });

  if (!result) {
    return NextResponse.json({ error: "Proposal link is invalid, expired, or unavailable." }, { status: 404 });
  }

  return NextResponse.redirect(new URL(`/proposal/${token}?accepted=1`, request.url), 303);
}
