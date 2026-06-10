type ProposalLineItemLike = {
  quantity?: number | null;
  unitPriceCents?: number | null;
  isOptional?: boolean | null;
};

const readyContractStatuses = new Set(["ready", "signed"]);

export function canSignProposalContract({
  contractBody,
  contractStatus,
}: {
  contractBody?: string | null;
  contractStatus: string;
}) {
  return Boolean(contractBody?.trim()) && readyContractStatuses.has(contractStatus);
}

export function getProposalReadiness({
  lineItems,
  contractBody,
  contractStatus,
  invoiceStatus,
}: {
  lineItems: ProposalLineItemLike[];
  contractBody?: string | null;
  contractStatus: string;
  invoiceStatus: string;
}) {
  const packageComplete = lineItems.some((item) => !item.isOptional && (item.quantity ?? 0) > 0 && (item.unitPriceCents ?? 0) > 0);
  const contractReady = canSignProposalContract({ contractBody, contractStatus });
  const invoiceReady = invoiceStatus === "created";

  return {
    packageComplete,
    contractReady,
    invoiceReady,
    ready: packageComplete && contractReady && invoiceReady,
  };
}

export function nextProposalStatus({
  currentStatus,
  contractStatus,
  invoiceStatus,
  validUntil,
  packageComplete,
}: {
  currentStatus?: string | null;
  contractStatus: string;
  invoiceStatus: string;
  validUntil?: string | null;
  packageComplete: boolean;
}) {
  if (currentStatus === "accepted" || currentStatus === "declined") return currentStatus;
  if (validUntil && validUntil < new Date().toISOString().slice(0, 10)) return "expired";
  if (currentStatus === "sent" || currentStatus === "viewed") return currentStatus;
  if (packageComplete && readyContractStatuses.has(contractStatus) && invoiceStatus === "created") return "ready";
  return "draft";
}
