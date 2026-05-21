import { AppShell } from "@/components/AppShell";
import { ProposalPackageBuilder } from "@/components/ProposalPackageBuilder";
import { formatDate, formatMoney } from "@/lib/format";
import { getProposalReadiness } from "@/lib/proposal-readiness";
import { getProposal, listContractTemplateOptions } from "@/lib/sales";
import { Check, ExternalLink, Eye, FileText, FileSignature, Link2, ReceiptText, RotateCcw, Send, Signature } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

function normalizeProposalShareUrl(value?: string) {
  if (!value) return null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SCHEDULE_URL || "http://localhost:3000";

  try {
    const url = new URL(decodeURIComponent(value));
    if (url.pathname.startsWith("/proposal/")) {
      return `${appUrl}${url.pathname}${url.search}`;
    }
    return url.toString();
  } catch {
    return decodeURIComponent(value);
  }
}

function cleanStatus(value: string) {
  return value.replaceAll("_", " ");
}

function workflowSummary({
  proposal,
  readiness,
  hasClientLink,
  hasViewedLink,
  hasInvoice,
}: {
  proposal: NonNullable<Awaited<ReturnType<typeof getProposal>>>["proposal"];
  readiness: ReturnType<typeof getProposalReadiness>;
  hasClientLink: boolean;
  hasViewedLink: boolean;
  hasInvoice: boolean;
}) {
  const isAccepted = proposal.status === "accepted" || Boolean(proposal.acceptedAt);
  const isSigned = Boolean(proposal.signedAt);

  if (proposal.status === "declined") {
    return {
      label: "Declined",
      copy: "This proposal has been declined.",
      nextAction: "Review with the client or reset to draft if this was marked by mistake.",
    };
  }

  if (proposal.status === "expired") {
    return {
      label: "Expired",
      copy: "The valid-until date has passed.",
      nextAction: "Extend the valid-until date before sending again.",
    };
  }

  if (isAccepted && isSigned) {
    return {
      label: "Accepted + signed",
      copy: proposal.signerName ? `Signed by ${proposal.signerName}.` : "Signed from the secure client proposal view.",
      nextAction: hasInvoice ? "Collect payment or mark invoice progress." : "Create the invoice from this proposal.",
    };
  }

  if (isAccepted) {
    return {
      label: "Accepted manually",
      copy: "This was marked accepted in Studio, but no client signature is stored yet.",
      nextAction: "Send the secure link and have the client sign the contract.",
    };
  }

  if (hasViewedLink || proposal.status === "viewed") {
    return {
      label: "Viewed",
      copy: "The client has opened the secure proposal link.",
      nextAction: "Waiting for the client to sign and accept.",
    };
  }

  if (hasClientLink || proposal.status === "sent") {
    return {
      label: "Sent",
      copy: "A secure proposal link has been created for the client.",
      nextAction: "Waiting for the client to view, sign, and accept.",
    };
  }

  if (readiness.ready) {
    return {
      label: "Ready to send",
      copy: "Package, contract, and invoice are ready for the client experience.",
      nextAction: "Create the client proposal link.",
    };
  }

  if (!readiness.packageComplete) {
    return {
      label: "Draft",
      copy: "The package needs at least one included priced item.",
      nextAction: "Finish the package section.",
    };
  }

  if (!readiness.contractReady) {
    return {
      label: "Draft",
      copy: "The proposal needs contract language before it is client-ready.",
      nextAction: "Add or draft the contract section.",
    };
  }

  return {
    label: "Draft",
    copy: "The package and contract are ready, but the invoice/payment schedule is not attached yet.",
    nextAction: "Create the invoice from this proposal.",
  };
}

function ProgressStep({
  label,
  complete,
  current,
  detail,
  icon,
}: {
  label: string;
  complete: boolean;
  current?: boolean;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className={`rounded-md border p-4 ${current ? "border-[var(--accent)] bg-[#f6efe5]" : "border-[var(--line)] bg-[var(--surface)]"}`}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full border ${complete ? "border-[var(--accent)] bg-[#e8ded4]" : "border-[var(--line)] bg-[#faf7f1]"}`}>
          {complete ? <Check className="h-3.5 w-3.5" /> : icon}
        </span>
        {label}
      </div>
      <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">{detail}</p>
    </div>
  );
}

export default async function ProposalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ share?: string }>;
}) {
  const { id } = await params;
  const { share } = await searchParams;
  const [data, contractTemplates] = await Promise.all([
    getProposal(id),
    listContractTemplateOptions(),
  ]);
  if (!data) notFound();
  const shareUrl = normalizeProposalShareUrl(share);
  const readiness = getProposalReadiness({
    lineItems: data.lineItems,
    contractBody: data.proposal.contractBody,
    contractStatus: data.proposal.contractStatus,
    invoiceStatus: data.proposal.invoiceStatus,
  });
  const activeClientLinks = data.accessTokens.filter((token) => !token.revokedAt);
  const hasClientLink = activeClientLinks.length > 0;
  const hasViewedLink = activeClientLinks.some((token) => token.viewedAt);
  const hasInvoice = data.invoices.length > 0 || readiness.invoiceReady;
  const isSigned = Boolean(data.proposal.signedAt);
  const isAccepted = data.proposal.status === "accepted" || Boolean(data.proposal.acceptedAt);
  const summary = workflowSummary({
    proposal: data.proposal,
    readiness,
    hasClientLink,
    hasViewedLink,
    hasInvoice,
  });

  return (
    <AppShell>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-end">
          <div>
            <Link href="/proposals" className="text-sm font-semibold text-[var(--ink-muted)] transition hover:text-[var(--foreground)]">Back to proposals</Link>
            <h1 className="brand-page-title mt-3 text-4xl">{data.proposal.title}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{data.project.name} · {data.client.firstName} {data.client.lastName}</p>
          </div>
          <Link href={`/invoices/new?proposalId=${data.proposal.id}&projectId=${data.project.id}`} className="brand-primary-button inline-flex items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
            <ReceiptText className="h-4 w-4" />
            Create invoice
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Value</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.proposal.totalCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Status</div>
            <div className="mt-2 text-2xl font-semibold">{summary.label}</div>
            <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">{summary.copy}</p>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Contract</div>
            <div className="mt-2 text-2xl font-semibold">{isSigned ? "Signed" : readiness.contractReady ? "Ready" : "Needed"}</div>
            {data.proposal.signerName && <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">{data.proposal.signerName}</p>}
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <div className="text-sm text-[var(--ink-muted)]">Valid until</div>
            <div className="mt-2 text-2xl font-semibold">{formatDate(data.proposal.validUntil)}</div>
          </div>
        </section>

        <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
          <div className="flex flex-col gap-2 border-b border-[var(--line)] pb-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Proposal progress</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">{summary.nextAction}</p>
            </div>
            <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
              {cleanStatus(data.proposal.status)}
            </span>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <ProgressStep label="Package" complete={readiness.packageComplete} current={!readiness.packageComplete} detail={readiness.packageComplete ? "Included package items are priced." : "Add an included priced item."} icon={<FileText className="h-3.5 w-3.5" />} />
            <ProgressStep label="Contract" complete={readiness.contractReady} current={readiness.packageComplete && !readiness.contractReady} detail={readiness.contractReady ? "Contract language is client-ready." : "Add agreement language."} icon={<FileSignature className="h-3.5 w-3.5" />} />
            <ProgressStep label="Invoice" complete={hasInvoice} current={readiness.packageComplete && readiness.contractReady && !hasInvoice} detail={hasInvoice ? "Invoice/payment schedule is attached." : "Create the proposal invoice."} icon={<ReceiptText className="h-3.5 w-3.5" />} />
            <ProgressStep label="Sent" complete={hasClientLink || Boolean(data.proposal.sentAt)} current={readiness.ready && !hasClientLink && !data.proposal.sentAt} detail={hasClientLink || data.proposal.sentAt ? "Secure link has been created or sent." : "Create the secure link."} icon={<Send className="h-3.5 w-3.5" />} />
            <ProgressStep label="Viewed" complete={hasViewedLink || data.proposal.status === "viewed" || isAccepted} current={hasClientLink && !hasViewedLink && !isAccepted} detail={hasViewedLink ? "Client opened the proposal." : "Waiting for client view."} icon={<Eye className="h-3.5 w-3.5" />} />
            <ProgressStep label="Signed" complete={isSigned} current={(hasViewedLink || isAccepted) && !isSigned} detail={isSigned ? "Signature is stored." : "Client signature still required."} icon={<Signature className="h-3.5 w-3.5" />} />
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_420px]">
          <form action={`/api/proposals/${data.proposal.id}`} method="post" className="grid gap-5 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <input type="hidden" name="proposalId" value={data.proposal.id} />
            <input type="hidden" name="projectId" value={data.project.id} />
            <div className="flex flex-col gap-3 border-b border-[var(--line)] pb-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Proposal editor</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Work through the proposal in order: details, package, then contract.</p>
              </div>
              <div className="rounded-md border border-[var(--line)] bg-[#faf7f1] px-3 py-2 text-sm">
                <span className="font-semibold">Status:</span> {summary.label}
              </div>
            </div>

            <nav className="grid gap-2 sm:grid-cols-3" aria-label="Proposal editor steps">
              {[
                ["1", "Details", "#details"],
                ["2", "Package", "#package"],
                ["3", "Contract", "#contract"],
              ].map(([number, label, href]) => (
                <a key={String(label)} href={String(href)} className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 transition hover:border-[var(--brand-brown)] hover:bg-[#f2ebe2]">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Step {number}</div>
                  <div className="mt-1 font-semibold">{label}</div>
                </a>
              ))}
            </nav>

            <section id="details" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
              <div className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">1. Details</div>
                <h3 className="mt-1 text-xl font-semibold">Proposal basics</h3>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1.5 text-sm font-medium">
                  Title
                  <input name="title" defaultValue={data.proposal.title} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Package
                  <input name="packageName" defaultValue={data.proposal.packageName ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Valid until
                  <input name="validUntil" type="date" defaultValue={data.proposal.validUntil ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <div className="rounded-md border border-[var(--line)] bg-[#faf7f1] p-3 text-sm text-[var(--ink-muted)]">
                  Status is automatic: Studio watches package readiness, contract readiness, invoice creation, sending, client views, signatures, acceptance, decline, and expiration.
                </div>
              </div>
            </section>

            <section id="package" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
              <div className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">2. Package</div>
                <h3 className="mt-1 text-xl font-semibold">Package and scope</h3>
              </div>
              <div className="grid gap-4">
                <ProposalPackageBuilder initialItems={data.lineItems} />
                <label className="space-y-1.5 text-sm font-medium">
                  Scope summary
                  <textarea name="scopeSummary" rows={7} defaultValue={data.proposal.scopeSummary ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
              </div>
            </section>

            <section id="contract" className="scroll-mt-6 rounded-md border border-[var(--line)] p-4">
              <div className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">3. Contract</div>
                <h3 className="mt-1 text-xl font-semibold">Agreement language</h3>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">Attach a template or draft the contract here. The client will sign this section in the secure proposal view.</p>
              </div>
              <div className="grid gap-4">
                <label className="space-y-1.5 text-sm font-medium">
                  Contract template
                  <select name="contractTemplateId" defaultValue={data.proposal.contractTemplateId ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none">
                    <option value="">No contract template selected</option>
                    {contractTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Contract title
                  <input name="contractTitle" defaultValue={data.proposal.contractTitle ?? ""} placeholder="Wedding photography agreement" className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Contract draft
                  <textarea name="contractBody" rows={11} defaultValue={data.proposal.contractBody ?? ""} placeholder="Contract language shown in the proposal package." className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none" />
                </label>
              </div>
            </section>

            <button className="brand-primary-button rounded-sm px-4 py-2.5 transition">Save proposal</button>
          </form>

          <aside className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Workflow</h2>
            {shareUrl && (
              <div className="mt-4 rounded-md border border-[var(--accent)] bg-[#f6efe5] p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Link2 className="h-4 w-4" />
                  Client proposal link created
                </div>
                <p className="mt-2 text-sm text-[var(--ink-muted)]">Copy this now. For security, the full token is only shown immediately after creation.</p>
                <input readOnly value={shareUrl} className="mt-3 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-xs outline-none" />
                <a href={shareUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold transition hover:text-[var(--accent)]">
                  Open client view
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}
            <div className="mt-4 grid gap-2">
              <form action={`/api/proposals/${data.proposal.id}/link`} method="post">
                <input type="hidden" name="proposalId" value={data.proposal.id} />
                <input type="hidden" name="projectId" value={data.project.id} />
                <input type="hidden" name="clientId" value={data.client.id} />
                <button className="brand-primary-button inline-flex w-full items-center justify-center gap-2 rounded-sm px-4 py-2.5 transition">
                  <Send className="h-4 w-4" />
                  Create client proposal link
                </button>
              </form>
              <form action={`/api/proposals/${data.proposal.id}/workflow`} method="post">
                <input type="hidden" name="proposalId" value={data.proposal.id} />
                <input type="hidden" name="projectId" value={data.project.id} />
                <input type="hidden" name="workflowAction" value="send" />
                <button className="inline-flex w-full items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <Send className="h-4 w-4" />
                  Mark sent manually
                </button>
              </form>
              <form action={`/api/proposals/${data.proposal.id}/workflow`} method="post" className="grid grid-cols-2 gap-2">
                <input type="hidden" name="proposalId" value={data.proposal.id} />
                <input type="hidden" name="projectId" value={data.project.id} />
                <button name="workflowAction" value="accept" className="rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">Mark accepted manually</button>
                <button name="workflowAction" value="decline" className="rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--danger)] hover:text-[var(--danger)]">Decline</button>
              </form>
              {isAccepted && !isSigned && (
                <div className="rounded-md border border-[var(--warning)] bg-[#fff9e8] p-3 text-xs leading-5 text-[var(--ink-muted)]">
                  <span className="font-semibold text-[var(--foreground)]">Signature missing.</span> Manual acceptance is useful for admin cleanup, but the secure client proposal link should still collect the actual contract signature.
                </div>
              )}
              <form action={`/api/proposals/${data.proposal.id}/workflow`} method="post">
                <input type="hidden" name="proposalId" value={data.proposal.id} />
                <input type="hidden" name="projectId" value={data.project.id} />
                <input type="hidden" name="workflowAction" value="reset_draft" />
                <button className="inline-flex w-full items-center justify-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                  <RotateCcw className="h-4 w-4" />
                  Reset to draft
                </button>
              </form>
            </div>

            <div className="mt-6 flex items-center gap-2">
              <FileSignature className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Contract draft</h2>
            </div>
            <div className="mt-4 rounded-md border border-[var(--line)] p-3">
              <div className="font-semibold">{data.proposal.contractTitle || "No contract selected yet"}</div>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">
                {data.proposal.contractBody || "Add contract language in Proposal details after the package."}
              </p>
            </div>

            <div className="mt-6 flex items-center gap-2">
              <Link2 className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Client links</h2>
            </div>
            <div className="mt-4 space-y-3">
              {data.accessTokens.map((token) => (
                <div key={token.id} className="rounded-md border border-[var(--line)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold">{token.label ?? "Proposal package"}</div>
                    <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
                      {token.revokedAt ? "Revoked" : token.viewedAt ? "Viewed" : "Sent"}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-[var(--ink-muted)]">Created {formatDate(token.createdAt.slice(0, 10))}</div>
                  <div className="text-sm text-[var(--ink-muted)]">Expires {formatDate(token.expiresAt.slice(0, 10))}</div>
                  {token.viewedAt && <div className="text-sm text-[var(--ink-muted)]">Viewed {formatDate(token.viewedAt.slice(0, 10))}</div>}
                </div>
              ))}
              {!data.accessTokens.length && <p className="text-sm text-[var(--ink-muted)]">No secure client proposal link has been created yet.</p>}
            </div>

            <div className="mt-6 flex items-center gap-2">
              <FileText className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="text-lg font-semibold">Linked invoices</h2>
            </div>
            <div className="mt-4 space-y-3">
              {data.invoices.map((invoice) => (
                <Link key={invoice.id} href={`/invoices/${invoice.id}`} className="block rounded-md border border-[var(--line)] p-3 transition hover:bg-[#f6efe5]">
                  <div className="font-semibold">{invoice.invoiceNumber}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatMoney(invoice.totalCents)} · {invoice.status.replaceAll("_", " ")}</div>
                </Link>
              ))}
              {!data.invoices.length && <p className="text-sm text-[var(--ink-muted)]">No invoice created from this proposal yet.</p>}
            </div>
          </aside>
        </section>
      </div>
    </AppShell>
  );
}
