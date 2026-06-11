export type ProposalPreviewLineItem = {
  id?: string;
  name: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  isOptional?: boolean | null;
};

export const proposalSignatureConsentVersion = "proposal-signature-v1";
export const proposalSignatureConsentText = "I agree that typing my name above signs the contract electronically and accepts this proposal package.";

export type ProposalClientSection = "welcome" | "proposal" | "invoice" | "contract";

export function normalizeProposalSection(value: string | null | undefined): ProposalClientSection | null {
  if (value === "welcome" || value === "proposal" || value === "invoice" || value === "contract") {
    return value;
  }
  return null;
}

function lineItemTotalCents(item: ProposalPreviewLineItem) {
  return Math.max(item.quantity, 1) * Math.max(item.unitPriceCents, 0);
}

function lineItemsTotalCents(items: ProposalPreviewLineItem[]) {
  return items.reduce((sum, item) => sum + lineItemTotalCents(item), 0);
}

export function buildSelectedProposalPackage({
  lineItems,
  selectedOptionalLineItemIds,
}: {
  lineItems: ProposalPreviewLineItem[];
  selectedOptionalLineItemIds: string[];
}) {
  const selectedIds = new Set(selectedOptionalLineItemIds);
  const includedItems = lineItems.filter((item) => !item.isOptional);
  const optionalItems = lineItems.filter((item) => item.isOptional);
  const selectedOptionalItems = optionalItems.filter((item) => item.id && selectedIds.has(item.id));
  const declinedOptionalItems = optionalItems.filter((item) => !item.id || !selectedIds.has(item.id));
  const includedTotalCents = lineItemsTotalCents(includedItems);
  const selectedOptionalTotalCents = lineItemsTotalCents(selectedOptionalItems);

  return {
    includedItems,
    optionalItems,
    selectedOptionalItems,
    declinedOptionalItems,
    includedTotalCents,
    selectedOptionalTotalCents,
    totalCents: includedTotalCents + selectedOptionalTotalCents,
  };
}

export function buildProposalInvoicePreview({
  totalCents,
  scopeSummary,
  lineItems,
  selectedOptionalLineItemIds = [],
}: {
  totalCents: number | null;
  scopeSummary: string | null;
  lineItems: ProposalPreviewLineItem[];
  selectedOptionalLineItemIds?: string[];
}) {
  const selectedPackage = buildSelectedProposalPackage({ lineItems, selectedOptionalLineItemIds });
  const selectedOptionalItems = selectedPackage.selectedOptionalItems;

  return {
    totalCents: selectedOptionalLineItemIds.length ? selectedPackage.totalCents : totalCents ?? selectedPackage.includedTotalCents,
    includedItems: selectedPackage.includedItems,
    optionalItems: selectedPackage.optionalItems,
    selectedOptionalItems,
    scopeSummary,
    scheduleNote: "A formal invoice and payment schedule will be generated from this proposal package.",
  };
}

export function normalizeProposalSignature({
  signerName,
  signerEmail,
  consent,
}: {
  signerName: string | null | undefined;
  signerEmail: string | null | undefined;
  consent: string | null | undefined;
}):
  | { ok: true; signerName: string; signerEmail: string | null }
  | { ok: false; error: "signature_name_required" | "signature_consent_required" } {
  const normalizedName = String(signerName ?? "").trim().replace(/\s+/g, " ");
  if (!normalizedName) return { ok: false, error: "signature_name_required" };
  if (consent !== "on") return { ok: false, error: "signature_consent_required" };

  const normalizedEmail = String(signerEmail ?? "").trim().toLowerCase() || null;
  return { ok: true, signerName: normalizedName, signerEmail: normalizedEmail };
}
