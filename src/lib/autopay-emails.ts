// Phase 13 — client-facing autopay emails (§8). Two emails, both reusing the sequence transport
// (Resend, suppression-checked): an upcoming-charge notice and a per-charge receipt.
//
// ⚠️ THE GATE IS ENFORCED INSIDE THIS HELPER (M4). The canonical sequence transport sendSequenceEmail
// does NOT consult EMAIL_SENDING_ENABLED — only the Phase 14 admin path does. So every autopay email
// helper MUST itself call emailSendingEnabled() (fail-closed) AND check AUTOPAY_ENABLED, the log_only
// suppression, and isEmailSuppressed BEFORE handing anything to sendSequenceEmail. Test 29 asserts the
// gate at THIS layer, not the transport. In log_only mode NOTHING is charged, so "we charged your card"
// (a lie) would be wrong — client emails only fire in `live` mode.

import { db } from "@/db/client";
import { sequenceSends } from "@/db/schema";
import { autopayChargeMode, autopayEnabled } from "@/lib/autopay-flags";
import { isEmailSuppressed, sendSequenceEmail } from "@/lib/email";
import { formatMoney } from "@/lib/format";
import { emailSendingEnabled } from "@/lib/project-communications";
import { eq } from "drizzle-orm";

export type AutopayEmailResult = { ok: boolean; reason: string };

// The single fail-closed gate (M4). Returns true ONLY when the master flag is on, the charge mode is
// `live` (log_only suppresses ALL client emails, §8), and the outbound master gate is on. Every autopay
// email helper calls this FIRST and short-circuits before any sendSequenceEmail call.
function autopayEmailGateOpen(): boolean {
  if (!autopayEnabled()) return false;
  if (autopayChargeMode() !== "live") return false; // log_only ⇒ zero client emails
  if (!emailSendingEnabled()) return false; // outbound master gate — never bypassed
  return true;
}

const SIGNOFF = "Warmly,\nThe Reeses Studio";

function cardLabel(brand: string | null, last4: string | null): string {
  const b = brand?.trim() ? brand.trim() : "card";
  const l = last4?.trim() ? last4.trim() : "••••";
  return `${b} •••• ${l}`;
}

// 1. Upcoming-charge notice (§8.1). Idempotent — one notice per installment via a dedupeKey in the
// sequence-send ledger (autopay_notice:<paymentId>), so a re-tick never double-sends. Only ever
// invoked from the LIVE tick, and this helper re-checks the full gate (defense-in-depth).
export async function sendAutopayUpcomingNotice(input: {
  projectId: string;
  clientId: string | null;
  invoicePaymentId: string;
  toEmail: string | null;
  projectName: string;
  amountCents: number;
  dueDate: string;
  cardBrand: string | null;
  cardLast4: string | null;
  balanceRemainingCents?: number;
}): Promise<AutopayEmailResult> {
  if (!autopayEmailGateOpen()) return { ok: false, reason: "gated" };
  const email = input.toEmail?.trim().toLowerCase();
  if (!email) return { ok: false, reason: "no_recipient" };
  if (await isEmailSuppressed(email)) return { ok: false, reason: "suppressed" };

  // Claim the dedupe key BEFORE sending so a re-tick / retry never double-sends (sequence-send ledger).
  const dedupeKey = `autopay_notice:${input.invoicePaymentId}`;
  const claimed = await db
    .insert(sequenceSends)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      clientId: input.clientId,
      enrollmentId: null,
      sequenceKey: "autopay_notice",
      stepKey: "upcoming_charge",
      dedupeKey,
      channel: "email",
      mode: "auto_send",
      status: "claimed",
      attempts: 1,
      firedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: sequenceSends.id });
  if (!claimed.length) return { ok: false, reason: "already_sent" };

  const subject = `Upcoming payment for ${input.projectName}`;
  const text = [
    "Hello,",
    "",
    `Your scheduled payment of ${formatMoney(input.amountCents)} for ${input.projectName} will be charged to your ${cardLabel(input.cardBrand, input.cardLast4)} on ${input.dueDate}.`,
    "",
    "Questions? Just reply to this email. To cancel autopay, visit your client portal at any time.",
    "",
    SIGNOFF,
  ].join("\n");

  const result = await sendSequenceEmail({ to: email, subject, text, purpose: "autopay" });
  await db
    .update(sequenceSends)
    .set({ status: result.ok ? "done" : "failed", note: result.ok ? null : result.reason })
    .where(eq(sequenceSends.dedupeKey, dedupeKey));
  return { ok: result.ok, reason: result.ok ? "sent" : result.reason };
}

// 2. Charge receipt (§8.2). Fired exactly once per real charge (on the autopay_charges 'charged'
// transition — the caller only invokes this the first time the installment is recorded paid).
export async function sendAutopayReceipt(input: {
  toEmail: string | null;
  projectName: string;
  installmentLabel: string;
  amountCents: number;
  chargedOnDate: string;
  cardBrand: string | null;
  cardLast4: string | null;
  balanceRemainingCents: number;
  portalUrl?: string | null;
}): Promise<AutopayEmailResult> {
  if (!autopayEmailGateOpen()) return { ok: false, reason: "gated" };
  const email = input.toEmail?.trim().toLowerCase();
  if (!email) return { ok: false, reason: "no_recipient" };
  if (await isEmailSuppressed(email)) return { ok: false, reason: "suppressed" };

  const subject = `Payment receipt for ${input.projectName}`;
  const lines = [
    "Hello,",
    "",
    `We charged ${formatMoney(input.amountCents)} to your ${cardLabel(input.cardBrand, input.cardLast4)} for "${input.installmentLabel}" on ${input.projectName} (${input.chargedOnDate}).`,
    `Balance remaining: ${formatMoney(Math.max(input.balanceRemainingCents, 0))}.`,
  ];
  if (input.portalUrl) {
    lines.push("", `View your invoice and payment history in your portal: ${input.portalUrl}`);
  }
  lines.push("", SIGNOFF);

  const result = await sendSequenceEmail({ to: email, subject, text: lines.join("\n"), purpose: "autopay" });
  return { ok: result.ok, reason: result.ok ? "sent" : result.reason };
}
