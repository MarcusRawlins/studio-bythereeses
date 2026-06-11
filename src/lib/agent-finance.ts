import { db } from "@/db/client";
import { projectSources } from "@/db/schema";
import { getBookkeepingReport } from "@/lib/bookkeeping";
import { getPaymentLedgerReport } from "@/lib/sales";
import { inArray } from "drizzle-orm";

type AgentFinanceReportInput = {
  paymentStatus?: string | null;
  expenseStatus?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  asOfDate?: string | null;
};

function cleanStatus(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

type CanonicalizationRecord = {
  ledger: "payment_ledger" | "expense_ledger";
  recordType: string;
  recordId: string;
  projectId: string | null;
  externalPaymentId: string | null;
  sourceType: string | null;
  sourceId: string | null;
};

function missingPaymentEvidence(row: Awaited<ReturnType<typeof getPaymentLedgerReport>>["rows"][number]) {
  if (row.payment.status !== "paid") return [];
  const missing: string[] = [];
  if (!row.payment.externalPaymentId) missing.push("external_payment_id");
  if (!row.paymentSourceType || !row.paymentSourceId) missing.push("source");
  return missing;
}

function missingExpenseEvidence(row: Awaited<ReturnType<typeof getBookkeepingReport>>["expenses"][number]) {
  if (row.expense.status !== "paid") return [];
  const missing: string[] = [];
  if (!row.expense.externalPaymentId) missing.push("external_payment_id");
  if (!row.expense.receiptUrl) missing.push("receipt_url");
  if (!row.expense.sourceType || !row.expense.sourceId) missing.push("source");
  return missing;
}

function buildReconciliationSummary({
  paymentRows,
  expenseRows,
}: {
  paymentRows: Awaited<ReturnType<typeof getPaymentLedgerReport>>["rows"];
  expenseRows: Awaited<ReturnType<typeof getBookkeepingReport>>["expenses"];
}) {
  const evidenceCounts = new Map<string, { evidence: string; paymentCount: number; expenseCount: number; totalCount: number }>();
  const ensureEvidence = (evidence: string) => {
    const existing = evidenceCounts.get(evidence);
    if (existing) return existing;
    const row = { evidence, paymentCount: 0, expenseCount: 0, totalCount: 0 };
    evidenceCounts.set(evidence, row);
    return row;
  };
  const paymentReconciliationRows = paymentRows.flatMap((row) => {
    const missingEvidence = missingPaymentEvidence(row);
    if (!missingEvidence.length) return [];
    for (const evidence of missingEvidence) {
      const count = ensureEvidence(evidence);
      count.paymentCount += 1;
      count.totalCount += 1;
    }
    return [{
      recordType: row.sourceType,
      recordId: row.sourceId,
      paymentId: row.payment.id,
      paymentLabel: row.payment.label,
      projectId: row.project.id,
      projectName: row.project.name,
      clientName: row.clientName,
      paidAt: row.payment.paidAt,
      paidCents: row.payment.paidAmountCents,
      externalPaymentId: row.payment.externalPaymentId,
      paymentSourceType: row.paymentSourceType,
      paymentSourceId: row.paymentSourceId,
      href: row.href,
      missingEvidence,
    }];
  });

  const expenseReconciliationRows = expenseRows.flatMap((row) => {
    const missingEvidence = missingExpenseEvidence(row);
    if (!missingEvidence.length) return [];
    for (const evidence of missingEvidence) {
      const count = ensureEvidence(evidence);
      count.expenseCount += 1;
      count.totalCount += 1;
    }
    return [{
      id: row.expense.id,
      vendorName: row.vendor.name,
      projectId: row.project?.id ?? null,
      projectName: row.project?.name ?? null,
      paidAt: row.expense.paidAt,
      amountCents: row.expense.amountCents,
      externalPaymentId: row.expense.externalPaymentId,
      receiptUrl: row.expense.receiptUrl,
      sourceType: row.expense.sourceType,
      sourceId: row.expense.sourceId,
      href: `/finance?expenseId=${encodeURIComponent(row.expense.id)}#expense-${encodeURIComponent(row.expense.id)}`,
      missingEvidence,
    }];
  });

  return {
    paymentCount: paymentReconciliationRows.length,
    expenseCount: expenseReconciliationRows.length,
    totalCount: paymentReconciliationRows.length + expenseReconciliationRows.length,
    missingEvidenceCounts: Array.from(evidenceCounts.values())
      .sort((a, b) => b.totalCount - a.totalCount || a.evidence.localeCompare(b.evidence)),
    paymentRows: paymentReconciliationRows,
    expenseRows: expenseReconciliationRows,
  };
}

async function financeCanonicalizationReport(records: CanonicalizationRecord[]) {
  const externalPaymentGroups = new Map<string, CanonicalizationRecord[]>();
  for (const record of records) {
    if (!record.externalPaymentId) continue;
    const group = externalPaymentGroups.get(record.externalPaymentId) ?? [];
    group.push(record);
    externalPaymentGroups.set(record.externalPaymentId, group);
  }

  const duplicateExternalPaymentIds = Array.from(externalPaymentGroups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([externalPaymentId, group]) => ({
      externalPaymentId,
      count: group.length,
      records: group.map((record) => ({
        ledger: record.ledger,
        recordType: record.recordType,
        recordId: record.recordId,
        projectId: record.projectId,
        externalPaymentId: record.externalPaymentId,
      })),
    }));

  const linkedProjectSourceRecords = records.filter((record) => record.sourceType === "project_source" && record.sourceId);
  const sourceIds = Array.from(new Set(linkedProjectSourceRecords.flatMap((record) => record.sourceId ? [record.sourceId] : [])));
  const sourceRows = sourceIds.length > 0
    ? await db.select().from(projectSources).where(inArray(projectSources.id, sourceIds))
    : [];
  const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
  const orphanedSourceLinks = linkedProjectSourceRecords.flatMap((record) => {
    const source = record.sourceId ? sourceById.get(record.sourceId) : null;
    if (!source) {
      return [{
        ledger: record.ledger,
        recordType: record.recordType,
        recordId: record.recordId,
        projectId: record.projectId,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        reason: "missing_project_source",
      }];
    }
    if (record.projectId && source.projectId !== record.projectId) {
      return [{
        ledger: record.ledger,
        recordType: record.recordType,
        recordId: record.recordId,
        projectId: record.projectId,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        reason: "project_source_project_mismatch",
      }];
    }
    return [];
  });

  return {
    issueCount: duplicateExternalPaymentIds.length + orphanedSourceLinks.length,
    duplicateExternalPaymentIds,
    orphanedSourceLinks,
  };
}

function buildProjectFinancials({
  paymentRows,
  expenseRows,
}: {
  paymentRows: Awaited<ReturnType<typeof getPaymentLedgerReport>>["rows"];
  expenseRows: Awaited<ReturnType<typeof getBookkeepingReport>>["expenses"];
}) {
  const byProject = new Map<string, {
    projectId: string;
    projectName: string;
    clientId: string | null;
    clientName: string | null;
    scheduledCents: number;
    paidCents: number;
    grossCollectedCents: number;
    clientFeeCents: number;
    processingFeeCents: number;
    netDepositCents: number;
    openCents: number;
    clientPayableOpenCents: number;
    expenseCents: number;
    paidExpenseCents: number;
    openPayableCents: number;
    taxDeductibleExpenseCents: number;
    nonDeductibleExpenseCents: number;
    paymentCount: number;
    expenseCount: number;
    href: string;
    clientPayableInvoiceIds: Set<string>;
  }>();

  function ensureProject(projectId: string, projectName: string, clientId: string | null, clientName: string | null) {
    const existing = byProject.get(projectId);
    if (existing) {
      existing.clientId ??= clientId;
      existing.clientName ??= clientName;
      return existing;
    }
    const row = {
      projectId,
      projectName,
      clientId,
      clientName,
      scheduledCents: 0,
      paidCents: 0,
      grossCollectedCents: 0,
      clientFeeCents: 0,
      processingFeeCents: 0,
      netDepositCents: 0,
      openCents: 0,
      clientPayableOpenCents: 0,
      expenseCents: 0,
      paidExpenseCents: 0,
      openPayableCents: 0,
      taxDeductibleExpenseCents: 0,
      nonDeductibleExpenseCents: 0,
      paymentCount: 0,
      expenseCount: 0,
      href: `/projects/${projectId}`,
      clientPayableInvoiceIds: new Set<string>(),
    };
    byProject.set(projectId, row);
    return row;
  }

  for (const row of paymentRows) {
    const statement = ensureProject(row.project.id, row.project.name, row.client?.id ?? null, row.clientName);
    statement.scheduledCents += row.payment.amountCents;
    statement.paidCents += row.payment.paidAmountCents;
    statement.grossCollectedCents += row.payment.grossCollectedCents;
    statement.clientFeeCents += row.payment.clientFeeCents;
    statement.processingFeeCents += row.payment.processingFeeCents;
    statement.netDepositCents += row.payment.netDepositCents;
    statement.openCents += row.openCents;
    if (row.sourceType === "invoice") {
      if (!statement.clientPayableInvoiceIds.has(row.invoice.id)) {
        statement.clientPayableInvoiceIds.add(row.invoice.id);
        statement.clientPayableOpenCents += row.clientPayableOpenCents;
      }
    } else {
      statement.clientPayableOpenCents += row.clientPayableOpenCents;
    }
    statement.paymentCount += 1;
  }

  for (const row of expenseRows) {
    if (!row.project) continue;
    const statement = ensureProject(row.project.id, row.project.name, null, null);
    statement.expenseCents += row.expense.amountCents;
    if (row.expense.status === "paid") {
      statement.paidExpenseCents += row.expense.amountCents;
    }
    if (row.expense.status === "unpaid") {
      statement.openPayableCents += row.expense.amountCents;
    }
    if (row.expense.taxDeductible) {
      statement.taxDeductibleExpenseCents += row.expense.amountCents;
    } else {
      statement.nonDeductibleExpenseCents += row.expense.amountCents;
    }
    statement.expenseCount += 1;
  }

  return Array.from(byProject.values())
    .map((row) => ({
      projectId: row.projectId,
      projectName: row.projectName,
      clientId: row.clientId,
      clientName: row.clientName,
      scheduledCents: row.scheduledCents,
      paidCents: row.paidCents,
      grossCollectedCents: row.grossCollectedCents,
      clientFeeCents: row.clientFeeCents,
      processingFeeCents: row.processingFeeCents,
      netDepositCents: row.netDepositCents,
      openCents: row.openCents,
      clientPayableOpenCents: row.clientPayableOpenCents,
      expenseCents: row.expenseCents,
      paidExpenseCents: row.paidExpenseCents,
      openPayableCents: row.openPayableCents,
      taxDeductibleExpenseCents: row.taxDeductibleExpenseCents,
      nonDeductibleExpenseCents: row.nonDeductibleExpenseCents,
      paymentCount: row.paymentCount,
      expenseCount: row.expenseCount,
      href: row.href,
      collectedProfitCents: row.netDepositCents - row.paidExpenseCents,
      projectedProfitCents: row.scheduledCents - row.expenseCents,
    }))
    .sort((a, b) => b.clientPayableOpenCents - a.clientPayableOpenCents || b.openCents - a.openCents || b.scheduledCents - a.scheduledCents || a.projectName.localeCompare(b.projectName));
}

export async function getAgentFinanceReport(input: AgentFinanceReportInput = {}) {
  const [paymentLedger, bookkeeping] = await Promise.all([
    getPaymentLedgerReport({
      status: cleanStatus(input.paymentStatus, "all"),
      fromDate: input.fromDate,
      toDate: input.toDate,
      asOfDate: input.asOfDate,
    }),
    getBookkeepingReport({
      status: cleanStatus(input.expenseStatus, "paid"),
      fromDate: input.fromDate,
      toDate: input.toDate,
    }),
  ]);
  const projectFinancials = buildProjectFinancials({
    paymentRows: paymentLedger.rows,
    expenseRows: bookkeeping.expenses,
  });
  const reconciliation = buildReconciliationSummary({
    paymentRows: paymentLedger.rows,
    expenseRows: bookkeeping.expenses,
  });
  const canonicalizationRecords: CanonicalizationRecord[] = [
    ...paymentLedger.rows.map((row) => ({
      ledger: "payment_ledger" as const,
      recordType: row.sourceType,
      recordId: row.sourceId,
      projectId: row.project.id,
      externalPaymentId: row.payment.externalPaymentId,
      sourceType: row.paymentSourceType,
      sourceId: row.paymentSourceId,
    })),
    ...bookkeeping.expenses.map((row) => ({
      ledger: "expense_ledger" as const,
      recordType: "expense",
      recordId: row.expense.id,
      projectId: row.project?.id ?? null,
      externalPaymentId: row.expense.externalPaymentId,
      sourceType: row.expense.sourceType,
      sourceId: row.expense.sourceId,
    })),
  ];
  const canonicalization = await financeCanonicalizationReport(canonicalizationRecords);

  return {
    period: {
      fromDate: input.fromDate ?? null,
      toDate: input.toDate ?? null,
      asOfDate: paymentLedger.aging.asOfDate,
    },
    paymentLedger: {
      totals: paymentLedger.totals,
      aging: {
        ...paymentLedger.aging,
        rows: paymentLedger.aging.rows.map((row) => ({
          ...row,
          paymentId: row.sourceId,
        })),
      },
      rows: paymentLedger.rows.map((row) => {
        const missingEvidence = missingPaymentEvidence(row);
        return {
          recordType: row.sourceType,
          recordId: row.sourceId,
          href: row.href,
          invoiceId: row.invoice.id,
          invoiceNumber: row.invoice.invoiceNumber,
          paymentId: row.payment.id,
          paymentLabel: row.payment.label,
          projectId: row.project.id,
          projectName: row.project.name,
          clientId: row.client?.id ?? null,
          clientName: row.clientName,
          dueDate: row.payment.dueDate,
          paidAt: row.payment.paidAt,
          status: row.payment.status,
          paymentMethod: row.payment.paymentMethod,
          scheduledCents: row.payment.amountCents,
          paidCents: row.payment.paidAmountCents,
          grossCollectedCents: row.payment.grossCollectedCents,
          clientFeeCents: row.payment.clientFeeCents,
          processingFeeCents: row.payment.processingFeeCents,
          netDepositCents: row.payment.netDepositCents,
          openCents: row.openCents,
          clientPayableOpenCents: row.clientPayableOpenCents,
          externalPaymentId: row.payment.externalPaymentId,
          notes: row.payment.notes,
          paymentSourceType: row.paymentSourceType,
          paymentSourceId: row.paymentSourceId,
          needsReconciliation: missingEvidence.length > 0,
          missingEvidence,
        };
      }),
    },
    bookkeeping: {
      totals: bookkeeping.totals,
      expensesByCategory: bookkeeping.expensesByCategory,
      expensesByVendor: bookkeeping.expensesByVendor,
      expenses: bookkeeping.expenses.map((row) => {
        const missingEvidence = missingExpenseEvidence(row);
        return {
          id: row.expense.id,
          vendorId: row.vendor.id,
          vendorName: row.vendor.name,
          projectId: row.project?.id ?? null,
          projectName: row.project?.name ?? null,
          category: row.expense.category,
          description: row.expense.description,
          amountCents: row.expense.amountCents,
          status: row.expense.status,
          paidAt: row.expense.paidAt,
          paymentMethod: row.expense.paymentMethod,
          externalPaymentId: row.expense.externalPaymentId,
          receiptUrl: row.expense.receiptUrl,
          taxDeductible: row.expense.taxDeductible,
          notes: row.expense.notes,
          sourceType: row.expense.sourceType,
          sourceId: row.expense.sourceId,
          needsReconciliation: missingEvidence.length > 0,
          missingEvidence,
        };
      }),
    },
    reconciliation,
    projectFinancials,
    canonicalization,
  };
}
