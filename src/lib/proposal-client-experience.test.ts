import assert from "node:assert/strict";
import { buildProposalInvoicePreview, buildSelectedProposalPackage, normalizeProposalSection, normalizeProposalSignature } from "./proposal-client-experience";

const preview = buildProposalInvoicePreview({
  totalCents: null,
  scopeSummary: "Wedding day coverage and edited gallery.",
  lineItems: [
    { name: "Wedding day coverage", description: "Six hours of coverage.", quantity: 1, unitPriceCents: 850000, isOptional: false },
    { name: "Engagement session", description: "Optional add-on.", quantity: 1, unitPriceCents: 120000, isOptional: true },
  ],
});

assert.equal(preview.totalCents, 850000);
assert.equal(preview.includedItems.length, 1);
assert.equal(preview.optionalItems.length, 1);
assert.match(preview.scheduleNote, /formal invoice/i);
assert.equal(preview.scopeSummary, "Wedding day coverage and edited gallery.");

const selectedPackage = buildSelectedProposalPackage({
  lineItems: [
    { id: "included-coverage", name: "Wedding day coverage", description: "Six hours of coverage.", quantity: 1, unitPriceCents: 850000, isOptional: false },
    { id: "optional-engagement", name: "Engagement session", description: "Optional add-on.", quantity: 1, unitPriceCents: 120000, isOptional: true },
    { id: "optional-album", name: "Album", description: "Optional add-on.", quantity: 1, unitPriceCents: 50000, isOptional: true },
  ],
  selectedOptionalLineItemIds: ["optional-engagement"],
});

assert.equal(selectedPackage.includedItems.length, 1);
assert.equal(selectedPackage.selectedOptionalItems.length, 1);
assert.equal(selectedPackage.declinedOptionalItems.length, 1);
assert.equal(selectedPackage.totalCents, 970000);

assert.deepEqual(normalizeProposalSignature({ signerName: "  Hanna Richman  ", signerEmail: " HANNA@example.com ", consent: "on" }), {
  ok: true,
  signerName: "Hanna Richman",
  signerEmail: "hanna@example.com",
});

assert.deepEqual(normalizeProposalSignature({ signerName: "", signerEmail: "client@example.com", consent: "on" }), {
  ok: false,
  error: "signature_name_required",
});

assert.deepEqual(normalizeProposalSignature({ signerName: "Hanna Richman", signerEmail: "client@example.com", consent: "" }), {
  ok: false,
  error: "signature_consent_required",
});

assert.equal(normalizeProposalSection("contract"), "contract");
assert.equal(normalizeProposalSection("invoice"), "invoice");
assert.equal(normalizeProposalSection("proposal"), "proposal");
assert.equal(normalizeProposalSection("welcome"), "welcome");
assert.equal(normalizeProposalSection("anything-else"), null);
assert.equal(normalizeProposalSection(undefined), null);

console.log("proposal client experience tests passed");
