import { db } from "@/db/client";
import { clients, invoicePayments, invoices, projectParticipants, projects, proposalAccessTokens, proposalLineItems, proposals, templates } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { nextProposalStatus } from "@/lib/proposal-readiness";
import { enabledPaymentMethods, getAppSettings, type PaymentMethodKey } from "@/lib/settings";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function textValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function nullableTextValue(formData: FormData, key: string) {
  return textValue(formData, key) || null;
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

function hashProposalToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function proposalBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000";
}

function invoiceBalance(invoice: { totalCents: number; amountPaidCents: number }) {
  return Math.max(invoice.totalCents - invoice.amountPaidCents, 0);
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
  { value: "partially_paid", label: "Partially paid" },
  { value: "paid", label: "Paid" },
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

type ProjectOptionRow = {
  project: typeof projects.$inferSelect;
  client: typeof clients.$inferSelect;
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
};

export async function listProjectOptions() {
  const rows = await db
    .select({
      project: projects,
      client: clients,
    })
    .from(projectParticipants)
    .innerJoin(projects, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .orderBy(desc(projects.createdAt)) as unknown as ProjectOptionRow[];

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

  return db
    .select({
      proposal: proposals,
      project: projects,
      client: clients,
    })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(proposals.createdAt)) as unknown as Promise<ProposalRow[]>;
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
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, proposalId)) as unknown as ProposalRow[];

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

  const now = new Date().toISOString();
  const token = randomBytes(32).toString("base64url");
  const url = `${proposalBaseUrl()}/proposal/${token}`;

  await db.insert(proposalAccessTokens).values({
    id: crypto.randomUUID(),
    proposalId,
    projectId,
    clientId,
    tokenHash: hashProposalToken(token),
    label: textValue(formData, "label") || "Client proposal package",
    expiresAt: addTokenDays(45),
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
    metadata: { proposalId, expiresAt: addTokenDays(45) },
  });

  revalidatePath("/proposals");
  revalidatePath(`/proposals/${proposalId}`);
  revalidatePath(`/projects/${projectId}`);

  return { proposalId, projectId, url };
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
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, tokenRow.proposalId)) as unknown as ProposalRow[];

  const row = rows.find((candidate) => candidate.client.id === tokenRow.clientId) ?? rows[0];
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
      actorName: `${row.client.firstName} ${row.client.lastName ?? ""}`.trim(),
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
      balanceCents: invoiceBalance(invoice),
    })),
  };
}

export async function acceptProposalByToken(
  token: string,
  lastUsedIp?: string | null,
  signature?: { signerName: string; signerEmail: string | null; selectedOptionalLineItemIds?: string[] },
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
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .where(eq(proposals.id, tokenRow.proposalId)) as unknown as ProposalRow[];

  const row = rows.find((candidate) => candidate.client.id === tokenRow.clientId) ?? rows[0];
  if (!row || ["declined", "expired"].includes(row.proposal.status)) return null;

  const now = new Date().toISOString();
  const firstAcceptance = !row.proposal.acceptedAt;
  const firstSignature = !row.proposal.signedAt;
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

  await db.update(proposalAccessTokens).set({
    viewedAt: tokenRow.viewedAt ?? now,
    lastUsedAt: now,
    lastUsedIp: lastUsedIp ?? null,
  }).where(eq(proposalAccessTokens.id, tokenRow.id));

  await db.update(proposals).set({
    status: "accepted",
    acceptedAt: row.proposal.acceptedAt ?? now,
    signedAt: row.proposal.signedAt ?? now,
    signerName: row.proposal.signerName ?? signature.signerName,
    signerEmail: row.proposal.signerEmail ?? signature.signerEmail,
    contractStatus: "signed",
    totalCents: acceptedTotalCents,
    updatedAt: now,
  }).where(eq(proposals.id, row.proposal.id));

  if (firstAcceptance) {
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "proposal.accepted",
      actorType: "client",
      actorName: `${row.client.firstName} ${row.client.lastName ?? ""}`.trim(),
      metadata: { proposalId: row.proposal.id, selectedOptionalLineItemIds: validSelectedOptionalLineItemIds },
    });
  }

  if (firstSignature) {
    await logActivity({
      projectId: tokenRow.projectId,
      clientId: tokenRow.clientId,
      action: "proposal.signed",
      actorType: "client",
      actorName: signature.signerName,
      metadata: { proposalId: row.proposal.id, signerEmail: signature.signerEmail },
    });
  }

  revalidatePath("/proposals");
  revalidatePath(`/proposals/${row.proposal.id}`);
  revalidatePath(`/projects/${tokenRow.projectId}`);
  revalidatePath(`/proposal/${token}`);

  return { proposalId: row.proposal.id, projectId: tokenRow.projectId };
}

export async function listInvoices(search = "", status = "all") {
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

  return db
    .select({
      invoice: invoices,
      project: projects,
      client: clients,
      proposal: proposals,
    })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .leftJoin(proposals, eq(invoices.proposalId, proposals.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(invoices.createdAt)) as unknown as Promise<InvoiceRow[]>;
}

export async function getInvoice(invoiceId: string) {
  const rows = await db
    .select({
      invoice: invoices,
      project: projects,
      client: clients,
      proposal: proposals,
    })
    .from(invoices)
    .innerJoin(projects, eq(invoices.projectId, projects.id))
    .innerJoin(projectParticipants, eq(projectParticipants.projectId, projects.id))
    .innerJoin(clients, eq(projectParticipants.clientId, clients.id))
    .leftJoin(proposals, eq(invoices.proposalId, proposals.id))
    .where(eq(invoices.id, invoiceId)) as unknown as InvoiceRow[];

  const row = rows[0];
  if (!row) return null;

  const payments = await db.query.invoicePayments.findMany({
    where: eq(invoicePayments.invoiceId, invoiceId),
    orderBy: desc(invoicePayments.createdAt),
  });

  return { ...row, payments, balanceCents: invoiceBalance(row.invoice) };
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
  const contractTemplateId = nullableTextValue(formData, "contractTemplateId");
  const contractTemplate = contractTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, contractTemplateId), eq(templates.type, "contract")) })
    : null;
  const contractBody = nullableTextValue(formData, "contractBody") ?? contractTemplate?.body ?? null;
  const contractTitle = nullableTextValue(formData, "contractTitle") ?? contractTemplate?.name ?? null;
  const formLineItems = packageLineItemsFromForm(formData);
  const contractStatus = inferredContractStatus({ contractBody, contractTemplateId });

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

  await db.insert(proposals).values({
    id,
    projectId,
    title,
    status: proposalStatusFromWorkflow({ contractStatus, invoiceStatus, validUntil, packageComplete: packageHasIncludedPricedItem(formLineItems) }),
    packageName: nullableTextValue(formData, "packageName"),
    totalCents: null,
    validUntil,
    scopeSummary: nullableTextValue(formData, "scopeSummary"),
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

  await logActivity({ projectId, action: "proposal.created", metadata: { title, totalCents } });
  revalidatePath("/proposals");
  revalidatePath(`/projects/${projectId}`);

  return { proposalId: id, projectId };
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

  const validUntil = nullableTextValue(formData, "validUntil");
  const contractTemplateId = nullableTextValue(formData, "contractTemplateId");
  const contractTemplate = contractTemplateId
    ? await db.query.templates.findFirst({ where: and(eq(templates.id, contractTemplateId), eq(templates.type, "contract")) })
    : null;
  const contractBody = nullableTextValue(formData, "contractBody") ?? contractTemplate?.body ?? null;
  const contractTitle = nullableTextValue(formData, "contractTitle") ?? contractTemplate?.name ?? null;
  const contractStatus = inferredContractStatus({
    existingStatus: existing.contractStatus,
    contractBody,
    contractTemplateId,
  });
  const totalCents = await replaceProposalLineItems(id, formData);
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
    packageName: nullableTextValue(formData, "packageName"),
    totalCents: totalCents || null,
    validUntil,
    scopeSummary: nullableTextValue(formData, "scopeSummary"),
    contractStatus,
    contractTemplateId,
    contractTitle,
    contractBody,
    updatedAt: new Date().toISOString(),
  }).where(eq(proposals.id, id));

  await logActivity({ projectId, action: "proposal.updated", metadata: { id, status } });
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${id}`);
  revalidatePath(`/projects/${projectId}`);

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

  revalidatePath("/proposals");
  revalidatePath(`/proposals/${id}`);
  revalidatePath(`/projects/${projectId}`);

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
  const retainerCents = toCents(formData.get("retainerAmount")) || Math.round(totalCents * (formNumber(formData, "retainerPercent", 30) / 100));
  const installmentCount = Math.max(formNumber(formData, "installmentCount", 1), 0);
  const remainingCents = Math.max(totalCents - retainerCents, 0);
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
    stripePaymentLink: null,
    zelleInfo: acceptedKeys.includes("zelle") ? settings.paymentMethods.zelle.instructions || null : null,
    venmoInfo: acceptedKeys.includes("venmo") ? settings.paymentMethods.venmo.instructions || null : null,
    createdAt: now,
    updatedAt: now,
  });

  if (retainerCents > 0) {
    await db.insert(invoicePayments).values({
      id: crypto.randomUUID(),
      invoiceId: id,
      label: "Retainer",
      amountCents: retainerCents,
      dueDate,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  if (remainingCents > 0 && installmentCount > 0) {
    const baseAmount = Math.floor(remainingCents / installmentCount);
    let allocated = 0;
    for (let index = 0; index < installmentCount; index += 1) {
      const isLast = index === installmentCount - 1;
      const amountCents = isLast ? remainingCents - allocated : baseAmount;
      allocated += amountCents;
      await db.insert(invoicePayments).values({
        id: crypto.randomUUID(),
        invoiceId: id,
        label: installmentCount === 1 ? "Final payment" : `Payment ${index + 1}`,
        amountCents,
        dueDate: addDays(dueDate, 30 * (index + 1)),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  if (proposalId) {
    await db.update(proposals).set({
      invoiceStatus: "created",
      status: proposalStatusFromWorkflow({
        currentStatus: proposal?.status,
        contractStatus: proposal?.contractStatus ?? "not_started",
        invoiceStatus: "created",
        validUntil: proposal?.validUntil,
        packageComplete: dbLineItemsHaveIncludedPricedItem(proposalItems),
      }),
      updatedAt: now,
    }).where(eq(proposals.id, proposalId));
  }

  await logActivity({ projectId, action: "invoice.created", metadata: { invoiceNumber, totalCents, proposalId } });
  revalidatePath("/invoices");
  revalidatePath("/proposals");
  if (proposalId) revalidatePath(`/proposals/${proposalId}`);
  revalidatePath(`/projects/${projectId}`);
  return { invoiceId: id, projectId, proposalId };
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

  await db.update(invoices).set({
    status,
    sentAt: status === "sent" ? new Date().toISOString() : null,
    paidAt: status === "paid" ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  }).where(eq(invoices.id, invoiceId));

  await logActivity({ projectId, action: "invoice.status_updated", metadata: { invoiceId, status } });
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  return { invoiceId, projectId };
}

export async function updateInvoiceStatusAction(formData: FormData) {
  "use server";

  const { invoiceId } = await updateInvoiceStatusFromForm(formData);
  redirect(`/invoices/${invoiceId}`);
}

export async function updateInvoicePaymentFromForm(formData: FormData) {
  const invoiceId = textValue(formData, "invoiceId");
  const projectId = textValue(formData, "projectId");
  const paymentId = textValue(formData, "paymentId");
  const status = textValue(formData, "status") || "pending";
  if (!invoiceId || !projectId || !paymentId) throw new Error("Payment is required.");

  await db.update(invoicePayments).set({
    status,
    paidAt: status === "paid" ? new Date().toISOString() : null,
    paymentMethod: nullableTextValue(formData, "paymentMethod"),
    notes: nullableTextValue(formData, "notes"),
    updatedAt: new Date().toISOString(),
  }).where(eq(invoicePayments.id, paymentId));

  const payments = await db.query.invoicePayments.findMany({ where: eq(invoicePayments.invoiceId, invoiceId) });
  const paidTotal = payments.reduce((sum, payment) => {
    const isThisPayment = payment.id === paymentId;
    const paymentStatus = isThisPayment ? status : payment.status;
    return paymentStatus === "paid" ? sum + payment.amountCents : sum;
  }, 0);
  const invoice = await db.query.invoices.findFirst({ where: eq(invoices.id, invoiceId) });
  const nextStatus = invoice && paidTotal >= invoice.totalCents ? "paid" : paidTotal > 0 ? "partially_paid" : invoice?.status ?? "draft";

  await db.update(invoices).set({
    amountPaidCents: paidTotal,
    status: nextStatus,
    paidAt: nextStatus === "paid" ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  }).where(eq(invoices.id, invoiceId));

  await logActivity({ projectId, action: "invoice.payment_updated", metadata: { invoiceId, paymentId, status } });
  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
  return { invoiceId, projectId, paymentId };
}

export async function updateInvoicePaymentAction(formData: FormData) {
  "use server";

  const { invoiceId } = await updateInvoicePaymentFromForm(formData);
  redirect(`/invoices/${invoiceId}`);
}
