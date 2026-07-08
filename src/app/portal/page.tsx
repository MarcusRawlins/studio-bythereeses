import { getActiveAutopayConsent, revokeAutopayConsent, setupAutopayConsent } from "@/lib/autopay-charge";
import { clearPortalSession, getPortalProjectContext, requirePortalProject } from "@/lib/portal";
import { formatDate, formatMoney } from "@/lib/format";
import { CalendarDays, ClipboardList, ExternalLink, FileSignature, Images, Landmark, LockKeyhole, MapPin } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  await clearPortalSession();
  redirect("/portal");
}

// Phase 13 (§4.1/§4.3) — autopay consent controls. Server actions resolve the project ONLY from the
// portal session (no IDOR). Rendered ONLY when AUTOPAY_ENABLED is on (I1) — dark by default.
async function autopaySetupAction() {
  "use server";
  const ctx = await requirePortalProject();
  if (!ctx) redirect("/portal");
  const { url } = await setupAutopayConsent(ctx.project.id);
  redirect(url); // Stripe-hosted card entry (mode=setup) — card data never touches the CRM (I4).
}

async function autopayRevokeAction() {
  "use server";
  const ctx = await requirePortalProject();
  if (!ctx) redirect("/portal");
  await revokeAutopayConsent(ctx.project.id);
  redirect("/portal?autopay=off");
}

async function AutopaySection({ projectId, invoices }: { projectId: string; invoices: PortalProjectContext["invoices"] }) {
  const consent = await getActiveAutopayConsent(projectId);
  const hasFutureInstallment = invoices.some((invoice) =>
    invoice.payments.some((payment) => payment.status !== "paid" && payment.status !== "waived" && (payment.openCents ?? 0) > 0),
  );
  if (!consent && !hasFutureInstallment) return null;

  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
      <h2 className="text-lg font-semibold">Autopay</h2>
      {consent ? (
        <div className="mt-2 space-y-3">
          <p className="text-sm leading-6 text-[var(--ink-muted)]">
            Autopay is <strong>on</strong>. Your {consent.cardBrand ?? "card"} •••• {consent.cardLast4 ?? "••••"} will be charged for each
            scheduled payment on its due date. You can turn it off anytime.
          </p>
          {!consent.isCurrentVersion && (
            <p className="rounded-md border border-[var(--line)] bg-[#fff7ed] p-3 text-sm text-[var(--ink-muted)]">
              Our autopay terms were updated. Please turn autopay off and back on to confirm the new terms.
            </p>
          )}
          <form action={autopayRevokeAction}>
            <button className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
              Turn off autopay
            </button>
          </form>
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          <p className="text-sm leading-6 text-[var(--ink-muted)]">
            Turn on autopay to have each scheduled payment charged automatically to a saved card on its due date. Your card is entered
            securely on our payment processor and is never stored by the studio. You can turn autopay off anytime.
          </p>
          <form action={autopaySetupAction}>
            <button className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white">
              Turn on autopay
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const data = await requirePortalProject();

  if (!data) {
    return (
      <main className="min-h-screen bg-[var(--background)] px-5 py-10 text-[var(--foreground)]">
        <div className="mx-auto max-w-xl rounded-md border border-[var(--line)] bg-[var(--surface)] p-8 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-[#edf6f1] text-[var(--accent)]">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <h1 className="brand-page-title mt-5 text-3xl">Client portal</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            Open a secure portal link from Tyler to view your project. Portal links are project-specific and can be revoked at any time.
          </p>
          {process.env.PORTAL_MAGIC_LINK_ENABLED === "1" && (
            <p className="mt-4 text-sm leading-6 text-[var(--ink-muted)]">
              Have a project with us?{" "}
              <a href="/portal/login" className="font-semibold text-[var(--accent)] underline">
                Email yourself a sign-in link
              </a>
              .
            </p>
          )}
          {error && <p className="mt-4 rounded-md border border-[var(--danger)] bg-[#fff4f1] p-3 text-sm text-[var(--danger)]">That portal link is invalid or expired.</p>}
        </div>
      </main>
    );
  }

  return <PortalProjectView data={data} />;
}

type PortalProjectContext = NonNullable<Awaited<ReturnType<typeof getPortalProjectContext>>>;

function locationLine(parts: Array<string | null>) {
  return parts.filter(Boolean).join(", ");
}

export function PortalProjectView({ data }: { data: PortalProjectContext }) {
  const primaryClient = data.clients[0];

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--line)] pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-medium text-[var(--ink-muted)]">Reese Photography</p>
            <h1 className="brand-page-title mt-1 text-4xl">{data.project.name}</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              Welcome, {primaryClient?.preferredName ?? primaryClient?.firstName}. This portal is scoped only to this project.
            </p>
          </div>
          <form action={logoutAction}>
            <button className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
              Log out
            </button>
          </form>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Event date</div>
            <div className="mt-2 text-xl font-semibold">{formatDate(data.project.eventDate)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Venue</div>
            <div className="mt-2 text-xl font-semibold">{data.project.venueName ?? "TBD"}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Open balance</div>
            <div className="mt-2 text-xl font-semibold">{formatMoney(data.moneySummary.invoiceOpenCents)}</div>
          </div>
        </section>

        {process.env.AUTOPAY_ENABLED === "1" && <AutopaySection projectId={data.project.id} invoices={data.invoices} />}

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Invoice total</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.moneySummary.invoiceTotalCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Paid invoices</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.moneySummary.invoicePaidCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Booking payments</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(data.moneySummary.schedulerPaidCents)}</div>
          </div>
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)] p-5">
            <div className="text-sm text-[var(--ink-muted)]">Project stage</div>
            <div className="mt-2 text-2xl font-semibold capitalize">{data.project.stage.replaceAll("_", " ")}</div>
          </div>
        </section>

        {data.galleries.length > 0 && (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <Images className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Your gallery</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.galleries.map((gallery) => (
                <div key={gallery.id} className="flex flex-wrap items-start justify-between gap-4 p-5">
                  <div>
                    <div className="font-semibold">{gallery.title}</div>
                    {gallery.provider && <div className="mt-1 text-sm text-[var(--ink-muted)]">{gallery.provider}</div>}
                    {gallery.expiresAt && (
                      <div className="mt-2 text-sm text-[var(--ink-muted)]">Available until {formatDate(gallery.expiresAt)}</div>
                    )}
                    {gallery.passcode && (
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">Passcode: <span className="font-medium text-[var(--foreground)]">{gallery.passcode}</span></div>
                    )}
                  </div>
                  <a
                    href={gallery.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="brand-primary-button inline-flex items-center gap-2 rounded-sm px-4 py-2.5 text-sm"
                  >
                    <ExternalLink className="h-4 w-4" />
                    View gallery
                  </a>
                </div>
              ))}
            </div>
          </section>
        )}

        {(data.events.length > 0 || data.locations.length > 0) && (
          <section className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <MapPin className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Project logistics</h2>
            </div>
            <div className="grid gap-0 divide-y divide-[var(--line)] lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <div>
                <div className="border-b border-[var(--line)] px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Events</div>
                <div className="divide-y divide-[var(--line)]">
                  {data.events.map((event) => (
                    <div key={event.id} className="p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{event.title}</div>
                          <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatDate(event.eventDate)} · {event.type.replaceAll("_", " ")}</div>
                        </div>
                        {event.venueName && <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold">{event.venueName}</span>}
                      </div>
                      <div className="mt-2 text-sm text-[var(--ink-muted)]">{locationLine([event.venueAddress, event.city, event.state]) || "Location TBD"}</div>
                      {event.notes && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{event.notes}</p>}
                    </div>
                  ))}
                  {!data.events.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No additional events have been shared yet.</p>}
                </div>
              </div>
              <div>
                <div className="border-b border-[var(--line)] px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-muted)]">Locations</div>
                <div className="divide-y divide-[var(--line)]">
                  {data.locations.map((location) => (
                    <div key={location.id} className="p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{location.name}</div>
                          <div className="mt-1 text-sm capitalize text-[var(--ink-muted)]">{location.type.replaceAll("_", " ")}</div>
                        </div>
                      </div>
                      <div className="mt-2 text-sm text-[var(--ink-muted)]">{locationLine([location.address, location.city, location.state]) || "Address TBD"}</div>
                      {location.notes && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{location.notes}</p>}
                    </div>
                  ))}
                  {!data.locations.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No additional locations have been shared yet.</p>}
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <FileSignature className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Proposals and contracts</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.proposals.map((proposal) => (
                <div key={proposal.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{proposal.title}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">{proposal.packageName ?? "Package TBD"}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold capitalize">{proposal.status.replaceAll("_", " ")}</span>
                      <a href={proposal.proposalUrl} className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                        <ExternalLink className="h-4 w-4" />
                        {proposal.signedAt ? "Open" : "Review and sign"}
                      </a>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-[var(--ink-muted)] sm:grid-cols-2">
                    <div>Contract: <span className="font-medium text-[var(--foreground)] capitalize">{proposal.contractStatus.replaceAll("_", " ")}</span></div>
                    <div>Signed: <span className="font-medium text-[var(--foreground)]">{formatDate(proposal.signedAt)}</span></div>
                    <div>Total: <span className="font-medium text-[var(--foreground)]">{formatMoney(proposal.totalCents)}</span></div>
                    <div>Invoice: <span className="font-medium text-[var(--foreground)] capitalize">{proposal.invoiceStatus.replaceAll("_", " ")}</span></div>
                  </div>
                  {proposal.scopeSummary && <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">{proposal.scopeSummary}</p>}
                </div>
              ))}
              {!data.proposals.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No proposals have been shared yet.</p>}
            </div>
          </div>

          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <Landmark className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Invoices and payments</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.invoices.map((invoice) => (
                <div key={invoice.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{invoice.invoiceNumber}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">Client-payable balance {formatMoney(invoice.clientPayableBalanceCents)}</div>
                    </div>
                    <span className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold capitalize">{invoice.status.replaceAll("_", " ")}</span>
                  </div>
                  {invoice.remainingClientFeeCents > 0 && (
                    <div className="mt-3 grid gap-2 rounded-md border border-[var(--line)] bg-[var(--background)] p-3 text-sm sm:grid-cols-3">
                      <div>
                        <div className="text-xs text-[var(--ink-muted)]">Service balance</div>
                        <div className="mt-1 font-semibold">{formatMoney(invoice.serviceBalanceCents)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-[var(--ink-muted)]">Card fee remaining</div>
                        <div className="mt-1 font-semibold">{formatMoney(invoice.remainingClientFeeCents)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-[var(--ink-muted)]">Total due by card</div>
                        <div className="mt-1 font-semibold">{formatMoney(invoice.clientPayableBalanceCents)}</div>
                      </div>
                    </div>
                  )}
                  <div className="mt-4 grid gap-3">
                    {invoice.payments.map((payment) => (
                      <div key={payment.id} className="rounded-md border border-[var(--line)] bg-[#fbf7f0] p-3 text-sm">
                        <div className="flex justify-between gap-3">
                          <span className="font-medium">{payment.label}</span>
                          <span>{formatMoney(payment.paidAmountCents || payment.clientPayableOpenCents || payment.amountCents)}</span>
                        </div>
                        <div className="mt-1 text-xs text-[var(--ink-muted)]">
                          {payment.status.replaceAll("_", " ")} · due {formatDate(payment.dueDate)} · open {formatMoney(payment.clientPayableOpenCents)}
                        </div>
                        {payment.stripeCheckoutUrl && payment.clientPayableOpenCents > 0 && payment.stripeCheckoutStatus === "link_ready" && (
                          <a href={payment.stripeCheckoutUrl} target="_blank" className="mt-3 inline-flex rounded-sm border border-[var(--foreground)] px-3 py-2 text-xs font-semibold">
                            Pay this installment
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                  {invoice.stripePaymentLink && invoice.clientPayableBalanceCents > 0 && (
                    <a href={invoice.stripePaymentLink} target="_blank" className="mt-4 inline-flex rounded-sm border border-[var(--foreground)] px-4 py-2 text-sm font-semibold">
                      Open secure checkout
                    </a>
                  )}
                  {(invoice.paymentOptions.length > 0 || invoice.paymentNotes) && (
                    <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--background)] p-3">
                      <div className="text-sm font-semibold">Payment options</div>
                      {invoice.paymentOptions.length > 0 && (
                        <dl className="mt-3 grid gap-3 text-sm">
                          {invoice.paymentOptions.map((method) => (
                            <div key={method.key}>
                              <dt className="font-medium">{method.displayName}</dt>
                              {method.instructions && <dd className="mt-1 break-all text-[var(--ink-muted)]">{method.instructions}</dd>}
                              {method.passFees && <dd className="mt-1 text-xs text-[var(--ink-muted)]">Processing fees passed to client.</dd>}
                            </div>
                          ))}
                        </dl>
                      )}
                      {invoice.paymentNotes && <p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--ink-muted)]">{invoice.paymentNotes}</p>}
                    </div>
                  )}
                </div>
              ))}
              {!data.invoices.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No invoices have been created yet.</p>}
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <CalendarDays className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Calls and timeline</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.schedulerBookings.map((booking) => (
                <div key={booking.id} className="p-5">
                  <div className="font-semibold">{booking.meetingTypeName}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatDate(booking.startAt)} · {booking.status.replaceAll("_", " ")}</div>
                  <div className="mt-2 text-sm">Payment: <span className="font-medium capitalize">{booking.paymentStatus.replaceAll("_", " ")}</span> · {formatMoney(booking.paidAmountCents)}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a href={booking.rescheduleUrl} className="inline-flex rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                      Reschedule
                    </a>
                    <a href={booking.manageUrl} className="inline-flex rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                      Manage
                    </a>
                    {booking.paymentLink && booking.paymentStatus !== "paid" && (
                      <a href={booking.paymentLink} target="_blank" className="inline-flex rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                        Open booking checkout
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {data.timelineItems.map((item) => (
                <div key={item.id} className="p-5">
                  <div className="font-semibold">{item.title}</div>
                  <div className="mt-1 text-sm text-[var(--ink-muted)]">{formatDate(item.startAt)}{item.endAt ? ` - ${formatDate(item.endAt)}` : ""}</div>
                  {item.description && <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">{item.description}</p>}
                </div>
              ))}
              {!data.schedulerBookings.length && !data.timelineItems.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No scheduled calls or timeline items yet.</p>}
            </div>
          </div>

          <div className="rounded-md border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-4">
              <ClipboardList className="h-4 w-4 text-[var(--ink-muted)]" />
              <h2 className="font-semibold">Questionnaires</h2>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {data.questionnaireResponses.map((response) => (
                <div key={response.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{response.questionnaireTitle}</div>
                      <div className="mt-1 text-sm text-[var(--ink-muted)]">
                        {response.status === "submitted" ? `Submitted ${formatDate(response.submittedAt)}` : `Draft updated ${formatDate(response.updatedAt)}`}
                      </div>
                    </div>
                    <a href={response.questionnaireUrl} target="_blank" className="inline-flex items-center gap-2 rounded-sm border border-[var(--line)] px-3 py-2 text-sm font-semibold transition hover:border-[var(--foreground)]">
                      <ExternalLink className="h-4 w-4" />
                      {response.status === "draft" ? "Continue" : "Open"}
                    </a>
                  </div>
                </div>
              ))}
              {!data.questionnaireResponses.length && <p className="p-5 text-sm text-[var(--ink-muted)]">No questionnaire responses have been saved yet.</p>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
