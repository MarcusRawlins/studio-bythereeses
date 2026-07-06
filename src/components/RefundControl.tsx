"use client";

// Phase 9b — admin refund UI (enable-prep; DARK behind REFUND_INITIATION_ENABLED). This
// component moves NO money itself: it only calls the already-reviewed, admin-only
// /api/invoices/[id]/payments/[paymentId]/refund/prepare + /execute routes (which call the
// Fable-approved src/lib/stripe-refund-initiation.ts helpers). The server remains authoritative
// for every rail (retainer hard-block, dispute block, SERVICE-portion ceiling, service-not-
// rendered affirmation, typed-amount confirm) — this control only mirrors them for UX so it
// doesn't offer a doomed action, and surfaces the server's typed refusal reason inline (never a
// raw JSON dump) rather than the SMS-style redirect-with-reason, since this is a JS-driven
// fetch flow, not a plain <form> POST.
//
// The invoice page only renders this component at all when refundInitiationEnabled() is true
// (checked server-side) AND the payment is a settled Stripe (`paid`) collection — when the
// flag is off, nothing about this control exists in the page at all.

import { formatMoney } from "@/lib/format";
import { useState } from "react";

export type RefundInitiationRow = {
  id: string;
  status: string;
  amountCents: number;
  stripeRefundId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type RefundControlProps = {
  invoiceId: string;
  paymentId: string;
  paymentLabel: string;
  /** Non-null when the SERVER-side eligibility (reused, not re-invented) already disqualifies
   * this payment (retainer / disputed) — the control renders a note instead of a form. */
  disabledReason: string | null;
  existingInitiations: RefundInitiationRow[];
};

type Phase = "idle" | "opening" | "open" | "submitting" | "done";

function parseDollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

function centsToDollarsInput(cents: number) {
  return Math.max(cents, 0) / 100 === 0 ? "0.00" : (Math.max(cents, 0) / 100).toFixed(2);
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

const STRIPE_REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "requested_by_customer", label: "Requested by customer" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraudulent", label: "Fraudulent" },
];

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  submitting: "Submitting",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function RefundControl({ invoiceId, paymentId, paymentLabel, disabledReason, existingInitiations }: RefundControlProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [initiationId, setInitiationId] = useState<string | null>(null);
  const [maxRefundableCents, setMaxRefundableCents] = useState(0);
  const [amountInput, setAmountInput] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [serviceNotRendered, setServiceNotRendered] = useState(false);
  const [reason, setReason] = useState("");
  const [stripeReason, setStripeReason] = useState("requested_by_customer");
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);

  async function openRefundDialog() {
    setPhase("opening");
    setMessage(null);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/payments/${paymentId}/refund/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json().catch(() => null)) as { initiationId?: string; maxRefundableCents?: number; error?: string } | null;
      if (!response.ok || !payload?.initiationId) {
        setMessage({ tone: "error", text: payload?.error ?? "Refund could not be prepared." });
        setPhase("idle");
        return;
      }
      const prefillCents = payload.maxRefundableCents ?? 0;
      setInitiationId(payload.initiationId);
      setMaxRefundableCents(prefillCents);
      setAmountInput(centsToDollarsInput(prefillCents));
      setConfirmInput("");
      setServiceNotRendered(false);
      setReason("");
      setStripeReason("requested_by_customer");
      setPhase("open");
    } catch {
      setMessage({ tone: "error", text: "Refund could not be prepared. Check your connection and try again." });
      setPhase("idle");
    }
  }

  function closeDialog() {
    setPhase("idle");
    setInitiationId(null);
    setMessage(null);
  }

  async function submitRefund() {
    if (!initiationId) return;
    const amountCents = parseDollarsToCents(amountInput);
    const confirmCents = parseDollarsToCents(confirmInput);

    if (amountCents === null || amountCents > maxRefundableCents) {
      setMessage({ tone: "error", text: `Enter an amount greater than $0.00 and no more than ${formatMoney(maxRefundableCents)}.` });
      return;
    }
    if (confirmCents === null || confirmCents !== amountCents) {
      setMessage({ tone: "error", text: "The retyped confirmation amount must exactly match the refund amount." });
      return;
    }
    if (!serviceNotRendered) {
      setMessage({ tone: "error", text: "You must confirm the service was not rendered before a refund can be submitted." });
      return;
    }
    if (!reason.trim()) {
      setMessage({ tone: "error", text: "A refund reason is required." });
      return;
    }

    setPhase("submitting");
    setMessage(null);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/payments/${paymentId}/refund/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initiationId,
          amountCents,
          confirmAmountCents: confirmCents,
          reason: reason.trim(),
          service_not_rendered_confirmed: true,
          stripeReason,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        amountCents?: number;
        stripeRefundId?: string | null;
        needsReconciliation?: boolean;
        alreadyProcessed?: boolean;
        error?: string;
      } | null;

      if (!response.ok) {
        // Typed refusal reason from the server, never a raw JSON dump (mirrors the SMS
        // send-UI's redirect-with-reason pattern, adapted for a JS fetch flow).
        setMessage({ tone: "error", text: payload?.error ?? "Refund could not be submitted." });
        setPhase("open");
        return;
      }

      if (payload?.needsReconciliation) {
        setMessage({
          tone: "info",
          text: "This refund initiation is already in progress and needs manual reconciliation against Stripe. It was NOT resubmitted.",
        });
      } else if (payload?.status === "succeeded") {
        const amountLabel = formatMoney(payload.amountCents ?? amountCents);
        setMessage({
          tone: "success",
          text: payload.alreadyProcessed
            ? `This refund was already submitted: ${amountLabel}${payload.stripeRefundId ? ` (${payload.stripeRefundId})` : ""}.`
            : `Refund submitted: ${amountLabel}${payload.stripeRefundId ? ` (${payload.stripeRefundId})` : ""}. It will show as recorded once Stripe's webhook lands.`,
        });
      } else {
        setMessage({ tone: "info", text: "Refund request submitted." });
      }
      setPhase("done");
      window.setTimeout(() => window.location.reload(), 1500);
    } catch {
      setMessage({ tone: "error", text: "Refund could not be submitted. Check your connection and try again." });
      setPhase("open");
    }
  }

  const showForm = !disabledReason && (phase === "open" || phase === "submitting");
  const isSubmitting = phase === "submitting";

  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--background)] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">Refund</div>
        {!disabledReason && phase === "idle" && (
          <button
            type="button"
            onClick={openRefundDialog}
            className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-xs font-semibold transition hover:border-[var(--foreground)]"
          >
            Start refund
          </button>
        )}
        {!disabledReason && phase === "opening" && (
          <span className="text-xs text-[var(--ink-muted)]">Checking refundable balance...</span>
        )}
      </div>

      {disabledReason && <p className="mt-2 text-xs font-semibold text-[var(--ink-muted)]">{disabledReason}</p>}

      {showForm && (
        <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
          <p className="text-xs text-[var(--ink-muted)]">
            Refundable service balance: {formatMoney(maxRefundableCents)}. Client-paid processing fees are never refunded.
          </p>
          <label className="block space-y-1 text-xs font-semibold">
            Refund amount (USD)
            <input
              type="number"
              min="0.01"
              step="0.01"
              max={centsToDollarsInput(maxRefundableCents)}
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="block space-y-1 text-xs font-semibold">
            Retype the refund amount to confirm
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={confirmInput}
              onChange={(event) => setConfirmInput(event.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="block space-y-1 text-xs font-semibold">
            Stripe reason
            <select
              value={stripeReason}
              onChange={(event) => setStripeReason(event.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
            >
              {STRIPE_REASON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs font-semibold">
            Reason (internal audit record — required)
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={isSubmitting}
              rows={2}
              placeholder="Why is this refund being issued?"
              className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="flex items-start gap-2 text-xs font-semibold">
            <input
              type="checkbox"
              checked={serviceNotRendered}
              onChange={(event) => setServiceNotRendered(event.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5 h-4 w-4"
            />
            I confirm service was NOT rendered for &ldquo;{paymentLabel}&rdquo;. This affirmation is required for every refund.
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submitRefund}
              disabled={isSubmitting}
              className="brand-primary-button rounded-sm px-4 py-2 text-xs transition"
            >
              {isSubmitting ? "Submitting..." : "Submit refund"}
            </button>
            <button
              type="button"
              onClick={closeDialog}
              disabled={isSubmitting}
              className="rounded-sm border border-[var(--line)] px-4 py-2 text-xs font-semibold transition hover:border-[var(--foreground)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <p
          className={
            message.tone === "error"
              ? "mt-2 text-xs font-semibold text-[var(--danger)]"
              : message.tone === "success"
                ? "mt-2 text-xs font-semibold text-[var(--accent-strong)]"
                : "mt-2 text-xs font-semibold text-[var(--ink-muted)]"
          }
        >
          {message.text}
        </p>
      )}

      {existingInitiations.length > 0 && (
        <div className="mt-3 border-t border-[var(--line)] pt-3">
          <div className="text-xs font-semibold text-[var(--ink-muted)]">Refund history for this payment</div>
          <ul className="mt-1 space-y-1">
            {existingInitiations.map((row) => (
              <li key={row.id} className="text-xs text-[var(--ink-muted)]">
                {STATUS_LABELS[row.status] ?? row.status} · {formatMoney(row.amountCents)} · {formatTimestamp(row.updatedAt)}
                {row.stripeRefundId ? ` · ${row.stripeRefundId}` : ""}
                {row.errorMessage ? ` · ${row.errorMessage}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
