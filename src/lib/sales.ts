import { db } from "@/db/client";
import { activityLogs, clients, invoicePayments, invoices, paymentDisputes, paymentRefunds, projectParticipants, projects, proposalAccessTokens, proposalLineItems, proposals, schedulerBookings, schedulerMeetingTypes, templates } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { ensureEngagementPlaceholder } from "@/lib/crm";
import { formatMoney } from "@/lib/format";
import { invoiceClientPayableBalanceCents as calculateInvoiceClientPayableBalanceCents, invoiceClientPayableCents as calculateInvoiceClientPayableCents, isSettledInvoicePaymentStatus } from "@/lib/invoice-balances";
import { canSignProposalContract, nextProposalStatus } from "@/lib/proposal-readiness";
import { enabledPaymentMethods, getAppSettings, type PaymentMethodKey } from "@/lib/settings";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const DEFAULT_CARD_FEE_PERCENT_BPS = 290;
const DEFAULT_CARD_FEE_FIXED_CENTS = 30;

export { invoiceClientPayableBalanceCents, invoiceClientPayableCents } from "@/lib/invoice-balances";

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function nullableTextValue(formData: FormData, key: string) {
  return textValue(formData, key) || null;
}

const invoicePaymentCheckoutStatuses = new Set(["not_created", "link_ready", "paid", "expired", "void"]);

function invoicePaymentCheckoutStatus(value: string | null, checkoutUrl: string | null) {
  const status = value?.trim() || (checkoutUrl ? "link_ready" : "not_created");
  if (!invoicePaymentCheckoutStatuses.has(status)) {
    throw new Error("Checkout status must be canonical.");
  }
  return status;
}

function packageIncludesEngagementSession(items: Array<{ name: string; description?: string | null }>) {
  return items.some((item) => /\bengagement\b/i.test([item.name, item.description].filter(Boolean).join(" ")));
}

function toCents(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 100);
}

function formNumber(formData: FormData, key: string, fallback: number) {
  const value = Number(textValue(formData, key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formValues(formData: FormData, key: string) {
  return formData.getAll(key).map((value) => String(value ?? "").trim());
}

function at(values: string[], index: number) {
  return values[index]?.trim() ?? "";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function addDays(date: string | null, days: number) {
  const base = date ? new Date(`${date}T12:00:00`) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function addTokenDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function hashProposalToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function proposalBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000";
}

export function reconciledInvoicePaymentStatus(invoice: { totalCents: number; status: string }, paidTotalCents: number) {
  if (paidTotalCents >= invoice.totalCents) return "paid";
  if (paidTotalCents > 0) return "partially_paid";
  if (invoice.status === "draft" || invoice.status === "void") return invoice.status;
  return "sent";
}

const RETAINER_STAGE = "retainer_paid";
const RETAINER_STAGE_PRECEDENCE = new Map([
  ["inquiry", 0],
  ["proposal_sent", 1],
  [RETAINER_STAGE, 2],
  ["planning", 3],
  ["editing", 4],
  ["delivered", 5],
  ["completed", 6],
]);

function isRetainerPaymentLabel(label: string | null) {
  return /\b(retainer|deposit)\b/i.test(label ?? "");
}

function shouldAdvanceToRetainerPaid(stage: string, paymentLabel: string | null, status: string, paidAmountCents: number) {
  const currentStageRank = RETAINER_STAGE_PRECEDENCE.get(stage);
  const retainerStageRank = RETAINER_STAGE_PRECEDENCE.get(RETAINER_STAGE) ?? 2;
  return (
    status === "paid"
    && paidAmountCents > 0
    && isRetainerPaymentLabel(paymentLabel)
    && currentStageRank !== undefined
    && currentStageRank < retainerStageRank
  );
}

export async function autoAdvanceProjectStageForRetainerPayment({
  projectId,
  invoiceId,
  paymentId,
  paymentLabel,
  status,
  paidAmountCents,
  actorType,
  actorName,
  metadata,
}: {
  projectId: string;
  invoiceId: string;
  paymentId: string;
  paymentLabel: string | null;
  status: string;
  paidAmountCents: number;
  actorType?: "admin" | "client" | "system" | "agent";
  actorName?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project || !shouldAdvanceToRetainerPaid(project.stage, paymentLabel, status, paidAmountCents)) return;

  const now = new Date().toISOString();
  await db.update(projects).set({
    stage: RETAINER_STAGE,
    updatedAt: now,
  }).where(eq(projects.id, projectId));

  await logActivity({
    projectId,
    action: "project.stage_auto_advanced_from_invoice_payment",
    actorType,
    actorName,
    metadata: {
      invoiceId,
      paymentId,
      paymentLabel,
      previousStage: project.stage,
      nextStage: RETAINER_STAGE,
      paidAmountCents,
      ...metadata,
    },
  });
}

function calculateCardFeeAmountCents({
  subtotalCents,
  percentBps,
  fixedCents,
}: {
  subtotalCents: number;
  percentBps: number;
  fixedCents: number;
}) {
  if (subtotalCents <= 0 || percentBps <= 0) return 0;
  return Math.round(subtotalCents * (percentBps / 10000)) + Math.max(fixedCents, 0);
}

export function estimateInvoiceCardFeeCents(subtotalCents: number) {
  return calculateCardFeeAmountCents({
    subtotalCents,
    percentBps: DEFAULT_CARD_FEE_PERCENT_BPS,
    fixedCents: DEFAULT_CARD_FEE_FIXED_CENTS,
  });
}

function invoicePaymentLedgerAmounts({
  invoice,
  paymentMethod,
  paidAmountCents,
}: {
  invoice: Pick<typeof invoices.$inferSelect, "cardFeePolicy" | "cardFeePercentBps" | "cardFeeFixedCents" | "cardFeeAmountCents">;
  paymentMethod: string | null;
  paidAmountCents: number;
}) {
  if (paidAmountCents <= 0) {
    return {
      paidAmountCents: 0,
      clientFeeCents: 0,
      processingFeeCents: 0,
      grossCollectedCents: 0,
      netDepositCents: 0,
    };
  }

  const isCardPayment = paymentMethod === "stripe" || paymentMethod === "credit_card";
  const hasLegacyPayableFee = invoice.cardFeePolicy === "client_pays"
    && invoice.cardFeeAmountCents > 0
    && invoice.cardFeePercentBps === 0
    && invoice.cardFeeFixedCents === 0;
  const processingFeeCents = isCardPayment
    ? calculateCardFeeAmountCents({
        subtotalCents: paidAmountCents,
        percentBps: hasLegacyPayableFee ? DEFAULT_CARD_FEE_PERCENT_BPS : invoice.cardFeePercentBps ?? DEFAULT_CARD_FEE_PERCENT_BPS,
        fixedCents: hasLegacyPayableFee ? DEFAULT_CARD_FEE_FIXED_CENTS : invoice.cardFeeFixedCents ?? DEFAULT_CARD_FEE_FIXED_CENTS,
      })
    : 0;
  const clientFeeCents = invoice.cardFeePolicy === "client_pays" && isCardPayment ? processingFeeCents : 0;
  const grossCollectedCents = paidAmountCents + clientFeeCents;

  return {
    paidAmountCents,
    clientFeeCents,
    processingFeeCents,
    grossCollectedCents,
    netDepositCents: Math.max(grossCollectedCents - processingFeeCents, 0),
  };
}

async function syncUnpaidProposalInvoicesToAcceptedTotal({
  proposalId,
  projectId,
  totalCents,
  now,
}: {
  proposalId: string;
  projectId: string;
  totalCents: number;
  now: string;
}) {
  const linkedInvoices = await db.query.invoices.findMany({
    where: eq(invoices.proposalId, proposalId),
  });

  for (const invoice of linkedInvoices) {
    if (invoice.totalCents === totalCents || invoice.amountPaidCents > 0 || invoice.status === "paid" || invoice.status === "void") {
      continue;
    }

    const payments = await db.query.invoicePayments.findMany({
      where: eq(invoicePayments.invoiceId, invoice.id),
      orderBy: [asc(invoicePayments.createdAt), asc(invoicePayments.label)],
    });
    if (payments.some((payment) => payment.status === "paid" || payment.paidAmountCents > 0)) {
      continue;
    }

    const deltaCents = totalCents - invoice.totalCents;
    const unpaidPayments = payments.filter((payment) => payment.status !== "paid");
    const adjustablePayment = unpaidPayments.find((payment) => /final|balance/i.test(payment.label))
      ?? [...unpaidPayments].reverse()[0]
      ?? null;
    const cardFeeAmountCents = calculateCardFeeAmountCents({
      subtotalCents: totalCents,
      percentBps: invoice.cardFeePolicy === "client_pays" ? invoice.cardFeePercentBps ?? DEFAULT_CARD_FEE_PERCENT_BPS : 0,
      fixedCents: invoice.cardFeePolicy === "client_pays" ? invoice.cardFeeFixedCents ?? DEFAULT_CARD_FEE_FIXED_CENTS : 0,
    });

    await db.update(invoices).set({
      totalCents,
      cardFeeAmountCents,
      updatedAt: now,
    }).where(eq(invoices.id, invoice.id));

    if (adjustablePayment) {
      await db.update(invoicePayments).set({
        amountCents: Math.max(adjustablePayment.amountCents + deltaCents, 0),
        updatedAt: now,
      }).where(eq(invoicePayments.id, adjustablePayment.id));
    }

    await logActivity({
      projectId,
      action: "invoice.synced_to_accepted_proposal",
      metadata: {
        invoiceId: invoice.id,
        proposalId,
        previousTotalCents: invoice.totalCents,
        totalCents,
        adjustedPaymentId: adjustablePayment?.id ?? null,
        deltaCents,
      },
    });
  }
}

function isPaymentMethodKey(value: string): value is PaymentMethodKey {
  return ["stripe", "zelle", "venmo", "cashCheck"].includes(value);
}

function defaultPaymentNotes(methods: ReturnType<typeof enabledPaymentMethods>) {
  if (!methods.length) return null;
  return methods
    .map((method) => {
      if (method.key === "stripe") return `${method.displayName}: secure payment link will be provided when card payments are connected.`;
      if (method.instructions) return `${method.displayName}: ${method.instructions}`;
      return method.displayName;
    })
    .join("\n");
}

export const proposalStatusOptions = [
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "sent", label: "Sent" },
  { value: "viewed", label: "Viewed" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "expired", label: "Expired" },
];

function proposalStatusFromWorkflow({
  currentStatus,
  contractStatus,
  invoiceStatus,
  validUntil,
  packageComplete = true,
}: {
  currentStatus?: string | null;
  contractStatus: string;
  invoiceStatus: string;
  validUntil?: string | null;
  packageComplete?: boolean;
}) {
  return nextProposalStatus({ currentStatus, contractStatus, invoiceStatus, validUntil, packageComplete });
}

function packageLineItemsFromForm(formData: FormData) {
  const names = formValues(formData, "lineItemName");
  const descriptions = formValues(formData, "lineItemDescription");
  const quantities = formValues(formData, "lineItemQuantity");
  const prices = formValues(formData, "lineItemUnitPrice");

  return names.map((name, index) => ({
    name,
    description: at(descriptions, index) || null,
    quantity: Math.max(Number(at(quantities, index)) || 1, 1),
    unitPriceCents: toCents(at(prices, index)),
    isOptional: formData.get(`lineItemOptional_${index}`) === "on",
    sortOrder: index,
  })).filter((item) => item.name || item.unitPriceCents > 0);
}

function includedPackageTotalCents(items: ReturnType<typeof packageLineItemsFromForm>) {
  return items.reduce((sum, item) => item.isOptional ? sum : sum + item.quantity * item.unitPriceCents, 0);
}

function packageHasIncludedPricedItem(items: ReturnType<typeof packageLineItemsFromForm>) {
  return items.some((item) => !item.isOptional && item.quantity > 0 && item.unitPriceCents > 0);
}

function inferredContractStatus({
  existingStatus,
  contractBody,
  contractTemplateId,
}: {
  existingStatus?: string | null;
  contractBody?: string | null;
  contractTemplateId?: string | null;
}) {
  if (existingStatus === "signed") return "signed";
  if (contractBody?.trim() || contractTemplateId) return "ready";
  return "not_started";
}

async function proposalContractMergeData({
  projectId,
  proposalTitle,
  packageName,
  totalCents,
  scopeSummary,
}: {
  projectId: string;
  proposalTitle: string;
  packageName?: string | null;
  totalCents?: number | null;
  scopeSummary?: string | null;
}) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  const primaryRows = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt));
  const primaryClient = primaryRows[0]?.client ?? null;
  const clientName = primaryClient
    ? [primaryClient.firstName, primaryClient.lastName].filter(Boolean).join(" ")
    : "";

  return {
    "project.name": project?.name ?? "",
    "project.type": project?.type ?? "",
    "project.event_date": project?.eventDate ?? "",
    "project.venue_name": project?.venueName ?? "",
    "project.venue_address": project?.venueAddress ?? "",
    "project.city": project?.city ?? "",
    "project.state": project?.state ?? "",
    "client.name": clientName,
    "client.first_name": primaryClient?.firstName ?? "",
    "client.last_name": primaryClient?.lastName ?? "",
    "client.preferred_name": primaryClient?.preferredName ?? primaryClient?.firstName ?? "",
    "client.email": primaryClient?.email ?? "",
    "client.phone": primaryClient?.phone ?? "",
    "proposal.title": proposalTitle,
    "proposal.package_name": packageName ?? "",
    "proposal.total": typeof totalCents === "number" && totalCents > 0 ? formatMoney(totalCents) : "",
    "proposal.scope_summary": scopeSummary ?? "",
  };
}

async function renderContractTemplateBody({
  templateBody,
  projectId,
  proposalTitle,
  packageName,
  totalCents,
  scopeSummary,
}: {
  templateBody: string;
  projectId: string;
  proposalTitle: string;
  packageName?: string | null;
  totalCents?: number | null;
  scopeSummary?: string | null;
}) {
  const mergeData = await proposalContractMergeData({
    projectId,
    proposalTitle,
    packageName,
    totalCents,
    scopeSummary,
  });

  return templateBody.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(mergeData, key) ? mergeData[key as keyof typeof mergeData] : match
  ));
}

function mergeTemplateBody(body: string, data: Record<string, string>) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(data, key) ? data[key] : match
  ));
}

async function renderInvoiceReminderTemplate({
  body,
  invoice,
  project,
  client,
  payment,
}: {
  body: string;
  invoice: typeof invoices.$inferSelect;
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect | null;
  payment?: typeof invoicePayments.$inferSelect | null;
}) {
  const allPayments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoice.id) });
  const clientName = client ? [client.firstName, client.lastName].filter(Boolean).join(" ") : "";
  const balanceDue = calculateInvoiceClientPayableBalanceCents(invoice, allPayments);
  const paymentBalance = payment ? Math.max(0, payment.amountCents - payment.paidAmountCents) : 0;

  return mergeTemplateBody(body, {
    "client.name": clientName,
    "client.firstName": client?.firstName ?? "",
    "client.first_name": client?.firstName ?? "",
    "client.email": client?.email ?? "",
    "project.name": project.name,
    "project.eventDate": project.eventDate ?? "",
    "project.event_date": project.eventDate ?? "",
    "project.venueName": project.venueName ?? "",
    "project.venue_name": project.venueName ?? "",
    "invoice.number": invoice.invoiceNumber,
    "invoice.total": formatMoney(calculateInvoiceClientPayableCents(invoice)),
    "invoice.balanceDue": formatMoney(balanceDue),
    "invoice.balance_due": formatMoney(balanceDue),
    "payment.label": payment?.label ?? "",
    "payment.dueDate": payment?.dueDate ?? "",
    "payment.due_date": payment?.dueDate ?? "",
    "payment.balanceDue": payment ? formatMoney(paymentBalance) : "",
    "payment.balance_due": payment ? formatMoney(paymentBalance) : "",
  });
}

async function renderProposalPackageTemplateBody({
  templateBody,
  projectId,
  proposalTitle,
  packageName,
  totalCents,
}: {
  templateBody: string;
  projectId: string;
  proposalTitle: string;
  packageName?: string | null;
  totalCents?: number | null;
}) {
  const mergeData = await proposalContractMergeData({
    projectId,
    proposalTitle,
    packageName,
    totalCents,
    scopeSummary: null,
  });

  return mergeTemplateBody(templateBody, mergeData);
}

async function activeProposalPackageTemplate(templateId: string | null) {
  if (!templateId) return null;
  const template = await db.query.templates.findFirst({
    where: and(eq(templates.id, templateId), eq(templates.type, "proposal_package"), eq(templates.status, "active")),
  });
  if (!template) throw new Error("Proposal package template not found.");
  return template;
}

async function activeContractTemplate(templateId: string | null) {
  if (!templateId) return null;
  const template = await db.query.templates.findFirst({
    where: and(eq(templates.id, templateId), eq(templates.type, "contract"), eq(templates.status, "active")),
  });
  if (!template) throw new Error("Contract template not found.");
  return template;
}

function proposalIsAcceptedOrSigned(proposal: Pick<typeof proposals.$inferSelect, "acceptedAt" | "signedAt" | "status" | "contractStatus">) {
  return Boolean(proposal.acceptedAt || proposal.signedAt || proposal.status === "accepted" || proposal.contractStatus === "signed");
}

async function replaceProposalLineItems(proposalId: string, formData: FormData) {
  const now = new Date().toISOString();
  const items = packageLineItemsFromForm(formData);

  await db.delete(proposalLineItems).where(eq(proposalLineItems.proposalId, proposalId));

  if (items.length) {
    await db.insert(proposalLineItems).values(items.map((item) => ({
      id: crypto.randomUUID(),
      proposalId,
      name: item.name || "Package item",
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      isOptional: item.isOptional,
      sortOrder: item.sortOrder,
      createdAt: now,
      updatedAt: now,
    })));
  }

  return includedPackageTotalCents(items);
}

export const invoiceStatusOptions = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "overdue", label: "Overdue" },
  { value: "void", label: "Void" },
];

function dbLineItemsHaveIncludedPricedItem(items: Array<{ quantity: number; unitPriceCents: number; isOptional?: boolean | null }>) {
  return items.some((item) => !item.isOptional && item.quantity > 0 && item.unitPriceCents > 0);
}

function dbIncludedPackageTotalCents(items: Array<{ quantity: number; unitPriceCents: number; isOptional?: boolean | null }>) {
  return items.reduce((sum, item) => {
    if (item.isOptional) return sum;
    return sum + Math.max(item.quantity, 1) * Math.max(item.unitPriceCents, 0);
  }, 0);
}

async function assertProposalCanBeShared(proposal: typeof proposals.$inferSelect) {
  const lineItems = await db.query.proposalLineItems.findMany({
    where: eq(proposalLineItems.proposalId, proposal.id),
  });

  if (!dbLineItemsHaveIncludedPricedItem(lineItems)) {
    throw new Error("Proposal package must include at least one priced required line item.");
  }
  if (!canSignProposalContract({
    contractBody: proposal.contractBody,
    contractStatus: proposal.contractStatus,
  })) {
    throw new Error("Proposal contract must be ready before creating a client link.");
  }
}

type AgentProposalLineItemInput = {
  name: string;
  description?: string | null;
  quantity?: number | null;
  unitPriceCents?: number | null;
  isOptional?: boolean | null;
};

export type AgentProposalInput = {
  title: string;
  packageName?: string | null;
  proposalPackageTemplateId?: string | null;
  validUntil?: string | null;
  scopeSummary?: string | null;
  contractTemplateId?: string | null;
  contractTitle?: string | null;
  contractBody?: string | null;
  lineItems: AgentProposalLineItemInput[];
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentProposalUpdateInput = {
  title?: string | null;
  packageName?: string | null;
  proposalPackageTemplateId?: string | null;
  validUntil?: string | null;
  scopeSummary?: string | null;
  contractTemplateId?: string | null;
  contractTitle?: string | null;
  contractBody?: string | null;
  lineItems?: AgentProposalLineItemInput[] | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentProposalLinkInput = {
  clientId?: string | null;
  label?: string | null;
};

export type AgentInvoiceInput = {
  proposalId?: string | null;
  invoiceNumber?: string | null;
  status?: string | null;
  totalCents?: number | null;
  retainerAmountCents?: number | null;
  retainerPercent?: number | null;
  installmentCount?: number | null;
  dueDate?: string | null;
  paymentNotes?: string | null;
  stripePaymentLink?: string | null;
  acceptedPaymentMethods?: PaymentMethodKey[];
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentInvoiceUpdateInput = {
  status?: string | null;
  totalCents?: number | null;
  retainerAmountCents?: number | null;
  retainerPercent?: number | null;
  installmentCount?: number | null;
  dueDate?: string | null;
  paymentNotes?: string | null;
  stripePaymentLink?: string | null;
  acceptedPaymentMethods?: PaymentMethodKey[];
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentInvoicePaymentInput = {
  paymentId: string;
  status?: string | null;
  paymentMethod?: string | null;
  paidAmountCents?: number | null;
  paidAt?: string | null;
  externalPaymentId?: string | null;
  stripeCheckoutUrl?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeCheckoutStatus?: string | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

export type AgentInvoiceReminderInput = {
  paymentId?: string | null;
  channel?: string | null;
  note?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
};

function cleanAgentText(value: string | null | undefined) {
  return value?.trim() || null;
}

function requireTylerApprovalForAgentFinance(message: string): never {
  throw new Error(message);
}

async function assertAgentProjectSource(projectId: string, sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Project source links require sourceType when sourceId is set.");
  }
  if (sourceType !== "project_source") return;
  if (!sourceId) {
    throw new Error("Project source id is required.");
  }

  const source = await db.query.projectSources.findFirst({
    where: (row, { and, eq }) => and(eq(row.id, sourceId), eq(row.projectId, projectId)),
  });
  if (!source) {
    throw new Error("Project source not found for this project.");
  }
}

function safeRevalidatePath(path: string) {
  try {
    revalidatePath(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("static generation store missing")) {
      return;
    }
    throw error;
  }
}

function normalizedAgentLineItems(items: AgentProposalLineItemInput[]) {
  return items.map((item, index) => ({
    name: cleanAgentText(item.name) ?? "Package item",
    description: cleanAgentText(item.description),
    quantity: Math.max(Math.round(Number(item.quantity ?? 1)) || 1, 1),
    unitPriceCents: Math.max(Math.round(Number(item.unitPriceCents ?? 0)) || 0, 0),
    isOptional: Boolean(item.isOptional),
    sortOrder: index,
  })).filter((item) => item.name || item.unitPriceCents > 0);
}

function agentIncludedPackageTotalCents(items: ReturnType<typeof normalizedAgentLineItems>) {
  return items.reduce((sum, item) => item.isOptional ? sum : sum + item.quantity * item.unitPriceCents, 0);
}

function agentPackageHasIncludedPricedItem(items: ReturnType<typeof normalizedAgentLineItems>) {
  return items.some((item) => !item.isOptional && item.quantity > 0 && item.unitPriceCents > 0);
}

function normalizedInvoiceScheduleRows({
  invoiceId,
  totalCents,
  retainerAmountCents,
  retainerPercent,
  installmentCount,
  dueDate,
  now,
}: {
  invoiceId: string;
  totalCents: number;
  retainerAmountCents?: number | null;
  retainerPercent?: number | null;
  installmentCount?: number | null;
  dueDate?: string | null;
  now: string;
}) {
  const retainerCents = retainerAmountCents && retainerAmountCents > 0
    ? Math.round(retainerAmountCents)
    : Math.round(totalCents * ((typeof retainerPercent === "number" ? retainerPercent : 30) / 100));
  const normalizedRetainerCents = Math.min(Math.max(retainerCents, 0), totalCents);
  const normalizedInstallmentCount = Math.max(Math.trunc(installmentCount ?? 1), 0);
  const remainingCents = Math.max(totalCents - normalizedRetainerCents, 0);
  const rows: Array<{
    invoiceId: string;
    label: string;
    amountCents: number;
    dueDate: string | null;
    status: string;
    createdAt: string;
    updatedAt: string;
  }> = [];

  if (normalizedRetainerCents > 0) {
    rows.push({
      invoiceId,
      label: "Retainer",
      amountCents: normalizedRetainerCents,
      dueDate: dueDate ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  if (remainingCents > 0 && normalizedInstallmentCount > 0) {
    const baseAmount = Math.floor(remainingCents / normalizedInstallmentCount);
    let allocated = 0;
    for (let index = 0; index < normalizedInstallmentCount; index += 1) {
      const isLast = index === normalizedInstallmentCount - 1;
      const amountCents = isLast ? remainingCents - allocated : baseAmount;
      allocated += amountCents;
      rows.push({
        invoiceId,
        label: normalizedInstallmentCount === 1 ? "Final payment" : `Payment ${index + 1}`,
        amountCents,
        dueDate: addDays(dueDate ?? null, 30 * (index + 1)),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return rows;
}

async function replaceAgentProposalLineItems(proposalId: string, lineItems: ReturnType<typeof normalizedAgentLineItems>, now: string) {
  await db.delete(proposalLineItems).where(eq(proposalLineItems.proposalId, proposalId));

  if (lineItems.length) {
    await db.insert(proposalLineItems).values(lineItems.map((item) => ({
      id: crypto.randomUUID(),
      proposalId,
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      isOptional: item.isOptional,
      sortOrder: item.sortOrder,
      createdAt: now,
      updatedAt: now,
    })));
  }
}

function proposalMissingFields({
  packageComplete,
  contractStatus,
  invoiceStatus,
}: {
  packageComplete: boolean;
  contractStatus: string;
  invoiceStatus: string;
}) {
  const missing: string[] = [];
  if (!packageComplete) missing.push("package");
  if (!["ready", "signed"].includes(contractStatus)) missing.push("contract");
  if (invoiceStatus !== "created") missing.push("invoice");
  return missing;
}

type ProjectOptionRow = {
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect;
  participant: typeof projectParticipants.$inferSelect | null;
};

type ProposalOptionRow = {
  proposal: typeof proposals.$inferSelect;
  project: typeof projects.$inferSelect;
};

type ProposalRow = {
  proposal: typeof proposals.$inferSelect;
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect;
};

type InvoiceRow = {
  invoice: typeof invoices.$inferSelect;
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect;
  proposal: typeof proposals.$inferSelect | null;
  clientPayableBalanceCents?: number;
};

export type PaymentLedgerRow = {
  sourceType: "invoice" | "scheduler_booking";
  sourceId: string;
  href: string;
  paymentSourceType: string | null;
  paymentSourceId: string | null;
  payment: typeof invoicePayments.$inferSelect;
  invoice: typeof invoices.$inferSelect;
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect | null;
  clientName: string;
  openCents: number;
  clientPayableOpenCents: number;
  // Phase 9a — refund/dispute surfacing (additive; gross fields above unchanged).
  refundedAmountCents: number;
  disputeStatus: string | null;
  disputedAmountCents: number;
  // Sum of succeeded child refunds linked to this payment. Used to compute the
  // divergence/over-cap reconciliation flag at READ time (never persisted).
  succeededRefundCents: number;
  // netCollectedCents = grossCollected − refunded − (dispute lost & not reinstated ? disputed : 0).
  netCollectedCents: number;
};

// A refund/dispute recorded from Stripe that matched no invoice_payment row (§1.4
// case 3) — surfaced as its own "Unlinked money events" section, never as a ledger row.
export type UnlinkedMoneyEvent = {
  kind: "refund" | "dispute";
  id: string;
  stripeId: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  schedulerBookingId: string | null;
  amountCents: number;
  currency: string;
  status: string | null;
  reason: string | null;
  createdAt: string;
};

export type AccountsReceivableAgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type AccountsReceivableAgingRow = {
  sourceType: PaymentLedgerRow["sourceType"];
  sourceId: string;
  href: string;
  invoiceNumber: string;
  paymentLabel: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string;
  dueDate: string | null;
  status: string;
  openCents: number;
  daysPastDue: number;
  bucket: AccountsReceivableAgingBucket;
};

export type PaymentLedgerReport = {
  rows: PaymentLedgerRow[];
  totals: {
    scheduledCents: number;
    paidCents: number;
    grossCollectedCents: number;
    clientFeeCents: number;
    processingFeeCents: number;
    netDepositCents: number;
    openCents: number;
    clientPayableOpenCents: number;
    // Phase 9a — additive net-of-refunds figures (gross fields above unchanged).
    refundedCents: number;
    disputedOpenCents: number;
    netCollectedCents: number;
  };
  // Refunds/disputes that matched no invoice payment (orphaned/unlinked).
  unlinkedMoneyEvents: UnlinkedMoneyEvent[];
  aging: {
    asOfDate: string;
    buckets: Array<{
      bucket: AccountsReceivableAgingBucket;
      label: string;
      openCents: number;
      count: number;
    }>;
    rows: AccountsReceivableAgingRow[];
  };
};

export type PaymentLedgerReportInput = {
  status?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  asOfDate?: string | null;
};

export async function listProjectOptions() {
  const rows = await db
    .select({
      project: projects,
      client: clients,
      participant: projectParticipants,
    })
    .from(projects)
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .orderBy(desc(projects.createdAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as ProjectOptionRow[];

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.project.id)) return false;
    seen.add(row.project.id);
    return true;
  });
}

export async function listClientOptions() {
  return db.query.clients.findMany({
    orderBy: desc(clients.createdAt),
  });
}

export async function listContractTemplateOptions() {
  return db.query.templates.findMany({
    where: and(eq(templates.type, "contract"), eq(templates.status, "active")),
    orderBy: desc(templates.createdAt),
  });
}

export async function listProposalPackageTemplateOptions() {
  return db.query.templates.findMany({
    where: and(eq(templates.type, "proposal_package"), eq(templates.status, "active")),
    orderBy: desc(templates.createdAt),
  });
}

export async function listProposalOptions(projectId?: string) {
  const rows = await db
    .select({
      proposal: proposals,
      project: projects,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .where(projectId ? eq(proposals.projectId, projectId) : undefined)
    .orderBy(desc(proposals.createdAt)) as unknown as ProposalOptionRow[];

  return rows;
}

export async function listProposals(search = "", status = "all") {
  const filters = [
    status !== "all" ? eq(proposals.status, status) : undefined,
    search
      ? or(
          like(proposals.title, `%${search}%`),
          like(proposals.packageName, `%${search}%`),
          like(projects.name, `%${search}%`),
          like(clients.firstName, `%${search}%`),
          like(clients.lastName, `%${search}%`),
        )
      : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      proposal: proposals,
      project: projects,
      client: clients,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(proposals.createdAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as ProposalRow[];

  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.proposal.id)) return false;
    seen.add(row.proposal.id);
    return true;
  });
}

export async function getProposal(proposalId: string) {
  const rows = await db
    .select({
      proposal: proposals,
      project: projects,
      client: clients,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, proposalId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as ProposalRow[];

  const row = rows[0];
  if (!row) return null;

  const linkedInvoices = await db.query.invoices.findMany({
    where: eq(invoices.proposalId, proposalId),
    orderBy: desc(invoices.createdAt),
  });
  const lineItems = await db.query.proposalLineItems.findMany({
    where: eq(proposalLineItems.proposalId, proposalId),
    orderBy: proposalLineItems.sortOrder,
  });
  const accessTokens = await db.query.proposalAccessTokens.findMany({
    where: eq(proposalAccessTokens.proposalId, proposalId),
    orderBy: desc(proposalAccessTokens.createdAt),
  });

  return { ...row, invoices: linkedInvoices, lineItems, accessTokens };
}

export async function createProposalLinkFromForm(formData: FormData) {
  const proposalId = textValue(formData, "proposalId");
  const projectId = textValue(formData, "projectId");
  const clientId = nullableTextValue(formData, "clientId");
  if (!proposalId || !projectId) throw new Error("Proposal and project are required.");

  const proposal = await db.query.proposals.findFirst({ where: eq(proposals.id, proposalId) });
  if (!proposal) throw new Error("Proposal not found.");
  if (proposal.projectId !== projectId) throw new Error("Proposal does not belong to this project.");
  await assertProposalCanBeShared(proposal);
  if (clientId) {
    const participant = await db.query.projectParticipants.findFirst({
      where: and(eq(projectParticipants.projectId, projectId), eq(projectParticipants.clientId, clientId)),
    });
    if (!participant) throw new Error("Proposal client is not linked to this project.");
  }

  const now = new Date().toISOString();
  const token = randomBytes(32).toString("base64url");
  const url = `${proposalBaseUrl()}/proposal/${token}`;
  const expiresAt = addTokenDays(45);
  const label = textValue(formData, "label") || "Client proposal package";
  const activeMatchingTokens = await db.query.proposalAccessTokens.findMany({
    where: clientId
      ? and(
        eq(proposalAccessTokens.proposalId, proposalId),
        eq(proposalAccessTokens.projectId, projectId),
        eq(proposalAccessTokens.clientId, clientId),
        isNull(proposalAccessTokens.revokedAt),
      )
      : and(
        eq(proposalAccessTokens.proposalId, proposalId),
        eq(proposalAccessTokens.projectId, projectId),
        isNull(proposalAccessTokens.clientId),
        isNull(proposalAccessTokens.revokedAt),
      ),
  });
  if (activeMatchingTokens.length) {
    await db.update(proposalAccessTokens).set({
      revokedAt: now,
    }).where(inArray(proposalAccessTokens.id, activeMatchingTokens.map((row) => row.id)));
    await logActivity({
      projectId,
      clientId,
      action: "proposal.link_replaced",
      metadata: { proposalId, revokedTokenIds: activeMatchingTokens.map((row) => row.id) },
    });
  }

  await db.insert(proposalAccessTokens).values({
    id: crypto.randomUUID(),
    proposalId,
    projectId,
    clientId,
    tokenHash: hashProposalToken(token),
    label,
    expiresAt,
    sentAt: now,
    viewedAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    createdAt: now,
  });

  await db.update(proposals).set({
    status: "sent",
    sentAt: proposal.sentAt ?? now,
    updatedAt: now,
  }).where(eq(proposals.id, proposalId));

  await logActivity({
    projectId,
    clientId,
    action: "proposal.link_created",
    metadata: { proposalId, expiresAt },
  });

  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${proposalId}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId, projectId, clientId, label, expiresAt, url };
}

export async function createProposalLinkFromAgent(projectId: string, proposalId: string, input: AgentProposalLinkInput = {}) {
  const formData = new FormData();
  formData.set("projectId", projectId);
  formData.set("proposalId", proposalId);
  if (input.clientId) formData.set("clientId", input.clientId);
  if (input.label) formData.set("label", input.label);
  return createProposalLinkFromForm(formData);
}

export async function createProposalLinkAction(formData: FormData) {
  "use server";

  const result = await createProposalLinkFromForm(formData);
  redirect(`/proposals/${result.proposalId}?share=${encodeURIComponent(result.url)}`);
}

export async function getProposalPackageByToken(token: string, lastUsedIp?: string | null) {
  const tokenRow = await db.query.proposalAccessTokens.findFirst({
    where: eq(proposalAccessTokens.tokenHash, hashProposalToken(token)),
  });

  if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt < new Date().toISOString()) return null;

  const rows = await db
    .select({
      proposal: proposals,
      project: projects,
      client: clients,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, tokenRow.proposalId)) as unknown as ProposalRow[];

  const row = rows.find((candidate) => candidate.client?.id === tokenRow.clientId) ?? rows[0];
  if (!row) return null;

  const [lineItems, linkedInvoices] = await Promise.all([
    db.query.proposalLineItems.findMany({
      where: eq(proposalLineItems.proposalId, tokenRow.proposalId),
      orderBy: proposalLineItems.sortOrder,
    }),
    db.query.invoices.findMany({
      where: eq(invoices.proposalId, tokenRow.proposalId),
      orderBy: desc(invoices.createdAt),
    }),
  ]);

  const invoiceIds = linkedInvoices.map((invoice) => invoice.id);
  const paymentRows = invoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: inArray(invoicePayments.invoiceId, invoiceIds),
        orderBy: invoicePayments.dueDate,
      })
    : [];
  const paymentsByInvoiceId = new Map<string, typeof paymentRows>();
  for (const payment of paymentRows) {
    if (!linkedInvoices.some((invoice) => invoice.id === payment.invoiceId)) continue;
    paymentsByInvoiceId.set(payment.invoiceId, [...(paymentsByInvoiceId.get(payment.invoiceId) ?? []), payment]);
  }

  const now = new Date().toISOString();
  const firstView = !tokenRow.viewedAt;
  await db.update(proposalAccessTokens).set({
    viewedAt: tokenRow.viewedAt ?? now,
    lastUsedAt: now,
    lastUsedIp: lastUsedIp ?? null,
  }).where(eq(proposalAccessTokens.id, tokenRow.id));

  if (["draft", "ready", "sent"].includes(row.proposal.status)) {
    await db.update(proposals).set({ status: "viewed", updatedAt: now }).where(eq(proposals.id, row.proposal.id));
    row.proposal.status = "viewed";
  }

  if (firstView) {
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "proposal.viewed",
      actorType: "client",
      actorName: row.client ? `${row.client.firstName} ${row.client.lastName ?? ""}`.trim() : "Client proposal viewer",
      metadata: { proposalId: row.proposal.id },
    });
  }

  return {
    ...row,
    accessToken: { ...tokenRow, viewedAt: tokenRow.viewedAt ?? now, lastUsedAt: now },
    lineItems,
    invoices: linkedInvoices.map((invoice) => ({
      ...invoice,
      payments: paymentsByInvoiceId.get(invoice.id) ?? [],
      balanceCents: calculateInvoiceClientPayableBalanceCents(invoice, paymentsByInvoiceId.get(invoice.id) ?? []),
    })),
  };
}

export async function acceptProposalByToken(
  token: string,
  lastUsedIp?: string | null,
  signature?: {
    signerName: string;
    signerEmail: string | null;
    selectedOptionalLineItemIds?: string[];
    userAgent?: string | null;
    consentText?: string | null;
    consentVersion?: string | null;
  },
) {
  if (!signature?.signerName) return null;

  const tokenRow = await db.query.proposalAccessTokens.findFirst({
    where: eq(proposalAccessTokens.tokenHash, hashProposalToken(token)),
  });

  if (!tokenRow || tokenRow.revokedAt || tokenRow.expiresAt < new Date().toISOString()) return null;

  const rows = await db
    .select({
      proposal: proposals,
      project: projects,
      client: clients,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, tokenRow.proposalId)) as unknown as ProposalRow[];

  const row = rows.find((candidate) => candidate.client?.id === tokenRow.clientId) ?? rows[0];
  if (!row || ["declined", "expired"].includes(row.proposal.status)) return null;

  const now = new Date().toISOString();
  const firstAcceptance = !row.proposal.acceptedAt;
  const firstSignature = !row.proposal.signedAt;
  if (proposalIsAcceptedOrSigned(row.proposal)) {
    await db.update(proposalAccessTokens).set({
      viewedAt: tokenRow.viewedAt ?? now,
      lastUsedAt: now,
      lastUsedIp: lastUsedIp ?? null,
    }).where(eq(proposalAccessTokens.id, tokenRow.id));

    safeRevalidatePath(`/proposal/${token}`);
    return { proposalId: row.proposal.id, projectId: tokenRow.projectId };
  }
  if (!canSignProposalContract({
    contractBody: row.proposal.contractBody,
    contractStatus: row.proposal.contractStatus,
  })) {
    await db.update(proposalAccessTokens).set({
      viewedAt: tokenRow.viewedAt ?? now,
      lastUsedAt: now,
      lastUsedIp: lastUsedIp ?? null,
    }).where(eq(proposalAccessTokens.id, tokenRow.id));

    safeRevalidatePath(`/proposal/${token}`);
    return null;
  }

  const signerName = signature.signerName.trim().replace(/\s+/g, " ");
  const signerEmail = signature.signerEmail?.trim().toLowerCase() || null;
  const selectedOptionalLineItemIds = Array.from(new Set(signature.selectedOptionalLineItemIds ?? []));
  let validSelectedOptionalLineItemIds: string[] = [];

  if (selectedOptionalLineItemIds.length) {
    const selectedLineItems = await db.query.proposalLineItems.findMany({
      where: and(eq(proposalLineItems.proposalId, row.proposal.id), inArray(proposalLineItems.id, selectedOptionalLineItemIds)),
    });
    validSelectedOptionalLineItemIds = selectedLineItems
      .filter((item) => item.isOptional)
      .map((item) => item.id);

    if (validSelectedOptionalLineItemIds.length) {
      await db.update(proposalLineItems).set({
        isOptional: false,
        updatedAt: now,
      }).where(and(eq(proposalLineItems.proposalId, row.proposal.id), inArray(proposalLineItems.id, validSelectedOptionalLineItemIds)));
    }
  }

  const acceptedLineItems = validSelectedOptionalLineItemIds.length
    ? await db.query.proposalLineItems.findMany({ where: eq(proposalLineItems.proposalId, row.proposal.id) })
    : [];
  const acceptedTotalCents = validSelectedOptionalLineItemIds.length ? dbIncludedPackageTotalCents(acceptedLineItems) : row.proposal.totalCents;
  const acceptedPackageLineItems = acceptedLineItems.length
    ? acceptedLineItems
    : await db.query.proposalLineItems.findMany({ where: eq(proposalLineItems.proposalId, row.proposal.id) });

  await db.update(proposalAccessTokens).set({
    viewedAt: tokenRow.viewedAt ?? now,
    lastUsedAt: now,
    lastUsedIp: lastUsedIp ?? null,
  }).where(eq(proposalAccessTokens.id, tokenRow.id));

  await db.update(proposals).set({
    status: "accepted",
    acceptedAt: row.proposal.acceptedAt ?? now,
    signedAt: row.proposal.signedAt ?? now,
    signerName: row.proposal.signerName ?? signerName,
    signerEmail: row.proposal.signerEmail ?? signerEmail,
    signatureIp: row.proposal.signatureIp ?? lastUsedIp ?? null,
    signatureUserAgent: row.proposal.signatureUserAgent ?? signature.userAgent?.trim() ?? null,
    signatureConsentText: row.proposal.signatureConsentText ?? signature.consentText?.trim() ?? null,
    signatureConsentVersion: row.proposal.signatureConsentVersion ?? signature.consentVersion?.trim() ?? null,
    selectedOptionalLineItemIdsJson: row.proposal.selectedOptionalLineItemIdsJson ?? JSON.stringify(validSelectedOptionalLineItemIds),
    contractStatus: "signed",
    totalCents: acceptedTotalCents,
    updatedAt: now,
  }).where(eq(proposals.id, row.proposal.id));

  await syncUnpaidProposalInvoicesToAcceptedTotal({
    proposalId: row.proposal.id,
    projectId: tokenRow.projectId,
    totalCents: acceptedTotalCents ?? 0,
    now,
  });

  if (firstAcceptance) {
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "proposal.accepted",
      actorType: "client",
      actorName: row.client ? `${row.client.firstName} ${row.client.lastName ?? ""}`.trim() : signerName,
      metadata: { proposalId: row.proposal.id, selectedOptionalLineItemIds: validSelectedOptionalLineItemIds },
    });
  }

  if (firstSignature) {
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "proposal.signed",
      actorType: "client",
      actorName: signerName,
      metadata: {
        proposalId: row.proposal.id,
        signerEmail,
        signatureIp: lastUsedIp ?? null,
        signatureUserAgent: signature.userAgent?.trim() ?? null,
        signatureConsentVersion: signature.consentVersion?.trim() ?? null,
        selectedOptionalLineItemIds: validSelectedOptionalLineItemIds,
      },
    });
  }

  if (firstAcceptance && packageIncludesEngagementSession(acceptedPackageLineItems.filter((item) => !item.isOptional))) {
    const eventId = await ensureEngagementPlaceholder(tokenRow.projectId);
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "engagement.pending_added",
      actorType: "system",
      metadata: { proposalId: row.proposal.id, eventId },
    });
  }

  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${row.proposal.id}`);
  safeRevalidatePath(`/projects/${tokenRow.projectId}`);
  safeRevalidatePath(`/proposal/${token}`);

  return { proposalId: row.proposal.id, projectId: tokenRow.projectId };
}

export async function listInvoices(search = "", status = "all") {
  const primaryParticipantJoin = and(
    eq(projectParticipants.projectId, projects.id),
    eq(projectParticipants.isPrimaryContact, true),
  );
  const filters = [
    status !== "all" ? eq(invoices.status, status) : undefined,
    search
      ? or(
          like(invoices.invoiceNumber, `%${search}%`),
          like(projects.name, `%${search}%`),
          like(clients.firstName, `%${search}%`),
          like(clients.lastName, `%${search}%`),
        )
      : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      invoice: invoices,
      project: projects,
      client: clients,
      proposal: proposals,
    })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .leftJoin(projectParticipants, primaryParticipantJoin)
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .leftJoin(proposals, eq(invoices.proposalId, proposals.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(invoices.createdAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as InvoiceRow[];

  const seen = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    if (seen.has(row.invoice.id)) return false;
    seen.add(row.invoice.id);
    return true;
  });
  const invoiceIds = uniqueRows.map((row) => row.invoice.id);
  const paymentRows = invoiceIds.length
    ? await db.query.invoicePayments.findMany({
        where: (payment, { inArray }) => inArray(payment.invoiceId, invoiceIds),
      })
    : [];
  const paymentsByInvoice = new Map<string, Array<typeof invoicePayments.$inferSelect>>();
  for (const payment of paymentRows) {
    paymentsByInvoice.set(payment.invoiceId, [...(paymentsByInvoice.get(payment.invoiceId) ?? []), payment]);
  }

  return uniqueRows.map((row) => ({
    ...row,
    clientPayableBalanceCents: calculateInvoiceClientPayableBalanceCents(row.invoice, paymentsByInvoice.get(row.invoice.id) ?? []),
  }));
}

export async function getInvoice(invoiceId: string) {
  const primaryParticipantJoin = and(
    eq(projectParticipants.projectId, projects.id),
    eq(projectParticipants.isPrimaryContact, true),
  );
  const rows = await db
    .select({
      invoice: invoices,
      project: projects,
      client: clients,
      proposal: proposals,
    })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .leftJoin(projectParticipants, primaryParticipantJoin)
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .leftJoin(proposals, eq(invoices.proposalId, proposals.id))
    .where(eq(invoices.id, invoiceId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as InvoiceRow[];

  const row = rows[0];
  if (!row) return null;

  const payments = await db.query.invoicePayments.findMany({
    where: eq(invoicePayments.invoiceId, invoiceId),
    orderBy: desc(invoicePayments.createdAt),
  });
  const reminders = await db.query.activityLogs.findMany({
    where: and(
      eq(activityLogs.projectId, row.project.id),
      inArray(activityLogs.action, ["invoice.reminder_logged", "invoice.reminder_logged_by_agent"]),
      like(activityLogs.metadata, `%${invoiceId}%`),
    ),
    orderBy: desc(activityLogs.createdAt),
    limit: 8,
  });
  const proposalSyncs = await db.query.activityLogs.findMany({
    where: and(
      eq(activityLogs.projectId, row.project.id),
      eq(activityLogs.action, "invoice.synced_to_accepted_proposal"),
      like(activityLogs.metadata, `%${invoiceId}%`),
    ),
    orderBy: desc(activityLogs.createdAt),
    limit: 4,
  });
  const reminderTemplates = await db.query.templates.findMany({
    where: and(eq(templates.type, "reminder"), eq(templates.status, "active")),
    orderBy: desc(templates.updatedAt),
  });

  return { ...row, payments, reminders, proposalSyncs, reminderTemplates, balanceCents: calculateInvoiceClientPayableBalanceCents(row.invoice, payments) };
}

function paymentLedgerStatusFilter(status: string | null | undefined) {
  const cleanStatus = cleanAgentText(status);
  return !cleanStatus || cleanStatus === "all" ? null : cleanStatus;
}

// Phase 9a: a refund whose recorded child amount exceeds what we collected (over-cap),
// or a summary-vs-children divergence, is a reconciliation item (Fable finding #6). The
// divergence flag is computed HERE at read time — never persisted — so it self-heals when
// a reordered charge.refunded / refund.created pair settles.
export function paymentRefundNeedsReconciliation(row: Pick<PaymentLedgerRow, "payment" | "succeededRefundCents" | "disputeStatus">) {
  const gross = Math.max(row.payment.grossCollectedCents, 0);
  const overCap = row.succeededRefundCents > gross;
  const divergence = row.payment.refundedAmountCents !== row.succeededRefundCents;
  const openDispute = row.disputeStatus === "open";
  return overCap || divergence || openDispute;
}

function ledgerNetCollectedCents(payment: typeof invoicePayments.$inferSelect) {
  const gross = Math.max(payment.grossCollectedCents, 0);
  const refunded = Math.max(payment.refundedAmountCents, 0);
  // A lost dispute whose funds were NOT reinstated is treated like a refund for net.
  // ("reinstated"/"won"/"open" summary states do not subtract.)
  const disputeLost = payment.disputeStatus === "lost" ? Math.max(payment.disputedAmountCents, 0) : 0;
  return gross - refunded - disputeLost;
}

function paymentLedgerNeedsReconciliation(row: PaymentLedgerRow) {
  // Original evidence rule (paid rows missing external id / source) PLUS the Phase 9a
  // refund/dispute flags. "refunded" is settled but can still carry a divergence/over-cap.
  const missingEvidence = (row.payment.status === "paid" || row.payment.status === "refunded") && (
    !row.payment.externalPaymentId
    || !row.paymentSourceType
    || !row.paymentSourceId
  );
  return missingEvidence || paymentRefundNeedsReconciliation(row);
}

function paymentLedgerSortValue(row: PaymentLedgerRow) {
  return row.payment.dueDate ?? row.payment.paidAt ?? row.payment.createdAt ?? "";
}

function paymentLedgerDate(row: PaymentLedgerRow) {
  // "refunded" is a settled status: a refunded payment keeps its original paidAt so the
  // ledger surface attributes its gross to the collection period, matching the bookkeeping
  // report (["paid","refunded"] scoped by paidAt). Falling back to dueDate here would move
  // original-period gross to the due date when a payment flips refunded (Fable rev-3 #1).
  return (row.payment.status === "paid" || row.payment.status === "refunded"
    ? row.payment.paidAt
    : null)
    ?? row.payment.dueDate
    ?? row.payment.createdAt
    ?? "";
}

function paymentLedgerMatchesRange(row: PaymentLedgerRow, input: PaymentLedgerReportInput) {
  const date = paymentLedgerDate(row).slice(0, 10);
  if (input.fromDate && date < input.fromDate) return false;
  if (input.toDate && date > input.toDate) return false;
  return true;
}

function ledgerClientName(client: typeof clients.$inferSelect | null) {
  if (!client) return "Needs primary client";
  return [client.firstName, client.lastName].filter(Boolean).join(" ") || client.email;
}

const AR_AGING_BUCKETS: Array<{ bucket: AccountsReceivableAgingBucket; label: string }> = [
  { bucket: "current", label: "Current" },
  { bucket: "1_30", label: "1-30" },
  { bucket: "31_60", label: "31-60" },
  { bucket: "61_90", label: "61-90" },
  { bucket: "90_plus", label: "90+" },
];

function dateKey(value: string | null | undefined) {
  return value?.slice(0, 10) || null;
}

function defaultAsOfDate() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenDateKeys(laterDateKey: string, earlierDateKey: string) {
  const later = Date.parse(`${laterDateKey}T12:00:00.000Z`);
  const earlier = Date.parse(`${earlierDateKey}T12:00:00.000Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return 0;
  return Math.max(Math.floor((later - earlier) / 86_400_000), 0);
}

function agingBucketForDays(daysPastDue: number): AccountsReceivableAgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1_30";
  if (daysPastDue <= 60) return "31_60";
  if (daysPastDue <= 90) return "61_90";
  return "90_plus";
}

function buildAccountsReceivableAging(rows: PaymentLedgerRow[], asOfDate: string) {
  const agingRows = rows
    .filter((row) => row.openCents > 0 && !["paid", "waived", "refunded"].includes(row.payment.status))
    .map<AccountsReceivableAgingRow>((row) => {
      const dueDate = dateKey(row.payment.dueDate);
      const daysPastDue = dueDate ? daysBetweenDateKeys(asOfDate, dueDate) : 0;
      return {
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        href: row.href,
        invoiceNumber: row.invoice.invoiceNumber,
        paymentLabel: row.payment.label,
        projectId: row.project.id,
        projectName: row.project.name,
        clientId: row.client?.id ?? null,
        clientName: row.clientName,
        dueDate,
        status: row.payment.status,
        openCents: row.openCents,
        daysPastDue,
        bucket: agingBucketForDays(daysPastDue),
      };
    })
    .sort((a, b) => b.daysPastDue - a.daysPastDue || b.openCents - a.openCents || a.dueDate?.localeCompare(b.dueDate ?? "") || 0);

  const buckets = AR_AGING_BUCKETS.map(({ bucket, label }) => {
    const bucketRows = agingRows.filter((row) => row.bucket === bucket);
    return {
      bucket,
      label,
      openCents: bucketRows.reduce((sum, row) => sum + row.openCents, 0),
      count: bucketRows.length,
    };
  });

  return { asOfDate, buckets, rows: agingRows };
}

export async function getPaymentLedgerReport(input: PaymentLedgerReportInput = {}): Promise<PaymentLedgerReport> {
  const cleanStatus = paymentLedgerStatusFilter(input.status);
  const needsReconciliation = cleanStatus === "needs_reconciliation";
  // Phase 9a (Fable N2): widen the reconciliation view to include "refunded" rows so a
  // refunded payment carrying a divergence/over-cap flag stays visible (a refunded row is
  // otherwise settled and would be filtered out).
  const invoiceStatusFilter = cleanStatus
    ? (needsReconciliation ? inArray(invoicePayments.status, ["paid", "refunded"]) : eq(invoicePayments.status, cleanStatus))
    : undefined;
  const schedulerStatusFilter = cleanStatus
    ? eq(schedulerBookings.paymentStatus, needsReconciliation ? "paid" : cleanStatus)
    : undefined;

  // Sum of SUCCEEDED child refunds per invoice payment — the read-time input to the
  // divergence/over-cap flag (§2.2) and the per-row net figure.
  const succeededRefundRows = await db
    .select({ invoicePaymentId: paymentRefunds.invoicePaymentId, amountCents: paymentRefunds.amountCents })
    .from(paymentRefunds)
    .where(eq(paymentRefunds.status, "succeeded"));
  const succeededRefundByPayment = new Map<string, number>();
  for (const refund of succeededRefundRows) {
    if (!refund.invoicePaymentId) continue;
    succeededRefundByPayment.set(refund.invoicePaymentId, (succeededRefundByPayment.get(refund.invoicePaymentId) ?? 0) + (refund.amountCents ?? 0));
  }

  const rows = await db
    .select({
      payment: invoicePayments,
      invoice: invoices,
      project: projects,
      client: clients,
    })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoicePayments.invoiceId, invoices.id))
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(invoiceStatusFilter)
    .orderBy(asc(invoicePayments.dueDate), asc(invoicePayments.createdAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as Array<{
      payment: typeof invoicePayments.$inferSelect;
      invoice: typeof invoices.$inferSelect;
      project: typeof projects.$inferSelect;
      client: typeof clients.$inferSelect | null;
    }>;

  const seenPayments = new Set<string>();
  const ledgerRows: PaymentLedgerRow[] = [];

  for (const row of rows) {
    if (seenPayments.has(row.payment.id)) continue;
    seenPayments.add(row.payment.id);
    // Phase 9a: "refunded" reflects the ORIGINAL gross collection (paidCents), reads as
    // settled (openCents 0), and is not re-owed. Net is derived separately.
    const paidCents = (row.payment.status === "paid" || row.payment.status === "refunded") ? row.payment.paidAmountCents : 0;
    const succeededRefundCents = succeededRefundByPayment.get(row.payment.id) ?? 0;
    ledgerRows.push({
      sourceType: "invoice",
      sourceId: row.payment.id,
      href: `/invoices/${row.invoice.id}#payment-${encodeURIComponent(row.payment.id)}`,
      paymentSourceType: row.payment.sourceType,
      paymentSourceId: row.payment.sourceId,
      ...row,
      clientName: ledgerClientName(row.client),
      openCents: isSettledInvoicePaymentStatus(row.payment.status)
        ? 0
        : Math.max(row.payment.amountCents - paidCents, 0),
      clientPayableOpenCents: 0,
      refundedAmountCents: Math.max(row.payment.refundedAmountCents, 0),
      disputeStatus: row.payment.disputeStatus,
      disputedAmountCents: Math.max(row.payment.disputedAmountCents, 0),
      succeededRefundCents,
      netCollectedCents: ledgerNetCollectedCents(row.payment),
    });
  }

  const bookingRows = await db
    .select({
      booking: schedulerBookings,
      meetingType: schedulerMeetingTypes,
      project: projects,
      client: clients,
      participant: projectParticipants,
    })
    .from(schedulerBookings)
    .innerJoin(schedulerMeetingTypes, eq(schedulerBookings.meetingTypeId, schedulerMeetingTypes.id))
    .innerJoin(projects, eq(schedulerBookings.projectId, projects.id))
    .leftJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .leftJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(schedulerStatusFilter)
    .orderBy(asc(schedulerBookings.startAt), desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt)) as unknown as Array<{
      booking: typeof schedulerBookings.$inferSelect;
      meetingType: typeof schedulerMeetingTypes.$inferSelect;
      project: typeof projects.$inferSelect;
      client: typeof clients.$inferSelect | null;
      participant: typeof projectParticipants.$inferSelect | null;
    }>;

  const seenBookings = new Set<string>();
  for (const row of bookingRows) {
    if (seenBookings.has(row.booking.id)) continue;
    seenBookings.add(row.booking.id);
    const amountCents = row.booking.paidAmountCents || row.meetingType.priceCents || 0;
    const syntheticInvoice = {
      id: row.booking.id,
      projectId: row.project.id,
      proposalId: null,
      invoiceNumber: "BOOKING",
      status: row.booking.paymentStatus,
      totalCents: amountCents,
      amountPaidCents: row.booking.paidAmountCents,
      dueDate: row.booking.startAt,
      paymentNotes: row.booking.paymentNotes,
      acceptedPaymentMethodsJson: null,
      cardFeePolicy: "studio_absorbs",
      cardFeePercentBps: 0,
      cardFeeFixedCents: 0,
      cardFeeAmountCents: row.booking.clientFeeCents,
      stripePaymentLink: row.booking.paymentLink,
      zelleInfo: null,
      venmoInfo: null,
      sentAt: null,
      paidAt: row.booking.paidAt,
      createdAt: row.booking.createdAt,
      updatedAt: row.booking.updatedAt,
    } as typeof invoices.$inferSelect;
    const syntheticPayment = {
      id: row.booking.id,
      invoiceId: row.booking.id,
      label: row.meetingType.name,
      amountCents,
      dueDate: row.booking.startAt,
      status: row.booking.paymentStatus,
      paidAt: row.booking.paidAt,
      paymentMethod: row.booking.paymentMethod,
      paidAmountCents: row.booking.paidAmountCents,
      clientFeeCents: row.booking.clientFeeCents,
      processingFeeCents: row.booking.processingFeeCents,
      grossCollectedCents: row.booking.grossCollectedCents,
      netDepositCents: row.booking.netDepositCents,
      externalPaymentId: row.booking.externalPaymentId,
      // Phase 9a: bookings carry no refund/dispute summary (not flipped from a webhook),
      // but the synthetic payment must expose the fields explicitly (undefined would trip
      // the divergence flag: undefined !== 0).
      refundedAmountCents: 0,
      disputeStatus: null,
      disputedAmountCents: 0,
      lastRefundAt: null,
      notes: row.booking.paymentNotes,
      sourceType: row.booking.paymentSourceType,
      sourceId: row.booking.paymentSourceId,
      createdAt: row.booking.createdAt,
      updatedAt: row.booking.updatedAt,
    } as typeof invoicePayments.$inferSelect;

    ledgerRows.push({
      sourceType: "scheduler_booking",
      sourceId: row.booking.id,
      href: `/scheduler/bookings/${row.booking.id}#payment-${encodeURIComponent(row.booking.id)}`,
      paymentSourceType: row.booking.paymentSourceType,
      paymentSourceId: row.booking.paymentSourceId,
      payment: syntheticPayment,
      invoice: syntheticInvoice,
      project: row.project,
      client: row.client,
      clientName: ledgerClientName(row.client),
      openCents: row.booking.paymentStatus === "paid" || row.booking.paymentStatus === "waived"
        ? 0
        : Math.max(amountCents - row.booking.paidAmountCents, 0),
      clientPayableOpenCents: row.booking.paymentStatus === "paid" || row.booking.paymentStatus === "waived"
        ? 0
        : Math.max(amountCents - row.booking.paidAmountCents, 0),
      // Bookings are NOT flipped/summarized from a webhook in 9a. Booking-linked refunds
      // are recorded as child rows (with scheduler_booking_id) and surface in the
      // unlinked-money-events section + period net figures, never on this row.
      refundedAmountCents: 0,
      disputeStatus: null,
      disputedAmountCents: 0,
      succeededRefundCents: 0,
      netCollectedCents: Math.max(row.booking.grossCollectedCents, 0),
    });
  }

  const filteredRows = ledgerRows.filter((row) => (
    paymentLedgerMatchesRange(row, input)
    && (!needsReconciliation || paymentLedgerNeedsReconciliation(row))
  ));

  filteredRows.sort((a, b) => paymentLedgerSortValue(a).localeCompare(paymentLedgerSortValue(b)));

  const invoiceRowsByInvoiceId = new Map<string, PaymentLedgerRow[]>();
  for (const row of filteredRows) {
    if (row.sourceType !== "invoice") continue;
    invoiceRowsByInvoiceId.set(row.invoice.id, [...(invoiceRowsByInvoiceId.get(row.invoice.id) ?? []), row]);
  }
  for (const invoiceRows of invoiceRowsByInvoiceId.values()) {
    const clientPayableOpenCents = !cleanStatus
      ? calculateInvoiceClientPayableBalanceCents(
          invoiceRows[0].invoice,
          invoiceRows.map((row) => row.payment),
        )
      : invoiceRows.reduce((sum, row) => sum + row.openCents, 0);
    for (const row of invoiceRows) {
      row.clientPayableOpenCents = clientPayableOpenCents;
    }
  }

  const totals = filteredRows.reduce<PaymentLedgerReport["totals"]>((sum, row) => ({
    scheduledCents: sum.scheduledCents + row.payment.amountCents,
    paidCents: sum.paidCents + row.payment.paidAmountCents,
    grossCollectedCents: sum.grossCollectedCents + row.payment.grossCollectedCents,
    clientFeeCents: sum.clientFeeCents + row.payment.clientFeeCents,
    processingFeeCents: sum.processingFeeCents + row.payment.processingFeeCents,
    netDepositCents: sum.netDepositCents + row.payment.netDepositCents,
    openCents: sum.openCents + row.openCents,
    clientPayableOpenCents: sum.clientPayableOpenCents + row.openCents,
    refundedCents: sum.refundedCents + row.refundedAmountCents,
    disputedOpenCents: sum.disputedOpenCents + (row.disputeStatus === "open" ? row.disputedAmountCents : 0),
    netCollectedCents: sum.netCollectedCents + row.netCollectedCents,
  }), {
    scheduledCents: 0,
    paidCents: 0,
    grossCollectedCents: 0,
    clientFeeCents: 0,
    processingFeeCents: 0,
    netDepositCents: 0,
    openCents: 0,
    clientPayableOpenCents: 0,
    refundedCents: 0,
    disputedOpenCents: 0,
    netCollectedCents: 0,
  });

  if (!cleanStatus) {
    const invoiceClientPayableOpenCents = Array.from(invoiceRowsByInvoiceId.values())
      .reduce((sum, invoiceRows) => sum + (invoiceRows[0]?.clientPayableOpenCents ?? 0), 0);
    const schedulerOpenCents = filteredRows
      .filter((row) => row.sourceType === "scheduler_booking")
      .reduce((sum, row) => sum + row.openCents, 0);
    totals.clientPayableOpenCents = invoiceClientPayableOpenCents + schedulerOpenCents;
  }

  return {
    rows: filteredRows,
    totals,
    aging: buildAccountsReceivableAging(filteredRows, input.asOfDate?.slice(0, 10) || defaultAsOfDate()),
    unlinkedMoneyEvents: await getUnlinkedMoneyEvents(),
  };
}

// Orphaned refunds/disputes (invoice_payment_id IS NULL) — Stripe money events that
// matched no invoice payment row. Surfaced as their own section (§2.1 N2), never as
// PaymentLedgerRows (they have no payment/invoice to attach to).
async function getUnlinkedMoneyEvents(): Promise<UnlinkedMoneyEvent[]> {
  const [refundRows, disputeRows] = await Promise.all([
    db.select().from(paymentRefunds).where(isNull(paymentRefunds.invoicePaymentId)),
    db.select().from(paymentDisputes).where(isNull(paymentDisputes.invoicePaymentId)),
  ]);
  const events: UnlinkedMoneyEvent[] = [
    ...refundRows.map((row) => ({
      kind: "refund" as const,
      id: row.id,
      stripeId: row.stripeRefundId,
      stripePaymentIntentId: row.stripePaymentIntentId,
      stripeChargeId: row.stripeChargeId,
      schedulerBookingId: row.schedulerBookingId,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
    ...disputeRows.map((row) => ({
      kind: "dispute" as const,
      id: row.id,
      stripeId: row.stripeDisputeId,
      stripePaymentIntentId: row.stripePaymentIntentId,
      stripeChargeId: row.stripeChargeId,
      schedulerBookingId: row.schedulerBookingId,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
  ];
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function centsCsv(value: number) {
  return (value / 100).toFixed(2);
}

export function paymentLedgerCsv(rows: PaymentLedgerRow[]) {
  const header = [
    "Invoice",
    "Project",
    "Client",
    "Payment",
    "Due Date",
    "Paid At",
    "Status",
    "Method",
    "Scheduled",
    "Paid",
    "Gross Collected",
    "Client Fee",
    "Processor Fee",
    "Net Deposit",
    "Open",
    "Client Payable Open",
    "External Payment ID",
    "Notes",
    "Payment Source Type",
    "Payment Source ID",
    "Record Source Type",
    "Record Source ID",
    "Link",
  ];

  const body = rows.map((row) => [
    row.invoice.invoiceNumber,
    row.project.name,
    row.clientName,
    row.payment.label,
    row.payment.dueDate,
    row.payment.paidAt,
    row.payment.status,
    row.payment.paymentMethod,
    centsCsv(row.payment.amountCents),
    centsCsv(row.payment.paidAmountCents),
    centsCsv(row.payment.grossCollectedCents),
    centsCsv(row.payment.clientFeeCents),
    centsCsv(row.payment.processingFeeCents),
    centsCsv(row.payment.netDepositCents),
    centsCsv(row.openCents),
    centsCsv(row.clientPayableOpenCents),
    row.payment.externalPaymentId,
    row.payment.notes,
    row.paymentSourceType,
    row.paymentSourceId,
    row.sourceType,
    row.sourceId,
    row.href,
  ]);

  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function accountsReceivableAgingCsv(aging: PaymentLedgerReport["aging"]) {
  const header = [
    "As Of",
    "Bucket",
    "Invoice",
    "Project",
    "Client",
    "Payment",
    "Due Date",
    "Days Past Due",
    "Open",
    "Status",
    "Source Type",
    "Source ID",
    "Link",
  ];

  const body = aging.rows.map((row) => [
    aging.asOfDate,
    aging.buckets.find((bucket) => bucket.bucket === row.bucket)?.label ?? row.bucket,
    row.invoiceNumber,
    row.projectName,
    row.clientName,
    row.paymentLabel,
    row.dueDate,
    row.daysPastDue,
    centsCsv(row.openCents),
    row.status,
    row.sourceType,
    row.sourceId,
    row.href,
  ]);

  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

export async function createProposalFromForm(formData: FormData) {
  let projectId = textValue(formData, "projectId");
  const clientId = textValue(formData, "clientId");
  const title = textValue(formData, "title");
  if (!title) throw new Error("Proposal title is required.");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const invoiceStatus = "not_created";
  const validUntil = nullableTextValue(formData, "validUntil");
  const proposalPackageTemplateId = nullableTextValue(formData, "proposalPackageTemplateId");
  const proposalPackageTemplate = proposalPackageTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, proposalPackageTemplateId), eq(templates.type, "proposal_package"), eq(templates.status, "active")) })
    : null;
  if (proposalPackageTemplateId && !proposalPackageTemplate) throw new Error("Proposal package template not found.");
  const contractTemplateId = nullableTextValue(formData, "contractTemplateId");
  const contractTemplate = contractTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, contractTemplateId), eq(templates.type, "contract")) })
    : null;
  const formLineItems = packageLineItemsFromForm(formData);
  let packageName = nullableTextValue(formData, "packageName");
  let scopeSummary = nullableTextValue(formData, "scopeSummary");
  const formTotalCents = includedPackageTotalCents(formLineItems);

  if (!projectId && clientId) {
    const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
    if (!client) throw new Error("Client not found.");

    projectId = crypto.randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: `${client.firstName} ${client.lastName ?? ""}`.trim() || title,
      type: "wedding",
      stage: "inquiry",
      status: "active",
      eventDate: null,
      venueName: null,
      venueAddress: null,
      city: null,
      state: null,
      budgetCents: null,
      googleCalendarEventId: null,
      calendarSyncStatus: "not_connected",
      notes: "Created from proposal assignment.",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectParticipants).values({
      id: crypto.randomUUID(),
      projectId,
      clientId,
      role: "primary",
      isPrimaryContact: true,
      createdAt: now,
    });
  }

  if (!projectId) throw new Error("Choose a project or client for this proposal.");

  packageName = packageName ?? proposalPackageTemplate?.subject ?? proposalPackageTemplate?.name ?? null;
  scopeSummary = scopeSummary ?? (
    proposalPackageTemplate?.body
      ? await renderProposalPackageTemplateBody({
          templateBody: proposalPackageTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents: formTotalCents,
        })
      : null
  );
  const contractBodyInput = nullableTextValue(formData, "contractBody");
  const contractBody = contractBodyInput ?? (
    contractTemplate?.body
      ? await renderContractTemplateBody({
          templateBody: contractTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents: formTotalCents,
          scopeSummary,
        })
      : null
  );
  const contractTitle = nullableTextValue(formData, "contractTitle") ?? contractTemplate?.name ?? null;
  const contractStatus = inferredContractStatus({ contractBody, contractTemplateId });

  await db.insert(proposals).values({
    id,
    projectId,
    title,
    status: proposalStatusFromWorkflow({ contractStatus, invoiceStatus, validUntil, packageComplete: packageHasIncludedPricedItem(formLineItems) }),
    packageName,
    totalCents: null,
    validUntil,
    scopeSummary,
    contractStatus,
    contractTemplateId,
    contractTitle,
    contractBody,
    invoiceStatus,
    sentAt: null,
    acceptedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const totalCents = await replaceProposalLineItems(id, formData);
  await db.update(proposals).set({
    totalCents: totalCents || null,
    updatedAt: new Date().toISOString(),
  }).where(eq(proposals.id, id));

  await logActivity({ projectId, action: "proposal.created", metadata: { title, totalCents, proposalPackageTemplateId: proposalPackageTemplate?.id } });
  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId: id, projectId };
}

export async function createProposalFromAgent(projectId: string, input: AgentProposalInput) {
  const title = cleanAgentText(input.title);
  if (!title) throw new Error("Proposal title is required.");

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");
  const sourceType = cleanAgentText(input.sourceType);
  const sourceId = cleanAgentText(input.sourceId);
  await assertAgentProjectSource(projectId, sourceType, sourceId);

  const now = new Date().toISOString();
  const proposalId = crypto.randomUUID();
  const lineItems = normalizedAgentLineItems(input.lineItems ?? []);
  const totalCents = agentIncludedPackageTotalCents(lineItems);
  const validUntil = cleanAgentText(input.validUntil);
  const proposalPackageTemplateId = cleanAgentText(input.proposalPackageTemplateId);
  const proposalPackageTemplate = await activeProposalPackageTemplate(proposalPackageTemplateId);
  const packageName = cleanAgentText(input.packageName) ?? proposalPackageTemplate?.subject ?? proposalPackageTemplate?.name ?? null;
  const scopeSummary = cleanAgentText(input.scopeSummary) ?? (
    proposalPackageTemplate?.body
      ? await renderProposalPackageTemplateBody({
          templateBody: proposalPackageTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents,
        })
      : null
  );
  const contractTemplateId = cleanAgentText(input.contractTemplateId);
  const contractTemplate = await activeContractTemplate(contractTemplateId);
  const contractTitle = cleanAgentText(input.contractTitle) ?? contractTemplate?.name ?? null;
  const contractBody = cleanAgentText(input.contractBody) ?? (
    contractTemplate?.body
      ? await renderContractTemplateBody({
          templateBody: contractTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents,
          scopeSummary,
        })
      : null
  );
  const contractStatus = inferredContractStatus({ contractBody, contractTemplateId });
  const invoiceStatus = "not_created";
  const packageComplete = agentPackageHasIncludedPricedItem(lineItems);
  const status = proposalStatusFromWorkflow({
    contractStatus,
    invoiceStatus,
    validUntil,
    packageComplete,
  });
  const missingFields = proposalMissingFields({ packageComplete, contractStatus, invoiceStatus });

  await db.insert(proposals).values({
    id: proposalId,
    projectId,
    title,
    status,
    packageName,
    totalCents: totalCents || null,
    validUntil,
    scopeSummary,
    contractStatus,
    contractTemplateId,
    contractTitle,
    contractBody,
    invoiceStatus,
    sentAt: null,
    acceptedAt: null,
    sourceType,
    sourceId,
    createdAt: now,
    updatedAt: now,
  });

  await replaceAgentProposalLineItems(proposalId, lineItems, now);

  await logActivity({
    projectId,
    action: "proposal.created_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      proposalId,
      title,
      status,
      totalCents,
      missingFields,
      sourceType,
      sourceId,
      proposalPackageTemplateId: proposalPackageTemplate?.id,
      contractTemplateId: contractTemplate?.id,
    },
  });

  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${proposalId}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId, projectId, status, totalCents, missingFields };
}

export async function updateProposalFromAgent(projectId: string, proposalId: string, input: AgentProposalUpdateInput) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");

  const existingProposal = await db.query.proposals.findFirst({
    where: and(eq(proposals.id, proposalId), eq(proposals.projectId, projectId)),
  });
  if (!existingProposal) throw new Error("Proposal not found for this project.");
  if (proposalIsAcceptedOrSigned(existingProposal)) {
    throw new Error("Accepted or signed proposals cannot be updated by agent.");
  }

  const sourceType = cleanAgentText(input.sourceType) ?? existingProposal.sourceType;
  const sourceId = cleanAgentText(input.sourceId) ?? existingProposal.sourceId;
  await assertAgentProjectSource(projectId, sourceType, sourceId);

  const now = new Date().toISOString();
  const lineItems = Array.isArray(input.lineItems)
    ? normalizedAgentLineItems(input.lineItems)
    : await db.query.proposalLineItems.findMany({
      where: eq(proposalLineItems.proposalId, proposalId),
      orderBy: proposalLineItems.sortOrder,
    });
  const totalCents = agentIncludedPackageTotalCents(lineItems);
  const packageComplete = agentPackageHasIncludedPricedItem(lineItems);
  const validUntil = Object.prototype.hasOwnProperty.call(input, "validUntil")
    ? cleanAgentText(input.validUntil)
    : existingProposal.validUntil;
  const title = Object.prototype.hasOwnProperty.call(input, "title")
    ? cleanAgentText(input.title)
    : existingProposal.title;
  if (!title) throw new Error("Proposal title is required.");
  const proposalPackageTemplateId = cleanAgentText(input.proposalPackageTemplateId);
  const proposalPackageTemplate = await activeProposalPackageTemplate(proposalPackageTemplateId);
  const packageName = proposalPackageTemplate
    ? (cleanAgentText(input.packageName) ?? proposalPackageTemplate.subject ?? proposalPackageTemplate.name)
    : Object.prototype.hasOwnProperty.call(input, "packageName") ? cleanAgentText(input.packageName) : existingProposal.packageName;
  const scopeSummary = proposalPackageTemplate
    ? (cleanAgentText(input.scopeSummary) ?? await renderProposalPackageTemplateBody({
        templateBody: proposalPackageTemplate.body,
        projectId,
        proposalTitle: title,
        packageName,
        totalCents,
      }))
    : Object.prototype.hasOwnProperty.call(input, "scopeSummary") ? cleanAgentText(input.scopeSummary) : existingProposal.scopeSummary;
  const hasContractTemplateInput = Object.prototype.hasOwnProperty.call(input, "contractTemplateId");
  const contractTemplateId = hasContractTemplateInput ? cleanAgentText(input.contractTemplateId) : existingProposal.contractTemplateId;
  const contractTemplate = await activeContractTemplate(contractTemplateId);
  const contractTitle = Object.prototype.hasOwnProperty.call(input, "contractTitle")
    ? cleanAgentText(input.contractTitle) ?? contractTemplate?.name ?? null
    : contractTemplate?.name ?? existingProposal.contractTitle;
  const contractBodyInput = Object.prototype.hasOwnProperty.call(input, "contractBody")
    ? cleanAgentText(input.contractBody)
    : undefined;
  const contractBody = contractBodyInput ?? (
    contractTemplate?.body
      ? await renderContractTemplateBody({
          templateBody: contractTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents,
          scopeSummary,
        })
      : Object.prototype.hasOwnProperty.call(input, "contractBody") ? null : existingProposal.contractBody
  );
  const contractStatus = inferredContractStatus({
    existingStatus: existingProposal.contractStatus,
    contractBody,
    contractTemplateId,
  });
  const status = proposalStatusFromWorkflow({
    currentStatus: existingProposal.status,
    contractStatus,
    invoiceStatus: existingProposal.invoiceStatus,
    validUntil,
    packageComplete,
  });

  await db.update(proposals).set({
    title,
    status,
    packageName,
    totalCents: totalCents || null,
    validUntil,
    scopeSummary,
    contractStatus,
    contractTemplateId,
    contractTitle,
    contractBody,
    sourceType,
    sourceId,
    updatedAt: now,
  }).where(eq(proposals.id, proposalId));

  if (Array.isArray(input.lineItems)) {
    await replaceAgentProposalLineItems(proposalId, lineItems, now);
  }

  const missingFields = proposalMissingFields({ packageComplete, contractStatus, invoiceStatus: existingProposal.invoiceStatus });

  await logActivity({
    projectId,
    action: "proposal.updated_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      proposalId,
      title,
      status,
      totalCents,
      missingFields,
      sourceType,
      sourceId,
      proposalPackageTemplateId: proposalPackageTemplate?.id,
      contractTemplateId: contractTemplate?.id,
    },
  });

  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${proposalId}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId, projectId, status, totalCents, missingFields };
}

export async function createProposalAction(formData: FormData) {
  "use server";

  const result = await createProposalFromForm(formData);
  redirect(`/proposals/${result.proposalId}`);
}

export async function updateProposalFromForm(formData: FormData) {
  const id = textValue(formData, "proposalId");
  const projectId = textValue(formData, "projectId");
  const title = textValue(formData, "title");
  if (!id || !projectId || !title) throw new Error("Proposal, project, and title are required.");

  const existing = await db.query.proposals.findFirst({ where: eq(proposals.id, id) });
  if (!existing) throw new Error("Proposal not found.");
  if (existing.projectId !== projectId) throw new Error("Proposal does not belong to this project.");
  if (proposalIsAcceptedOrSigned(existing)) throw new Error("Accepted or signed proposals cannot be edited.");

  const validUntil = nullableTextValue(formData, "validUntil");
  const proposalPackageTemplateId = nullableTextValue(formData, "proposalPackageTemplateId");
  const proposalPackageTemplate = proposalPackageTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, proposalPackageTemplateId), eq(templates.type, "proposal_package"), eq(templates.status, "active")) })
    : null;
  if (proposalPackageTemplateId && !proposalPackageTemplate) throw new Error("Proposal package template not found.");
  const contractTemplateId = nullableTextValue(formData, "contractTemplateId");
  const contractTemplate = contractTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, contractTemplateId), eq(templates.type, "contract")) })
    : null;
  const totalCents = await replaceProposalLineItems(id, formData);
  const packageName = nullableTextValue(formData, "packageName") ?? proposalPackageTemplate?.subject ?? proposalPackageTemplate?.name ?? null;
  const scopeSummary = nullableTextValue(formData, "scopeSummary") ?? (
    proposalPackageTemplate?.body
      ? await renderProposalPackageTemplateBody({
          templateBody: proposalPackageTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents,
        })
      : null
  );
  const contractBodyInput = nullableTextValue(formData, "contractBody");
  const contractBody = contractBodyInput ?? (
    contractTemplate?.body
      ? await renderContractTemplateBody({
          templateBody: contractTemplate.body,
          projectId,
          proposalTitle: title,
          packageName,
          totalCents,
          scopeSummary,
        })
      : null
  );
  const contractTitle = nullableTextValue(formData, "contractTitle") ?? contractTemplate?.name ?? null;
  const contractStatus = inferredContractStatus({
    existingStatus: existing.contractStatus,
    contractBody,
    contractTemplateId,
  });
  const status = proposalStatusFromWorkflow({
    currentStatus: existing.status,
    contractStatus,
    invoiceStatus: existing.invoiceStatus,
    validUntil,
    packageComplete: totalCents > 0,
  });

  await db.update(proposals).set({
    title,
    status,
    packageName,
    totalCents: totalCents || null,
    validUntil,
    scopeSummary,
    contractStatus,
    contractTemplateId,
    contractTitle,
    contractBody,
    updatedAt: new Date().toISOString(),
  }).where(eq(proposals.id, id));

  await logActivity({ projectId, action: "proposal.updated", metadata: { id, status, proposalPackageTemplateId: proposalPackageTemplate?.id } });
  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${id}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId: id, projectId };
}

export async function updateProposalAction(formData: FormData) {
  "use server";

  const result = await updateProposalFromForm(formData);
  redirect(`/proposals/${result.proposalId}`);
}

export async function updateProposalWorkflowFromForm(formData: FormData) {
  const id = textValue(formData, "proposalId");
  const projectId = textValue(formData, "projectId");
  const workflowAction = textValue(formData, "workflowAction");
  if (!id || !projectId || !workflowAction) throw new Error("Proposal workflow action is required.");

  const existing = await db.query.proposals.findFirst({ where: eq(proposals.id, id) });
  if (!existing) throw new Error("Proposal not found.");
  if (existing.projectId !== projectId) throw new Error("Proposal does not belong to this project.");
  if (proposalIsAcceptedOrSigned(existing) && workflowAction === "reset_draft") {
    throw new Error("Accepted or signed proposals cannot be moved back to draft.");
  }

  if (workflowAction === "create_invoice") {
    const invoiceFormData = new FormData();
    invoiceFormData.set("proposalId", id);
    invoiceFormData.set("projectId", projectId);
    invoiceFormData.set("status", "draft");
    invoiceFormData.set("retainerPercent", "30");
    invoiceFormData.set("installmentCount", "1");
    const result = await createInvoiceFromForm(invoiceFormData);
    return { proposalId: id, projectId, invoiceId: result.invoiceId };
  }

  const now = new Date().toISOString();
  const patch: Partial<typeof proposals.$inferInsert> = { updatedAt: now };

  if (workflowAction === "send") {
    patch.status = "sent";
    patch.sentAt = now;
  }
  if (workflowAction === "accept") {
    patch.status = "accepted";
    patch.acceptedAt = now;
    patch.contractStatus = "signed";
  }
  if (workflowAction === "decline") {
    patch.status = "declined";
  }
  if (workflowAction === "reset_draft") {
    patch.status = "draft";
    patch.sentAt = null;
    patch.acceptedAt = null;
  }

  await db.update(proposals).set(patch).where(eq(proposals.id, id));
  await logActivity({ projectId, action: "proposal.workflow_updated", metadata: { id, workflowAction } });

  safeRevalidatePath("/proposals");
  safeRevalidatePath(`/proposals/${id}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { proposalId: id, projectId };
}

export async function updateProposalWorkflowAction(formData: FormData) {
  "use server";

  const result = await updateProposalWorkflowFromForm(formData);
  redirect(`/proposals/${result.proposalId}`);
}

export async function createInvoiceFromForm(formData: FormData) {
  const proposalId = nullableTextValue(formData, "proposalId");
  const proposal = proposalId ? await db.query.proposals.findFirst({ where: eq(proposals.id, proposalId) }) : null;
  const proposalItems = proposalId
    ? await db.query.proposalLineItems.findMany({ where: eq(proposalLineItems.proposalId, proposalId) })
    : [];

  if (proposalId && !proposal) throw new Error("Proposal not found.");

  const formProjectId = textValue(formData, "projectId");
  const projectId = formProjectId || proposal?.projectId || "";
  if (!projectId) throw new Error("Project is required.");
  if (proposal?.projectId && formProjectId && formProjectId !== proposal.projectId) {
    throw new Error("Selected project does not match the selected proposal.");
  }
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");
  if (proposalId) {
    const existingInvoice = await db.query.invoices.findFirst({ where: eq(invoices.proposalId, proposalId) });
    if (existingInvoice) throw new Error("An invoice already exists for this proposal.");
  }

  const settings = await getAppSettings();
  const enabledMethods = enabledPaymentMethods(settings.paymentMethods);
  const enabledKeys = new Set(enabledMethods.map((method) => method.key));
  const selectedKeys = formValues(formData, "acceptedPaymentMethod")
    .filter(isPaymentMethodKey)
    .filter((key) => enabledKeys.has(key));
  const acceptedKeys = selectedKeys.length ? selectedKeys : enabledMethods.map((method) => method.key);
  const acceptedMethods = acceptedKeys
    .map((key) => ({ key, ...settings.paymentMethods[key] }))
    .filter((method) => method.enabled);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const totalCents = toCents(formData.get("total")) || proposal?.totalCents || dbIncludedPackageTotalCents(proposalItems);
  if (totalCents <= 0) throw new Error("Invoice total is required.");
  const clientPaysCardFees = acceptedKeys.includes("stripe") && settings.paymentMethods.stripe.passFees;
  const cardFeePolicy = clientPaysCardFees ? "client_pays" : "studio_absorbs";
  const cardFeePercentBps = clientPaysCardFees ? DEFAULT_CARD_FEE_PERCENT_BPS : 0;
  const cardFeeFixedCents = clientPaysCardFees ? DEFAULT_CARD_FEE_FIXED_CENTS : 0;
  const cardFeeAmountCents = calculateCardFeeAmountCents({
    subtotalCents: totalCents,
    percentBps: cardFeePercentBps,
    fixedCents: cardFeeFixedCents,
  });
  const retainerAmountCents = toCents(formData.get("retainerAmount"));
  const installmentCount = formNumber(formData, "installmentCount", 1);
  const invoiceNumber = textValue(formData, "invoiceNumber") || `INV-${todayKey()}-${id.slice(0, 6).toUpperCase()}`;
  const dueDate = nullableTextValue(formData, "dueDate");

  await db.insert(invoices).values({
    id,
    projectId,
    proposalId,
    invoiceNumber,
    status: textValue(formData, "status") || "draft",
    totalCents,
    amountPaidCents: 0,
    dueDate,
    paymentNotes: nullableTextValue(formData, "paymentNotes") ?? defaultPaymentNotes(acceptedMethods),
    acceptedPaymentMethodsJson: JSON.stringify(acceptedMethods),
    cardFeePolicy,
    cardFeePercentBps,
    cardFeeFixedCents,
    cardFeeAmountCents,
    stripePaymentLink: nullableTextValue(formData, "stripePaymentLink"),
    zelleInfo: acceptedKeys.includes("zelle") ? settings.paymentMethods.zelle.instructions || null : null,
    venmoInfo: acceptedKeys.includes("venmo") ? settings.paymentMethods.venmo.instructions || null : null,
    createdAt: now,
    updatedAt: now,
  });

  const scheduleRows = normalizedInvoiceScheduleRows({
    invoiceId: id,
    totalCents,
    retainerAmountCents,
    retainerPercent: formNumber(formData, "retainerPercent", 30),
    installmentCount,
    dueDate,
    now,
  });
  if (scheduleRows.length) {
    await db.insert(invoicePayments).values(scheduleRows.map((row) => ({
      id: crypto.randomUUID(),
      ...row,
    })));
  }

  if (proposalId) {
    const proposalPatch: Partial<typeof proposals.$inferInsert> = {
      invoiceStatus: "created",
      updatedAt: now,
    };
    if (!proposal || !proposalIsAcceptedOrSigned(proposal)) {
      proposalPatch.status = proposalStatusFromWorkflow({
        currentStatus: proposal?.status,
        contractStatus: proposal?.contractStatus ?? "not_started",
        invoiceStatus: "created",
        validUntil: proposal?.validUntil,
        packageComplete: dbLineItemsHaveIncludedPricedItem(proposalItems),
      });
    }

    await db.update(proposals).set(proposalPatch).where(eq(proposals.id, proposalId));
  }

  await logActivity({
    projectId,
    action: "invoice.created",
    metadata: {
      invoiceNumber,
      totalCents,
      proposalId,
      cardFeePolicy,
      cardFeeAmountCents,
      clientPayableCents: totalCents + cardFeeAmountCents,
    },
  });
  safeRevalidatePath("/invoices");
  safeRevalidatePath("/proposals");
  if (proposalId) safeRevalidatePath(`/proposals/${proposalId}`);
  safeRevalidatePath(`/projects/${projectId}`);
  return { invoiceId: id, projectId, proposalId };
}

export async function createInvoiceFromAgent(projectId: string, input: AgentInvoiceInput) {
  return requireTylerApprovalForAgentFinance("Invoices and payment schedules require Tyler approval before creation or changes. Agents may draft invoice recommendations as tasks, but cannot create invoices directly.");
}

export async function updateInvoiceFromAgent(projectId: string, invoiceId: string, input: AgentInvoiceUpdateInput) {
  return requireTylerApprovalForAgentFinance("Invoices and payment schedules require Tyler approval before creation or changes. Agents may draft invoice recommendations as tasks, but cannot update invoices directly.");
}

export async function createInvoiceAction(formData: FormData) {
  "use server";

  const { invoiceId } = await createInvoiceFromForm(formData);
  redirect(`/invoices/${invoiceId}`);
}

export async function updateInvoiceStatusFromForm(formData: FormData) {
  const invoiceId = textValue(formData, "invoiceId");
  const projectId = textValue(formData, "projectId");
  const status = textValue(formData, "status") || "draft";
  if (!invoiceId || !projectId) throw new Error("Invoice and project are required.");
  const invoice = (await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) }))!;
  if (!invoice) throw new Error("Invoice not found.");
  if (invoice.projectId !== projectId) throw new Error("Invoice does not belong to this project.");
  if (status === "paid" || status === "partially_paid") {
    throw new Error("Use the invoice payment endpoint to record paid invoice state.");
  }

  await db.update(invoices).set({
    status,
    sentAt: status === "sent" ? new Date().toISOString() : null,
    paidAt: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(invoices.id, invoiceId));

  await logActivity({ projectId, action: "invoice.status_updated", metadata: { invoiceId, status } });
  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoiceId}`);
  return { invoiceId, projectId };
}

export async function updateInvoiceStatusAction(formData: FormData) {
  "use server";

  const { invoiceId } = await updateInvoiceStatusFromForm(formData);
  redirect(`/invoices/${invoiceId}`);
}

export async function logInvoiceReminderFromForm(
  formData: FormData,
  activityOptions: {
    action?: string;
    actorType?: "admin" | "client" | "system" | "agent";
    actorName?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const invoiceId = textValue(formData, "invoiceId");
  const projectId = textValue(formData, "projectId");
  const paymentId = nullableTextValue(formData, "paymentId");
  const templateId = nullableTextValue(formData, "templateId");
  const channel = nullableTextValue(formData, "channel") ?? "manual";
  let note = nullableTextValue(formData, "note");
  if (!invoiceId || !projectId) throw new Error("Invoice and project are required.");
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice) throw new Error("Invoice not found.");
  if (invoice.projectId !== projectId) throw new Error("Invoice does not belong to this project.");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error("Project not found.");
  const primaryRows = await db
    .select({ client: clients })
    .from(projectParticipants)
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(projectParticipants.projectId, projectId))
    .orderBy(desc(projectParticipants.isPrimaryContact), asc(projectParticipants.createdAt));
  const primaryClient = primaryRows[0]?.client ?? null;
  let payment: typeof invoicePayments.$inferSelect | null = null;
  if (paymentId) {
    payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, paymentId) }) ?? null;
    if (!payment || payment.invoiceId !== invoiceId) throw new Error("Payment does not belong to this invoice.");
  }
  const template = templateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, templateId), eq(templates.type, "reminder"), eq(templates.status, "active")) })
    : null;
  if (templateId && !template) throw new Error("Reminder template not found.");
  if (!note && template) {
    note = await renderInvoiceReminderTemplate({
      body: template.body,
      invoice,
      project,
      client: primaryClient,
      payment,
    });
  }

  const activityLogId = await logActivity({
    projectId,
    action: activityOptions.action ?? "invoice.reminder_logged",
    actorType: activityOptions.actorType,
    actorName: activityOptions.actorName,
    metadata: {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      paymentId,
      channel,
      note,
      templateId: template?.id,
      templateName: template?.name,
      ...activityOptions.metadata,
    },
  });

  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoiceId}`);
  safeRevalidatePath(`/projects/${projectId}`);

  return { invoiceId, projectId, activityLogId };
}

export async function logInvoiceReminderFromAgent(invoiceId: string, input: AgentInvoiceReminderInput) {
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice) throw new Error("Invoice not found.");

  const paymentId = cleanAgentText(input.paymentId);
  const sourceType = cleanAgentText(input.sourceType);
  const sourceId = cleanAgentText(input.sourceId);
  await assertAgentProjectSource(invoice.projectId, sourceType, sourceId);

  const formData = new FormData();
  formData.set("invoiceId", invoiceId);
  formData.set("projectId", invoice.projectId);
  if (paymentId) formData.set("paymentId", paymentId);
  formData.set("channel", cleanAgentText(input.channel) ?? "agent");
  if (input.note) formData.set("note", input.note);

  const result = await logInvoiceReminderFromForm(formData, {
    action: "invoice.reminder_logged_by_agent",
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
    metadata: {
      sourceType,
      sourceId,
    },
  });

  return {
    ...result,
    paymentId,
    channel: cleanAgentText(input.channel) ?? "agent",
    sourceType,
    sourceId,
  };
}

export async function updateInvoicePaymentFromForm(
  formData: FormData,
  activityOptions: {
    action?: string;
    actorType?: "admin" | "client" | "system" | "agent";
    actorName?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const invoiceId = textValue(formData, "invoiceId");
  const projectId = textValue(formData, "projectId");
  const paymentId = textValue(formData, "paymentId");
  const status = textValue(formData, "status") || "pending";
  if (!invoiceId || !projectId || !paymentId) throw new Error("Payment is required.");
  const payment = await db.query.invoicePayments.findFirst({ where: eq(invoicePayments.id, paymentId) });
  if (!payment || payment.invoiceId !== invoiceId) throw new Error("Payment not found.");
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  if (!invoice) throw new Error("Invoice not found.");
  if (invoice.projectId !== projectId) throw new Error("Invoice does not belong to this project.");

  const externalPaymentId = nullableTextValue(formData, "externalPaymentId");
  const hasStripeCheckoutUrl = formData.has("stripeCheckoutUrl");
  const hasStripeCheckoutSessionId = formData.has("stripeCheckoutSessionId");
  const hasStripeCheckoutStatus = formData.has("stripeCheckoutStatus");
  const stripeCheckoutUrl = hasStripeCheckoutUrl ? nullableTextValue(formData, "stripeCheckoutUrl") : payment.stripeCheckoutUrl;
  const stripeCheckoutSessionId = hasStripeCheckoutSessionId ? nullableTextValue(formData, "stripeCheckoutSessionId") : payment.stripeCheckoutSessionId;
  const stripeCheckoutStatus = hasStripeCheckoutStatus || hasStripeCheckoutUrl
    ? invoicePaymentCheckoutStatus(nullableTextValue(formData, "stripeCheckoutStatus"), stripeCheckoutUrl)
    : payment.stripeCheckoutStatus;
  if (externalPaymentId) {
    const existingExternalPayment = await db.query.invoicePayments.findFirst({
      where: eq(invoicePayments.externalPaymentId, externalPaymentId),
    });
    if (existingExternalPayment && existingExternalPayment.id !== paymentId) {
      throw new Error("External payment is already linked to another invoice payment.");
    }
    const existingSchedulerPayment = await db.query.schedulerBookings.findFirst({
      where: eq(schedulerBookings.externalPaymentId, externalPaymentId),
    });
    if (existingSchedulerPayment) {
      throw new Error("External payment is already linked to a scheduler booking.");
    }
  }

  const paymentMethod = nullableTextValue(formData, "paymentMethod");
  const paidAmountCents = status === "paid"
    ? toCents(formData.get("paidAmount")) || payment.amountCents
    : 0;
  if (paidAmountCents > payment.amountCents) {
    throw new Error("Paid amount cannot exceed scheduled payment amount.");
  }
  const ledgerAmounts = invoicePaymentLedgerAmounts({
    invoice,
    paymentMethod,
    paidAmountCents,
  });

  const paidAt = status === "paid" ? nullableTextValue(formData, "paidAt") ?? new Date().toISOString() : null;

  await db.update(invoicePayments).set({
    status,
    paidAt,
    paymentMethod,
    ...ledgerAmounts,
    externalPaymentId,
    stripeCheckoutUrl,
    stripeCheckoutSessionId,
    stripeCheckoutStatus,
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  }).where(eq(invoicePayments.id, paymentId));

  const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoiceId) });
  const paidTotal = payments.reduce((sum, payment) => {
    const isThisPayment = payment.id === paymentId;
    const paymentStatus = isThisPayment ? status : payment.status;
    const servicePaidCents = isThisPayment ? ledgerAmounts.paidAmountCents : payment.paidAmountCents;
    return paymentStatus === "paid" ? sum + servicePaidCents : sum;
  }, 0);
  const nextStatus = reconciledInvoicePaymentStatus(invoice, paidTotal);
  const invoicePaidAt = payments
    .filter((payment) => payment.status === "paid" && payment.paidAt)
    .map((payment) => payment.paidAt as string)
    .sort()
    .at(-1) ?? paidAt;

  await db.update(invoices).set({
    amountPaidCents: paidTotal,
    status: nextStatus,
    paidAt: nextStatus === "paid" ? invoicePaidAt : null,
    updatedAt: new Date().toISOString(),
  }).where(eq(invoices.id, invoiceId));

  await logActivity({
    projectId,
    action: activityOptions.action ?? "invoice.payment_updated",
    actorType: activityOptions.actorType,
    actorName: activityOptions.actorName,
    metadata: {
      invoiceId,
      paymentId,
      status,
      paymentMethod,
      paidAt,
      paidAmountCents: ledgerAmounts.paidAmountCents,
      clientFeeCents: ledgerAmounts.clientFeeCents,
      processingFeeCents: ledgerAmounts.processingFeeCents,
      grossCollectedCents: ledgerAmounts.grossCollectedCents,
      netDepositCents: ledgerAmounts.netDepositCents,
      externalPaymentId,
      stripeCheckoutUrl,
      stripeCheckoutSessionId,
      stripeCheckoutStatus,
      ...activityOptions.metadata,
    },
  });
  await autoAdvanceProjectStageForRetainerPayment({
    projectId,
    invoiceId,
    paymentId,
    paymentLabel: payment.label,
    status,
    paidAmountCents: ledgerAmounts.paidAmountCents,
    actorType: activityOptions.actorType,
    actorName: activityOptions.actorName,
    metadata: activityOptions.metadata,
  });
  safeRevalidatePath("/invoices");
  safeRevalidatePath(`/invoices/${invoiceId}`);
  return { invoiceId, projectId, paymentId };
}

export async function recordInvoicePaymentFromAgent(invoiceId: string, input: AgentInvoicePaymentInput) {
  return requireTylerApprovalForAgentFinance("Payments require Tyler approval before creation or changes. Agents may draft payment reconciliation recommendations as tasks, but cannot record payments directly.");
}

export async function updateInvoicePaymentFromAgent(invoiceId: string, input: AgentInvoicePaymentInput) {
  return requireTylerApprovalForAgentFinance("Payments require Tyler approval before creation or changes. Agents may draft payment reconciliation recommendations as tasks, but cannot update payments directly.");
}

export async function updateInvoicePaymentAction(formData: FormData) {
  "use server";

  const { invoiceId } = await updateInvoicePaymentFromForm(formData);
  redirect(`/invoices/${invoiceId}`);
}
