import assert from "node:assert/strict";
import { canSignProposalContract, getProposalReadiness, nextProposalStatus } from "./proposal-readiness";

const readyPackage = [{ quantity: 1, unitPriceCents: 450000 }];
const optionalOnlyPackage = [{ quantity: 1, unitPriceCents: 120000, isOptional: true }];

assert.deepEqual(
  getProposalReadiness({
    lineItems: [],
    contractBody: "",
    contractStatus: "not_started",
    invoiceStatus: "not_created",
  }),
  {
    packageComplete: false,
    contractReady: false,
    invoiceReady: false,
    ready: false,
  },
);

assert.equal(
  getProposalReadiness({
    lineItems: readyPackage,
    contractBody: "Agreement text",
    contractStatus: "ready",
    invoiceStatus: "created",
  }).ready,
  true,
);

assert.equal(
  getProposalReadiness({
    lineItems: optionalOnlyPackage,
    contractBody: "Agreement text",
    contractStatus: "ready",
    invoiceStatus: "created",
  }).packageComplete,
  false,
);

assert.equal(
  getProposalReadiness({
    lineItems: readyPackage,
    contractBody: "Agreement text",
    contractStatus: "drafted",
    invoiceStatus: "created",
  }).contractReady,
  false,
);

assert.equal(canSignProposalContract({ contractBody: "Agreement text", contractStatus: "ready" }), true);
assert.equal(canSignProposalContract({ contractBody: "Agreement text", contractStatus: "signed" }), true);
assert.equal(canSignProposalContract({ contractBody: "", contractStatus: "ready" }), false);
assert.equal(canSignProposalContract({ contractBody: "Agreement text", contractStatus: "drafted" }), false);

assert.equal(
  nextProposalStatus({
    currentStatus: "draft",
    contractStatus: "ready",
    invoiceStatus: "created",
    validUntil: null,
    packageComplete: true,
  }),
  "ready",
);

assert.equal(
  nextProposalStatus({
    currentStatus: "viewed",
    contractStatus: "ready",
    invoiceStatus: "created",
    validUntil: null,
    packageComplete: true,
  }),
  "viewed",
);

assert.equal(
  nextProposalStatus({
    currentStatus: "draft",
    contractStatus: "ready",
    invoiceStatus: "created",
    validUntil: "2000-01-01",
    packageComplete: true,
  }),
  "expired",
);

console.log("proposal readiness tests passed");
