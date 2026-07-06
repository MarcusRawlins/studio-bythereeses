// Shared retainer-identification predicate (Phase 9b + Phase 12).
//
// This is the ONE definition of "which payment on an invoice/proposal is the retainer".
// Both the refund hard-block (stripe-refund-initiation.ts) and the unified sign&pay retainer
// selector (sales.ts `resolveProposalRetainerCheckout`) import from here so the rule is never
// forked (Active-Learning: factor the shared helper, don't fork the predicate).
//
// Rule: the retainer is the LABELED retainer if any payment's label matches (deposit/retainer),
// otherwise the EARLIEST payment (min dueDate NULLS LAST, tie-break createdAt, tie-break id).
// `isRetainerPayment(payment, allPayments)` answers "is THIS payment a retainer" (label arm ∪
// earliest arm — a superset used for blocking). `resolveRetainerPayment(allPayments)` picks the
// single canonical retainer to pay (label arm takes precedence over the earliest arm). Every
// payment returned by `resolveRetainerPayment` satisfies `isRetainerPayment`.
//
// Pure module — imports only types, so it is a leaf (no import cycles with sales.ts).

type RetainerCandidate = {
  id: string;
  label: string | null;
  dueDate: string | null;
  createdAt?: string | null;
};

// Phase 9b (F2): the retainer/deposit label predicate. Kept here (re-exported from sales.ts)
// so the label regex has exactly one home.
export function isRetainerPaymentLabel(label: string | null) {
  return /\b(retainer|deposit)\b/i.test(label ?? "");
}

// dueDate NULLS LAST, tie-break createdAt, tie-break id. Shared comparator so
// `earliestPaymentId` and `resolveRetainerPayment` order identically.
function comparePaymentsForRetainer(a: RetainerCandidate, b: RetainerCandidate) {
  const ad = a.dueDate;
  const bd = b.dueDate;
  if (ad !== bd) {
    if (ad === null || ad === undefined) return 1;
    if (bd === null || bd === undefined) return -1;
    return ad < bd ? -1 : 1;
  }
  const ac = a.createdAt ?? "";
  const bc = b.createdAt ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function earliestPaymentId<T extends RetainerCandidate>(payments: T[]): string | null {
  if (!payments.length) return null;
  return [...payments].sort(comparePaymentsForRetainer)[0]?.id ?? null;
}

// Exported (UI enable-prep + refund hard-block + sign&pay selector) so no divergent copy of the
// predicate exists. `allPayments` MUST be the FULL set on the invoice/proposal (settled or not) —
// restricting it to the payable subset re-computes "earliest" over the wrong set (Finding 2).
export function isRetainerPayment<T extends RetainerCandidate>(payment: T, allPayments: T[]) {
  return isRetainerPaymentLabel(payment.label) || payment.id === earliestPaymentId(allPayments);
}

// Phase 12: pick the single canonical retainer to pay from ALL payments. Label arm wins over the
// earliest arm (resolves `isRetainerPayment`'s label ∪ earliest ambiguity toward the labeled
// retainer per §3 step 2); among multiple labeled retainers the earliest is chosen for
// determinism. Returns null for an empty set. The pick always satisfies isRetainerPayment.
export function resolveRetainerPayment<T extends RetainerCandidate>(allPayments: T[]): T | null {
  if (!allPayments.length) return null;
  const sorted = [...allPayments].sort(comparePaymentsForRetainer);
  const labeled = sorted.filter((payment) => isRetainerPaymentLabel(payment.label));
  return labeled[0] ?? sorted[0] ?? null;
}
