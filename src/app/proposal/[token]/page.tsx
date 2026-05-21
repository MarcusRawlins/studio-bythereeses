import { ClientProposalExperience } from "@/components/ClientProposalExperience";
import { getProposalPackageByToken } from "@/lib/sales";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ClientProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ accepted?: string; signature?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const data = await getProposalPackageByToken(token, ip);
  if (!data) notFound();

  const clientName = data.client.preferredName || data.client.firstName;
  const location = [data.project.venueName, data.project.city, data.project.state].filter(Boolean).join(" · ");

  return (
    <ClientProposalExperience
      token={token}
      clientName={clientName}
      projectName={data.project.name}
      projectDate={data.project.eventDate}
      projectLocation={location}
      proposalTitle={data.proposal.title}
      packageName={data.proposal.packageName}
      totalCents={data.proposal.totalCents}
      validUntil={data.accessToken.expiresAt}
      scopeSummary={data.proposal.scopeSummary}
      proposalStatus={data.proposal.status}
      acceptedAt={data.proposal.acceptedAt}
      signedAt={data.proposal.signedAt}
      signerName={data.proposal.signerName}
      signerEmail={data.proposal.signerEmail}
      clientEmail={data.client.email}
      acceptedNotice={query.accepted === "1"}
      signatureError={query.signature ?? null}
      contractTitle={data.proposal.contractTitle}
      contractBody={data.proposal.contractBody}
      lineItems={data.lineItems.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        isOptional: item.isOptional,
      }))}
      invoices={data.invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalCents: invoice.totalCents,
        balanceCents: invoice.balanceCents,
        acceptedPaymentMethodsJson: invoice.acceptedPaymentMethodsJson,
        paymentNotes: invoice.paymentNotes,
        payments: invoice.payments.map((payment) => ({
          id: payment.id,
          label: payment.label,
          dueDate: payment.dueDate,
          amountCents: payment.amountCents,
        })),
      }))}
    />
  );
}
