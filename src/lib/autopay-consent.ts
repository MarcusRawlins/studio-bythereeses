// Phase 13 — Autopay consent copy (§4.2). Single source-of-truth constant, rendered verbatim
// on the portal before the client proceeds. The agreed `consent_version` AND a hash of the exact
// rendered copy are persisted on the consent row (§3.1). The engine only auto-charges under a
// consent whose `consent_version` equals the CURRENT AUTOPAY_CONSENT_VERSION (I9) — a stale-version
// consent is treated as revoked-for-charging and the client is re-prompted. Bumping the version is
// money-halting: it silently disqualifies every existing active consent until each client re-consents
// (§7 MINOR-7 — pair every bump with the health signal + a re-consent prompt).

import { createHash } from "node:crypto";

export const AUTOPAY_CONSENT_VERSION = "2026-07-v1";

export const AUTOPAY_CONSENT_TEXT = [
  "Autopay authorization",
  "",
  "By turning on autopay you authorize The Reeses Studio to securely save your card on file with our",
  "payment processor (Stripe) and to automatically charge that card for each scheduled payment on your",
  "invoice when it comes due. Each charge is for the scheduled installment amount shown on your invoice,",
  "including any passed-through card processing fee, and no more. Your full card number and security code",
  "are entered only on Stripe's secure page and are never stored by the studio.",
  "",
  "We will email you a receipt after every charge, and (when enabled) a reminder a few days before each",
  "upcoming charge. You can turn off autopay at any time from your client portal; doing so stops all",
  "future automatic charges immediately. Turning off autopay does not refund a charge already in progress.",
].join("\n");

// SHA-256 of the exact rendered consent copy at grant time (audit; proves WHAT the client agreed to
// even if the copy later changes). Mirrors the proposal signature_consent hashing discipline.
export function autopayConsentTextHash(text: string = AUTOPAY_CONSENT_TEXT): string {
  return createHash("sha256").update(text).digest("hex");
}
