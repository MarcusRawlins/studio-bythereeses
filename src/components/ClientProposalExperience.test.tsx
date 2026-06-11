import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientProposalExperience } from "./ClientProposalExperience";

const baseProps = {
  token: "proposal-token",
  clientName: "Avery",
  projectName: "Avery Wedding",
  projectDate: "2026-09-19",
  projectLocation: "The Garden House",
  proposalTitle: "Avery Wedding Proposal",
  packageName: "Heritage Day",
  totalCents: 850000,
  validUntil: "2026-07-01T00:00:00.000Z",
  scopeSummary: "Wedding day coverage.",
  proposalStatus: "viewed",
  acceptedAt: null,
  signedAt: null,
  signerName: null,
  signerEmail: null,
  clientEmail: "avery@example.com",
  acceptedNotice: false,
  signatureError: null,
  initialSection: "contract" as const,
  contractTitle: "Photography Agreement",
  lineItems: [
    {
      id: "line-item-1",
      name: "Wedding coverage",
      description: "Eight hours.",
      quantity: 1,
      unitPriceCents: 850000,
      isOptional: false,
    },
  ],
  invoices: [],
};

const missingContractMarkup = renderToStaticMarkup(
  <ClientProposalExperience
    {...baseProps}
    contractBody={null}
    contractStatus="ready"
  />,
);

assert.match(missingContractMarkup, /cannot be signed until the agreement text is ready/);
assert.doesNotMatch(missingContractMarkup, /Sign and accept proposal/);
assert.doesNotMatch(missingContractMarkup, /name="signatureName"/);

const readyContractMarkup = renderToStaticMarkup(
  <ClientProposalExperience
    {...baseProps}
    contractBody="Agreement body."
    contractStatus="ready"
  />,
);

assert.match(readyContractMarkup, /Sign and accept proposal/);
assert.match(readyContractMarkup, /name="signatureName"/);

console.log("client proposal experience component tests passed");
