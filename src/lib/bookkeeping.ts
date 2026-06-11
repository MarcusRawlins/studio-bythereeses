import { db } from "@/db/client";
import { activityLogs, expenses, invoicePayments, projects, schedulerBookings, vendors } from "@/db/schema";
import { and, asc, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";

export type CreateExpenseInput = {
  projectId?: string | null;
  vendorName: string;
  category: string;
  description?: string | null;
  amountCents: number;
  status?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  externalPaymentId?: string | null;
  receiptUrl?: string | null;
  taxDeductible?: boolean | null;
  notes?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  actorType?: string | null;
  actorName?: string | null;
};

export type AgentExpenseInput = Omit<CreateExpenseInput, "projectId" | "actorType" | "actorName">;
export type AgentExpenseUpdateInput = Partial<AgentExpenseInput>;

export type UpdateExpenseInput = Partial<CreateExpenseInput> & {
  expenseId: string;
  projectScopeId?: string | null;
};

export type ExpenseLedgerRow = {
  expense: typeof expenses.$inferSelect;
  vendor: typeof vendors.$inferSelect;
  project: typeof projects.$inferSelect | null;
};

export type BookkeepingReport = {
  expenses: ExpenseLedgerRow[];
  expensesByCategory: Array<{
    category: string;
    expenseCents: number;
    taxDeductibleExpenseCents: number;
    count: number;
  }>;
  expensesByVendor: Array<{
    vendorId: string;
    vendorName: string;
    expenseCents: number;
    taxDeductibleExpenseCents: number;
    count: number;
  }>;
  totals: {
    revenueCents: number;
    grossCollectedCents: number;
    clientFeeCents: number;
    processingFeeCents: number;
    netDepositCents: number;
    expenseCents: number;
    paidExpenseCents: number;
    openPayableCents: number;
    taxDeductibleExpenseCents: number;
    nonDeductibleExpenseCents: number;
    netIncomeCents: number;
  };
};

export type BookkeepingReportInput = {
  status?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
};

function cleanText(value: string | null | undefined) {
  return value?.trim() || null;
}

function normalizeVendorName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanStatus(value: string | null | undefined) {
  return cleanText(value) ?? "paid";
}

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function formNullableText(formData: FormData, key: string) {
  return formText(formData, key) || null;
}

function formCents(formData: FormData, key: string) {
  const number = Number(String(formData.get(key) ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 100);
}

function expenseStatusFilter(status: string | null | undefined) {
  const clean = cleanText(status);
  if (!clean || clean === "all") return undefined;
  if (clean === "needs_reconciliation") {
    return and(
      eq(expenses.status, "paid"),
      or(
        isNull(expenses.externalPaymentId),
        isNull(expenses.receiptUrl),
        isNull(expenses.sourceId),
      ),
    );
  }
  return eq(expenses.status, clean);
}

function isoFloorForDate(date: string) {
  return `${date}T00:00:00.000Z`;
}

function isoCeilingForDate(date: string) {
  return `${date}T23:59:59.999Z`;
}

function expenseReportConditions(input: BookkeepingReportInput) {
  const conditions: SQL[] = [];
  const status = expenseStatusFilter(input.status);
  if (status) conditions.push(status);
  if (input.fromDate) conditions.push(gte(expenses.paidAt, input.fromDate));
  if (input.toDate) conditions.push(lte(expenses.paidAt, input.toDate));
  return conditions.length ? and(...conditions) : undefined;
}

function payableExpenseConditions(input: BookkeepingReportInput) {
  const conditions: SQL[] = [eq(expenses.status, "unpaid")];
  if (input.fromDate) conditions.push(gte(expenses.paidAt, input.fromDate));
  if (input.toDate) conditions.push(lte(expenses.paidAt, input.toDate));
  return and(...conditions);
}

function paidRevenueConditions(column: typeof invoicePayments.paidAt | typeof schedulerBookings.paidAt, input: BookkeepingReportInput) {
  const conditions: SQL[] = [];
  if (input.fromDate) conditions.push(gte(column, isoFloorForDate(input.fromDate)));
  if (input.toDate) conditions.push(lte(column, isoCeilingForDate(input.toDate)));
  return conditions;
}

async function findOrCreateVendor(vendorName: string) {
  const name = cleanText(vendorName);
  if (!name) throw new Error("Vendor name is required.");

  const normalizedName = normalizeVendorName(name);
  const existing = await db.query.vendors.findFirst({
    where: eq(vendors.normalizedName, normalizedName),
  });
  if (existing) return existing;

  const now = new Date().toISOString();
  const vendor = {
    id: crypto.randomUUID(),
    name,
    normalizedName,
    email: null,
    websiteUrl: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(vendors).values(vendor);
  return vendor;
}

async function assertProjectSource(projectId: string | null, sourceType: string | null, sourceId: string | null) {
  if (!sourceType && sourceId) {
    throw new Error("Expense source links require sourceType when sourceId is set.");
  }
  if (sourceType !== "project_source") return;
  if (!projectId) {
    throw new Error("Project is required for project source links.");
  }
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

export async function createExpense(input: CreateExpenseInput) {
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Expense amount is required.");
  }

  const projectId = cleanText(input.projectId);
  const sourceType = cleanText(input.sourceType);
  const sourceId = cleanText(input.sourceId);
  if (projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new Error("Project not found.");
  }
  await assertProjectSource(projectId, sourceType, sourceId);

  const vendor = await findOrCreateVendor(input.vendorName);
  const now = new Date().toISOString();
  const externalPaymentId = cleanText(input.externalPaymentId);
  const expense = {
    id: crypto.randomUUID(),
    vendorId: vendor.id,
    projectId,
    category: cleanText(input.category) ?? "general",
    description: cleanText(input.description) ?? cleanText(input.category) ?? "Expense",
    amountCents: Math.round(input.amountCents),
    status: cleanStatus(input.status),
    paidAt: cleanText(input.paidAt),
    paymentMethod: cleanText(input.paymentMethod),
    externalPaymentId,
    receiptUrl: cleanText(input.receiptUrl),
    taxDeductible: input.taxDeductible ?? true,
    notes: cleanText(input.notes),
    sourceType,
    sourceId,
    createdAt: now,
    updatedAt: now,
  };

  const existingExpense = externalPaymentId
    ? await db.query.expenses.findFirst({ where: eq(expenses.externalPaymentId, externalPaymentId) })
    : null;
  if (existingExpense) {
    const updatedExpense = {
      ...expense,
      id: existingExpense.id,
      createdAt: existingExpense.createdAt,
    };
    await db.update(expenses).set({
      vendorId: updatedExpense.vendorId,
      projectId: updatedExpense.projectId,
      category: updatedExpense.category,
      description: updatedExpense.description,
      amountCents: updatedExpense.amountCents,
      status: updatedExpense.status,
      paidAt: updatedExpense.paidAt,
      paymentMethod: updatedExpense.paymentMethod,
      externalPaymentId: updatedExpense.externalPaymentId,
      receiptUrl: updatedExpense.receiptUrl,
      taxDeductible: updatedExpense.taxDeductible,
      notes: updatedExpense.notes,
      sourceType: updatedExpense.sourceType,
      sourceId: updatedExpense.sourceId,
      updatedAt: updatedExpense.updatedAt,
    }).where(eq(expenses.id, existingExpense.id));
    if (projectId) {
      const actorType = cleanText(input.actorType) ?? "admin";
      await db.insert(activityLogs).values({
        id: crypto.randomUUID(),
        projectId,
        clientId: null,
        action: actorType === "agent" ? "expense.updated_by_agent" : "expense.updated",
        actorType,
        actorName: cleanText(input.actorName) ?? (actorType === "agent" ? "The Reeses Studio Agent" : "The Reeses Studio"),
        metadata: JSON.stringify({
          expenseId: updatedExpense.id,
          vendorId: vendor.id,
          category: updatedExpense.category,
          amountCents: updatedExpense.amountCents,
          externalPaymentId,
          sourceType,
          sourceId,
        }),
        createdAt: now,
      });
    }
    return updatedExpense;
  }

  await db.insert(expenses).values(expense);
  if (projectId) {
    const actorType = cleanText(input.actorType) ?? "admin";
    await db.insert(activityLogs).values({
      id: crypto.randomUUID(),
      projectId,
      clientId: null,
      action: actorType === "agent" ? "expense.created_by_agent" : "expense.created",
      actorType,
      actorName: cleanText(input.actorName) ?? (actorType === "agent" ? "The Reeses Studio Agent" : "The Reeses Studio"),
      metadata: JSON.stringify({
        expenseId: expense.id,
        vendorId: vendor.id,
        category: expense.category,
        amountCents: expense.amountCents,
        sourceType,
        sourceId,
      }),
      createdAt: now,
    });
  }

  return expense;
}

export async function createExpenseFromAgent(projectId: string, input: AgentExpenseInput) {
  const expense = await createExpense({
    ...input,
    projectId,
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });
  const vendor = expense.vendorId
    ? await db.query.vendors.findFirst({ where: eq(vendors.id, expense.vendorId) })
    : null;

  return {
    id: expense.id,
    vendorId: expense.vendorId,
    vendorName: vendor?.name ?? input.vendorName.trim(),
    projectId: expense.projectId,
    category: expense.category,
    description: expense.description,
    amountCents: expense.amountCents,
    status: expense.status,
    paidAt: expense.paidAt,
    paymentMethod: expense.paymentMethod,
    externalPaymentId: expense.externalPaymentId,
    receiptUrl: expense.receiptUrl,
    taxDeductible: expense.taxDeductible,
    notes: expense.notes,
    sourceType: expense.sourceType,
    sourceId: expense.sourceId,
  };
}

function expenseAgentResult(expense: typeof expenses.$inferSelect, vendor: typeof vendors.$inferSelect | null) {
  return {
    id: expense.id,
    vendorId: expense.vendorId,
    vendorName: vendor?.name ?? "Unknown vendor",
    projectId: expense.projectId,
    category: expense.category,
    description: expense.description,
    amountCents: expense.amountCents,
    status: expense.status,
    paidAt: expense.paidAt,
    paymentMethod: expense.paymentMethod,
    externalPaymentId: expense.externalPaymentId,
    receiptUrl: expense.receiptUrl,
    taxDeductible: expense.taxDeductible,
    notes: expense.notes,
    sourceType: expense.sourceType,
    sourceId: expense.sourceId,
  };
}

export async function updateExpense(input: UpdateExpenseInput) {
  const expenseId = cleanText(input.expenseId);
  if (!expenseId) throw new Error("Expense id is required.");

  const existingExpense = await db.query.expenses.findFirst({
    where: input.projectScopeId
      ? and(eq(expenses.id, expenseId), eq(expenses.projectId, input.projectScopeId))
      : eq(expenses.id, expenseId),
  });
  if (!existingExpense) throw new Error(input.projectScopeId ? "Expense not found for this project." : "Expense not found.");

  const projectId = Object.prototype.hasOwnProperty.call(input, "projectId")
    ? cleanText(input.projectId)
    : existingExpense.projectId;
  if (projectId) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new Error("Project not found.");
  }

  const sourceType = Object.prototype.hasOwnProperty.call(input, "sourceType")
    ? cleanText(input.sourceType)
    : existingExpense.sourceType;
  const sourceId = Object.prototype.hasOwnProperty.call(input, "sourceId")
    ? cleanText(input.sourceId)
    : existingExpense.sourceId;
  await assertProjectSource(projectId, sourceType, sourceId);

  const vendor = Object.prototype.hasOwnProperty.call(input, "vendorName") && input.vendorName
    ? await findOrCreateVendor(input.vendorName)
    : existingExpense.vendorId
      ? await db.query.vendors.findFirst({ where: eq(vendors.id, existingExpense.vendorId) })
      : null;
  if (!vendor) throw new Error("Vendor not found.");

  const amountCents = Object.prototype.hasOwnProperty.call(input, "amountCents")
    ? Math.round(Number(input.amountCents ?? 0))
    : existingExpense.amountCents;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Expense amount is required.");
  }

  const externalPaymentId = Object.prototype.hasOwnProperty.call(input, "externalPaymentId")
    ? cleanText(input.externalPaymentId)
    : existingExpense.externalPaymentId;
  if (externalPaymentId) {
    const conflictingExpense = await db.query.expenses.findFirst({
      where: eq(expenses.externalPaymentId, externalPaymentId),
    });
    if (conflictingExpense && conflictingExpense.id !== expenseId) {
      throw new Error("External payment is already linked to another expense.");
    }
  }

  const now = new Date().toISOString();
  const actorType = cleanText(input.actorType) ?? "admin";
  const actorName = cleanText(input.actorName) ?? (actorType === "agent" ? "The Reeses Studio Agent" : "The Reeses Studio");
  await db.update(expenses).set({
    vendorId: vendor.id,
    projectId,
    category: Object.prototype.hasOwnProperty.call(input, "category") ? cleanText(input.category) ?? "general" : existingExpense.category,
    description: Object.prototype.hasOwnProperty.call(input, "description") ? cleanText(input.description) ?? "Expense" : existingExpense.description,
    amountCents,
    status: Object.prototype.hasOwnProperty.call(input, "status") ? cleanStatus(input.status) : existingExpense.status,
    paidAt: Object.prototype.hasOwnProperty.call(input, "paidAt") ? cleanText(input.paidAt) : existingExpense.paidAt,
    paymentMethod: Object.prototype.hasOwnProperty.call(input, "paymentMethod") ? cleanText(input.paymentMethod) : existingExpense.paymentMethod,
    externalPaymentId,
    receiptUrl: Object.prototype.hasOwnProperty.call(input, "receiptUrl") ? cleanText(input.receiptUrl) : existingExpense.receiptUrl,
    taxDeductible: Object.prototype.hasOwnProperty.call(input, "taxDeductible") ? input.taxDeductible ?? true : existingExpense.taxDeductible,
    notes: Object.prototype.hasOwnProperty.call(input, "notes") ? cleanText(input.notes) : existingExpense.notes,
    sourceType,
    sourceId,
    updatedAt: now,
  }).where(eq(expenses.id, expenseId));

  if (projectId) {
    await db.insert(activityLogs).values({
      id: crypto.randomUUID(),
      projectId,
      clientId: null,
      action: actorType === "agent" ? "expense.updated_by_agent" : "expense.updated",
      actorType,
      actorName,
      metadata: JSON.stringify({
        expenseId,
        vendorId: vendor.id,
        category: Object.prototype.hasOwnProperty.call(input, "category") ? cleanText(input.category) ?? "general" : existingExpense.category,
        amountCents,
        externalPaymentId,
        sourceType,
        sourceId,
      }),
      createdAt: now,
    });
  }

  const updatedExpense = await db.query.expenses.findFirst({ where: eq(expenses.id, expenseId) });
  if (!updatedExpense) throw new Error("Expense update failed.");
  return expenseAgentResult(updatedExpense, vendor);
}

export async function updateExpenseFromAgent(projectId: string, expenseId: string, input: AgentExpenseUpdateInput) {
  return updateExpense({
    ...input,
    expenseId,
    projectId,
    projectScopeId: projectId,
    actorType: "agent",
    actorName: "The Reeses Studio Agent",
  });
}

export async function createExpenseFromForm(formData: FormData) {
  return createExpense({
    projectId: formNullableText(formData, "projectId"),
    vendorName: formText(formData, "vendorName"),
    category: formText(formData, "category"),
    description: formNullableText(formData, "description"),
    amountCents: formCents(formData, "amount"),
    status: formNullableText(formData, "status"),
    paidAt: formNullableText(formData, "paidAt"),
    paymentMethod: formNullableText(formData, "paymentMethod"),
    externalPaymentId: formNullableText(formData, "externalPaymentId"),
    receiptUrl: formNullableText(formData, "receiptUrl"),
    taxDeductible: formData.get("taxDeductible") === "on",
    notes: formNullableText(formData, "notes"),
  });
}

export async function updateExpenseFromForm(formData: FormData) {
  return updateExpense({
    expenseId: formText(formData, "expenseId"),
    projectId: formNullableText(formData, "projectId"),
    vendorName: formText(formData, "vendorName"),
    category: formText(formData, "category"),
    description: formNullableText(formData, "description"),
    amountCents: formCents(formData, "amount"),
    status: formNullableText(formData, "status"),
    paidAt: formNullableText(formData, "paidAt"),
    paymentMethod: formNullableText(formData, "paymentMethod"),
    externalPaymentId: formNullableText(formData, "externalPaymentId"),
    receiptUrl: formNullableText(formData, "receiptUrl"),
    taxDeductible: formData.get("taxDeductible") === "on",
    notes: formNullableText(formData, "notes"),
  });
}

export async function getBookkeepingReport(input: BookkeepingReportInput = {}): Promise<BookkeepingReport> {
  const rows = await db
    .select({
      expense: expenses,
      vendor: vendors,
      project: projects,
    })
    .from(expenses)
    .innerJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .where(expenseReportConditions(input))
    .orderBy(asc(expenses.paidAt), asc(expenses.createdAt)) as ExpenseLedgerRow[];

  const paidRows = await db
    .select({ payment: invoicePayments })
    .from(invoicePayments)
    .where(and(
      eq(invoicePayments.status, "paid"),
      ...paidRevenueConditions(invoicePayments.paidAt, input),
    )) as Array<{ payment: typeof invoicePayments.$inferSelect }>;
  const paidBookingRows = await db
    .select({ booking: schedulerBookings })
    .from(schedulerBookings)
    .where(and(
      eq(schedulerBookings.paymentStatus, "paid"),
      ...paidRevenueConditions(schedulerBookings.paidAt, input),
    )) as Array<{ booking: typeof schedulerBookings.$inferSelect }>;
  const payableRows = await db
    .select({ expense: expenses })
    .from(expenses)
    .where(payableExpenseConditions(input)) as Array<{ expense: typeof expenses.$inferSelect }>;

  const invoiceRevenueCents = paidRows.reduce((sum, row) => sum + row.payment.paidAmountCents, 0);
  const schedulerRevenueCents = paidBookingRows.reduce((sum, row) => sum + row.booking.paidAmountCents, 0);
  const revenueCents = invoiceRevenueCents + schedulerRevenueCents;
  const grossCollectedCents = paidRows.reduce((sum, row) => sum + row.payment.grossCollectedCents, 0)
    + paidBookingRows.reduce((sum, row) => sum + row.booking.grossCollectedCents, 0);
  const clientFeeCents = paidRows.reduce((sum, row) => sum + row.payment.clientFeeCents, 0)
    + paidBookingRows.reduce((sum, row) => sum + row.booking.clientFeeCents, 0);
  const processingFeeCents = paidRows.reduce((sum, row) => sum + row.payment.processingFeeCents, 0)
    + paidBookingRows.reduce((sum, row) => sum + row.booking.processingFeeCents, 0);
  const netDepositCents = paidRows.reduce((sum, row) => sum + row.payment.netDepositCents, 0)
    + paidBookingRows.reduce((sum, row) => sum + row.booking.netDepositCents, 0);
  const expenseCents = rows.reduce((sum, row) => sum + row.expense.amountCents, 0);
  const paidExpenseCents = rows.reduce((sum, row) => sum + (row.expense.status === "paid" ? row.expense.amountCents : 0), 0);
  const openPayableCents = payableRows.reduce((sum, row) => sum + row.expense.amountCents, 0);
  const taxDeductibleExpenseCents = rows.reduce((sum, row) => sum + (row.expense.taxDeductible ? row.expense.amountCents : 0), 0);
  const byCategory = new Map<string, {
    category: string;
    expenseCents: number;
    taxDeductibleExpenseCents: number;
    count: number;
  }>();
  const byVendor = new Map<string, {
    vendorId: string;
    vendorName: string;
    expenseCents: number;
    taxDeductibleExpenseCents: number;
    count: number;
  }>();

  for (const row of rows) {
    const category = row.expense.category || "general";
    const categorySummary = byCategory.get(category) ?? {
      category,
      expenseCents: 0,
      taxDeductibleExpenseCents: 0,
      count: 0,
    };
    categorySummary.expenseCents += row.expense.amountCents;
    categorySummary.taxDeductibleExpenseCents += row.expense.taxDeductible ? row.expense.amountCents : 0;
    categorySummary.count += 1;
    byCategory.set(category, categorySummary);

    const vendorSummary = byVendor.get(row.vendor.id) ?? {
      vendorId: row.vendor.id,
      vendorName: row.vendor.name,
      expenseCents: 0,
      taxDeductibleExpenseCents: 0,
      count: 0,
    };
    vendorSummary.expenseCents += row.expense.amountCents;
    vendorSummary.taxDeductibleExpenseCents += row.expense.taxDeductible ? row.expense.amountCents : 0;
    vendorSummary.count += 1;
    byVendor.set(row.vendor.id, vendorSummary);
  }

  const sortSummary = <T extends { expenseCents: number; count: number }>(a: T, b: T) => (
    b.expenseCents - a.expenseCents || b.count - a.count
  );

  return {
    expenses: rows,
    expensesByCategory: Array.from(byCategory.values()).sort(sortSummary),
    expensesByVendor: Array.from(byVendor.values()).sort(sortSummary),
    totals: {
      revenueCents,
      grossCollectedCents,
      clientFeeCents,
      processingFeeCents,
      netDepositCents,
      expenseCents,
      paidExpenseCents,
      openPayableCents,
      taxDeductibleExpenseCents,
      nonDeductibleExpenseCents: expenseCents - taxDeductibleExpenseCents,
      netIncomeCents: netDepositCents - paidExpenseCents,
    },
  };
}

function csvCell(value: string | number | boolean | null | undefined) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function centsCsv(value: number) {
  return (value / 100).toFixed(2);
}

export function expensesCsv(rows: ExpenseLedgerRow[], options: {
  expenseStatus?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
} = {}) {
  const header = [
    "Date",
    "Status",
    "Vendor",
    "Project",
    "Category",
    "Description",
    "Amount",
    "Payment Method",
    "External Payment ID",
    "Tax Deductible",
    "Receipt URL",
    "Notes",
    "Source Type",
    "Source ID",
    "Expense ID",
    "Link",
  ];
  const body = rows.map((row) => {
    const linkParams = new URLSearchParams({
      expenseId: row.expense.id,
      expenseStatus: options.expenseStatus ?? row.expense.status,
    });
    if (options.fromDate) linkParams.set("fromDate", options.fromDate);
    if (options.toDate) linkParams.set("toDate", options.toDate);

    return [
      row.expense.paidAt,
      row.expense.status,
      row.vendor.name,
      row.project?.name,
      row.expense.category,
      row.expense.description,
      centsCsv(row.expense.amountCents),
      row.expense.paymentMethod,
      row.expense.externalPaymentId,
      row.expense.taxDeductible ? "yes" : "no",
      row.expense.receiptUrl,
      row.expense.notes,
      row.expense.sourceType,
      row.expense.sourceId,
      row.expense.id,
      `/finance?${linkParams.toString()}`,
    ];
  });

  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function bookkeepingSummaryCsv(report: BookkeepingReport, options: {
  expenseStatus?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
} = {}) {
  const header = ["Section", "Name", "Count", "Amount", "Tax Deductible Amount", "Notes"];
  const rows: Array<Array<string | number | null | undefined>> = [
    ["Period", "From", null, options.fromDate || "all", null, null],
    ["Period", "To", null, options.toDate || "all", null, null],
    ["Period", "Expense status", null, options.expenseStatus || "all", null, null],
    ["Totals", "Service revenue", null, centsCsv(report.totals.revenueCents), null, "Paid invoice and scheduler service revenue"],
    ["Totals", "Gross collected", null, centsCsv(report.totals.grossCollectedCents), null, "Client payments including client-paid fees"],
    ["Totals", "Client-paid fees", null, centsCsv(report.totals.clientFeeCents), null, "Fees assigned to clients"],
    ["Totals", "Processor fees", null, centsCsv(report.totals.processingFeeCents), null, "Processor fees recorded on settlement rows"],
    ["Totals", "Net deposits", null, centsCsv(report.totals.netDepositCents), null, "Cash after processor fees"],
    ["Totals", "Paid expenses", null, centsCsv(report.totals.paidExpenseCents), null, "Paid expenses in the selected expense status view"],
    ["Totals", "Open payables", null, centsCsv(report.totals.openPayableCents), null, "Unpaid vendor costs still owed"],
    ["Totals", "Tax deductible expenses", null, centsCsv(report.totals.taxDeductibleExpenseCents), null, "Expenses marked deductible"],
    ["Totals", "Non-deductible expenses", null, centsCsv(report.totals.nonDeductibleExpenseCents), null, "Expenses not marked deductible"],
    ["Totals", "Net income", null, centsCsv(report.totals.netIncomeCents), null, "Net deposits minus paid expenses"],
    ...report.expensesByCategory.map((row) => [
      "Expense category",
      row.category,
      row.count,
      centsCsv(row.expenseCents),
      centsCsv(row.taxDeductibleExpenseCents),
      null,
    ]),
    ...report.expensesByVendor.map((row) => [
      "Vendor",
      row.vendorName,
      row.count,
      centsCsv(row.expenseCents),
      centsCsv(row.taxDeductibleExpenseCents),
      null,
    ]),
  ];

  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
