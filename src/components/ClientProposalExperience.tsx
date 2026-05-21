"use client";

import { formatDate, formatMoney } from "@/lib/format";
import { buildProposalInvoicePreview, buildSelectedProposalPackage } from "@/lib/proposal-client-experience";
import type { ProposalPreviewLineItem } from "@/lib/proposal-client-experience";
import { ArrowRight, CalendarDays, CheckCircle2, Clock, Mail, MapPin } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

type ProposalStep = "welcome" | "proposal" | "invoice" | "contract";

type ClientProposalExperienceProps = {
  token: string;
  clientName: string;
  projectName: string;
  projectDate: string | null;
  projectLocation: string;
  proposalTitle: string;
  packageName: string | null;
  totalCents: number | null;
  validUntil: string;
  scopeSummary: string | null;
  proposalStatus: string;
  acceptedAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  signerEmail: string | null;
  clientEmail: string | null;
  acceptedNotice: boolean;
  signatureError: string | null;
  contractTitle: string | null;
  contractBody: string | null;
  lineItems: {
    id: string;
    name: string;
    description: string | null;
    quantity: number;
    unitPriceCents: number;
    isOptional: boolean;
  }[];
  invoices: {
    id: string;
    invoiceNumber: string;
    status: string;
    totalCents: number;
    balanceCents: number;
    acceptedPaymentMethodsJson: string | null;
    paymentNotes: string | null;
    payments: {
      id: string;
      label: string;
      dueDate: string | null;
      amountCents: number;
    }[];
  }[];
};

const steps: { key: ProposalStep; label: string; helper: string }[] = [
  { key: "proposal", label: "Proposal", helper: "Package and scope" },
  { key: "invoice", label: "Invoice", helper: "Payment schedule" },
  { key: "contract", label: "Contract", helper: "Agreement preview" },
];

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function parseAcceptedPaymentMethods(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Array<{ key: string; displayName: string; instructions?: string; passFees?: boolean }>;
    return Array.isArray(parsed) ? parsed.filter((method) => method.displayName) : [];
  } catch {
    return [];
  }
}

export function ClientProposalExperience({
  token,
  clientName,
  projectName,
  projectDate,
  projectLocation,
  proposalTitle,
  packageName,
  totalCents,
  validUntil,
  scopeSummary,
  proposalStatus,
  acceptedAt,
  signedAt,
  signerName,
  signerEmail,
  clientEmail,
  acceptedNotice,
  signatureError,
  contractTitle,
  contractBody,
  lineItems,
  invoices,
}: ClientProposalExperienceProps) {
  const isAccepted = proposalStatus === "accepted" || Boolean(acceptedAt);
  const isSigned = Boolean(signedAt);
  const [step, setStep] = useState<ProposalStep>(isAccepted || acceptedNotice ? "contract" : "welcome");
  const [selectedOptionalLineItemIds, setSelectedOptionalLineItemIds] = useState<string[]>([]);
  const selectedPackage = useMemo(
    () => buildSelectedProposalPackage({ lineItems, selectedOptionalLineItemIds }),
    [lineItems, selectedOptionalLineItemIds],
  );
  const includedItems = selectedPackage.includedItems;
  const optionalItems = useMemo(() => lineItems.filter((item) => item.isOptional), [lineItems]);
  const invoicePreview = useMemo(
    () => buildProposalInvoicePreview({ totalCents, scopeSummary, lineItems, selectedOptionalLineItemIds }),
    [totalCents, scopeSummary, lineItems, selectedOptionalLineItemIds],
  );
  const displayTotalCents = selectedPackage.totalCents || totalCents;

  function toggleOptionalLineItem(id: string) {
    setSelectedOptionalLineItemIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]);
  }

  return (
    <main className="min-h-screen bg-[#f4f1ec] px-4 py-8 text-[var(--foreground)] sm:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex justify-center">
          <Link href="https://bythereeses.com" aria-label="The Reeses website">
            <Image src="/brand/alex-tyler-logo.png" alt="Alex & Tyler" width={240} height={80} className="h-14 w-auto" priority />
          </Link>
        </header>

        {step === "welcome" ? (
          <section className="flex min-h-[620px] items-center justify-center rounded-md border border-[var(--line)] bg-[#eef1f1] px-6 py-16 shadow-sm">
            <div className="mx-auto max-w-2xl text-center">
              <Image src="/brand/at-badge-dark.png" alt="A&T" width={80} height={80} className="mx-auto h-14 w-auto opacity-80" />
              <h1 className="mt-16 text-4xl font-semibold leading-tight md:text-6xl">Hi, {clientName}</h1>
              <p className="mx-auto mt-8 max-w-xl text-2xl leading-snug text-[var(--ink-muted)]">
                Your documents from The Reeses are ready to view.
              </p>
              <button
                type="button"
                onClick={() => setStep("proposal")}
                className="brand-primary-button mt-10 inline-flex items-center gap-3 rounded-full px-8 py-4"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </section>
        ) : (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] shadow-sm">
            <div className="grid min-h-[680px] lg:grid-cols-[280px_1fr]">
              <aside className="border-b border-[var(--line)] p-7 lg:border-b-0 lg:border-r">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Private proposal</div>
                <h1 className="mt-4 text-3xl font-semibold leading-tight">{proposalTitle}</h1>
                {packageName && <p className="mt-2 text-sm text-[var(--ink-muted)]">{packageName}</p>}

                <div className="mt-8 grid gap-3 text-sm text-[var(--ink-muted)]">
                  <div className="flex items-center gap-3">
                    <CalendarDays className="h-4 w-4" />
                    <span>{formatDate(projectDate)}</span>
                  </div>
                  {projectLocation && (
                    <div className="flex items-start gap-3">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{projectLocation}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4" />
                    <span>Available through {formatDate(validUntil.slice(0, 10))}</span>
                  </div>
                </div>

                <nav className="mt-10 grid gap-2" aria-label="Proposal sections">
                  {steps.map((item) => {
                    const selected = item.key === step;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setStep(item.key)}
                        className={`rounded-md border px-4 py-3 text-left transition ${
                          selected
                            ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                            : "border-[var(--line)] hover:border-[var(--brand-brown)]"
                        }`}
                      >
                        <span className="block font-semibold">{item.label}</span>
                        <span className={`mt-1 block text-xs ${selected ? "text-[#d8d0c4]" : "text-[var(--ink-muted)]"}`}>{item.helper}</span>
                      </button>
                    );
                  })}
                </nav>
              </aside>

              <div className="bg-[#f7f4ef]">
                {step === "proposal" && (
                  <div className="mx-auto max-w-4xl px-7 py-10">
                    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Proposal</div>
                        <h2 className="mt-3 text-4xl font-semibold leading-tight">{projectName}</h2>
                      </div>
                      <div className="text-left md:text-right">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Package total</div>
                        <div className="mt-1 text-3xl font-semibold">{formatMoney(displayTotalCents)}</div>
                      </div>
                    </div>

                    {scopeSummary && (
                      <div className="mt-8 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Scope</h3>
                        <p className="mt-3 whitespace-pre-line text-sm leading-7 text-[var(--ink-muted)]">{scopeSummary}</p>
                      </div>
                    )}

                    <div className="mt-8 space-y-4">
                      {includedItems.map((item) => (
                        <PackageLineItem key={item.id} item={item} />
                      ))}
                      {!includedItems.length && (
                        <p className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 text-sm text-[var(--ink-muted)]">
                          Package line items will appear here once Tyler finishes the proposal details.
                        </p>
                      )}
                    </div>

                    {optionalItems.length > 0 && (
                      <div className="mt-8">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Optional add-ons</h3>
                        <div className="mt-3 space-y-4">
                          {optionalItems.map((item) => (
                            <PackageLineItem
                              key={item.id}
                              item={item}
                              optional
                              selected={selectedOptionalLineItemIds.includes(item.id)}
                              onToggle={() => toggleOptionalLineItem(item.id)}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <StepFooter nextLabel="Review invoice" onNext={() => setStep("invoice")} />
                  </div>
                )}

                {step === "invoice" && (
                  <div className="mx-auto max-w-4xl px-7 py-10">
                    <div className="text-center">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Invoice</div>
                      <h2 className="mx-auto mt-3 max-w-2xl text-4xl font-semibold leading-tight">Payment schedule and invoice details</h2>
                    </div>

                    <div className="mt-10 space-y-5">
                      {invoices.map((invoice) => (
                        <div key={invoice.id} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                            <div>
                              <div className="font-semibold">{invoice.invoiceNumber}</div>
                              <p className="mt-1 text-sm capitalize text-[var(--ink-muted)]">{statusLabel(invoice.status)}</p>
                            </div>
                            <div className="text-left md:text-right">
                              <div className="font-semibold">{formatMoney(invoice.totalCents)}</div>
                              <p className="text-sm text-[var(--ink-muted)]">Balance {formatMoney(invoice.balanceCents)}</p>
                            </div>
                          </div>
                          <div className="mt-5 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                            {invoice.payments.map((payment) => (
                              <div key={payment.id} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_auto_auto]">
                                <span className="font-semibold">{payment.label}</span>
                                <span className="text-[var(--ink-muted)]">{formatDate(payment.dueDate)}</span>
                                <span>{formatMoney(payment.amountCents)}</span>
                              </div>
                            ))}
                            {!invoice.payments.length && (
                              <div className="p-3 text-sm text-[var(--ink-muted)]">Payment schedule has not been split yet.</div>
                            )}
                          </div>
                          <PaymentOptions invoice={invoice} />
                        </div>
                      ))}
                      {!invoices.length && (
                        <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                            <div>
                              <div className="font-semibold">Invoice preview</div>
                              <p className="mt-1 text-sm text-[var(--ink-muted)]">Built from the selected proposal package and scope.</p>
                            </div>
                            <div className="text-left md:text-right">
                              <div className="font-semibold">{formatMoney(invoicePreview.totalCents)}</div>
                              <p className="text-sm text-[var(--ink-muted)]">Package total</p>
                            </div>
                          </div>

                          <div className="mt-5 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                            {invoicePreview.includedItems.map((item, index) => (
                              <div key={`${item.name}-${index}`} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_auto_auto]">
                                <span className="font-semibold">{item.name}</span>
                                <span className="text-[var(--ink-muted)]">Qty {item.quantity}</span>
                                <span>{formatMoney(item.quantity * item.unitPriceCents)}</span>
                              </div>
                            ))}
                            {invoicePreview.selectedOptionalItems.map((item, index) => (
                              <div key={`${item.name}-selected-${index}`} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_auto_auto]">
                                <span className="font-semibold">{item.name} <span className="font-normal text-[var(--ink-muted)]">(selected add-on)</span></span>
                                <span className="text-[var(--ink-muted)]">Qty {item.quantity}</span>
                                <span>{formatMoney(item.quantity * item.unitPriceCents)}</span>
                              </div>
                            ))}
                            {!invoicePreview.includedItems.length && (
                              <div className="p-3 text-sm text-[var(--ink-muted)]">Package line items will appear here once Tyler finishes the proposal details.</div>
                            )}
                          </div>

                          {selectedPackage.declinedOptionalItems.length > 0 && (
                            <div className="mt-5">
                              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Available optional add-ons</div>
                              <div className="mt-2 divide-y divide-[var(--line)] rounded-md border border-[var(--line)]">
                                {selectedPackage.declinedOptionalItems.map((item, index) => (
                                  <div key={`${item.name}-${index}`} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_auto_auto]">
                                    <span className="font-semibold">{item.name}</span>
                                    <span className="text-[var(--ink-muted)]">Qty {item.quantity}</span>
                                    <span>{formatMoney(item.quantity * item.unitPriceCents)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {invoicePreview.scopeSummary && (
                            <div className="mt-5 rounded-md border border-[var(--line)] bg-[#f7f4ef] p-4">
                              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Scope</div>
                              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{invoicePreview.scopeSummary}</p>
                            </div>
                          )}

                          <p className="mt-4 text-sm leading-6 text-[var(--ink-muted)]">{invoicePreview.scheduleNote}</p>
                        </div>
                      )}
                    </div>

                    <StepFooter nextLabel="Review contract" onNext={() => setStep("contract")} />
                  </div>
                )}

                {step === "contract" && (
                  <div className="mx-auto max-w-4xl px-7 py-10">
                    <div className="text-center">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-muted)]">Contract</div>
                      <h2 className="mx-auto mt-3 max-w-2xl text-4xl font-semibold leading-tight">{contractTitle || "Contract preview"}</h2>
                    </div>

                    <div className="mt-10 rounded-md border border-[var(--line)] bg-[var(--surface)] p-6">
                      {contractBody ? (
                        <div className="max-h-[540px] overflow-auto text-sm leading-7 text-[var(--ink-muted)]">
                          <p className="whitespace-pre-line">{contractBody}</p>
                        </div>
                      ) : (
                        <p className="text-sm leading-6 text-[var(--ink-muted)]">Contract language will appear here once Tyler attaches it to the proposal.</p>
                      )}
                    </div>

                    <div className="mt-8 rounded-md border border-[var(--line)] bg-[#efe8df] p-5">
                      <div className="flex items-start gap-3">
                        <CheckCircle2 className="mt-0.5 h-5 w-5 text-[var(--brand-brown)]" />
                        <div>
                          <h3 className="font-semibold">{isSigned ? "Proposal signed and accepted" : "Signature required"}</h3>
                          <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                            {isSigned
                              ? "Thank you. Tyler can see that this proposal has been signed and accepted."
                              : "Please type your full legal name below to sign the contract and accept this proposal."}
                          </p>
                          {signedAt && (
                            <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--ink-muted)]">
                              Signed {formatDate(signedAt.slice(0, 10))}
                              {signerName ? ` by ${signerName}` : ""}
                              {signerEmail ? ` (${signerEmail})` : ""}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    {!isSigned && (
                      <form action={`/api/proposal/${token}/accept`} method="post" className="mt-8 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
                        {selectedOptionalLineItemIds.map((lineItemId) => (
                          <input key={lineItemId} type="hidden" name="selectedOptionalLineItemId" value={lineItemId} />
                        ))}
                        {signatureError && (
                          <p className="mb-4 rounded-md border border-[var(--brand-brown)] bg-[#f7f4ef] p-3 text-sm text-[var(--brand-brown)]">
                            Please type your full legal name and confirm the signature agreement.
                          </p>
                        )}
                        <div className="grid gap-4">
                          <label className="text-sm font-medium">
                            Full legal name
                            <input
                              name="signatureName"
                              required
                              autoComplete="name"
                              className="mt-2 w-full rounded-md border border-[var(--line)] bg-[var(--background)] px-3 py-2"
                            />
                          </label>
                          <input type="hidden" name="signatureEmail" value={clientEmail ?? ""} />
                          <label className="flex items-start gap-3 text-sm leading-6 text-[var(--ink-muted)]">
                            <input name="signatureConsent" type="checkbox" required className="mt-1" />
                            <span>
                              I agree that typing my name above signs the contract electronically and accepts this proposal package.
                            </span>
                          </label>
                        </div>
                        <div className="mt-6 flex justify-center">
                          <button type="submit" className="brand-primary-button inline-flex items-center gap-3 rounded-full px-8 py-4">
                            Sign and accept proposal
                            <CheckCircle2 className="h-4 w-4" />
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        <footer className="mx-auto mt-8 flex max-w-6xl items-center justify-between gap-4 pb-6 text-sm text-[var(--ink-muted)]">
          <Link href="https://bythereeses.com" aria-label="The Reeses website">
            <Image src="/brand/at-badge-dark.png" alt="A&T" width={64} height={64} className="h-9 w-auto" />
          </Link>
          <a href="mailto:hello@bythereeses.com" className="inline-flex items-center gap-2 transition hover:text-[var(--foreground)]">
            <Mail className="h-4 w-4" />
            hello@bythereeses.com
          </a>
        </footer>
      </div>
    </main>
  );
}

function PaymentOptions({ invoice }: { invoice: ClientProposalExperienceProps["invoices"][number] }) {
  const methods = parseAcceptedPaymentMethods(invoice.acceptedPaymentMethodsJson);
  if (!methods.length && !invoice.paymentNotes) return null;

  return (
    <div className="mt-5 rounded-md border border-[var(--line)] bg-[#f7f4ef] p-4">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">Accepted payment methods</div>
      {methods.length > 0 && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {methods.map((method) => (
            <div key={method.key} className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-3 text-sm">
              <div className="font-semibold">{method.displayName}</div>
              <p className="mt-1 break-words text-[var(--ink-muted)]">
                {method.key === "stripe" ? "Secure card payment will be sent once online checkout is connected." : method.instructions || "Tyler will send details for this payment method."}
              </p>
              {method.passFees && <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--ink-muted)]">Processing fees passed to client</p>}
            </div>
          ))}
        </div>
      )}
      {invoice.paymentNotes && <p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{invoice.paymentNotes}</p>}
    </div>
  );
}

function PackageLineItem({
  item,
  optional = false,
  selected = false,
  onToggle,
}: {
  item: ProposalPreviewLineItem;
  optional?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="grid gap-4 rounded-md border border-[var(--line)] bg-[var(--surface)] p-5 md:grid-cols-[1fr_auto]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-semibold">{item.name}</div>
          {optional && (
            <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
              Optional add-on
            </span>
          )}
        </div>
        {item.description && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{item.description}</p>}
        <p className="mt-3 text-xs uppercase tracking-[0.16em] text-[var(--ink-muted)]">Qty {item.quantity}</p>
      </div>
      <div className="flex flex-col items-start gap-3 md:items-end">
        <div className="text-lg font-semibold">{formatMoney(item.quantity * item.unitPriceCents)}</div>
        {optional && onToggle && (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--line)] px-3 py-2 text-sm transition hover:border-[var(--brand-brown)]">
            <input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4" />
            <span>{selected ? "Selected" : "Add to package"}</span>
          </label>
        )}
      </div>
    </div>
  );
}

function StepFooter({ nextLabel, onNext }: { nextLabel: string; onNext: () => void }) {
  return (
    <div className="mt-10 flex justify-center">
      <button type="button" onClick={onNext} className="brand-primary-button inline-flex items-center gap-3 rounded-full px-8 py-4">
        {nextLabel}
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
