import {
  ingestWebFormInquiry,
  isLeadFormEnabled,
  MAX_BODY_TEXT_LENGTH,
  MAX_PARSED_NAME_LENGTH,
  normalizeEmail,
  sanitizeBody,
  sanitizeLine,
} from "@/lib/inbound-inquiry";
import { getLeadFormConfig, OPTIONAL_LEAD_FORM_FIELDS } from "@/lib/lead-form";
import { parseLeadFormEmbedToken, verifyFormNonce } from "@/lib/lead-form-links";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// BLOCKER-2: EVERY user-visible POST outcome is a 303 to a carve-out-matched embed path, so the
// framed POST response never renders as a BLANK FRAME (a non-redirect body would, under the
// relaxed frame-ancestors). The ONLY non-redirect outcome is the raw 403 for a bad/missing token
// (no page was ever legitimately rendered there). The redirect URL carries ONLY `?t=<token>` +
// `&error=<code>` — NEVER submitted PII (name/email/message), which would land in proxy access logs.
function redirectToThanks(request: NextRequest, token: string) {
  const url = new URL("/embed/lead/thanks", request.url);
  url.searchParams.set("t", token);
  return NextResponse.redirect(url, 303);
}

function redirectToForm(request: NextRequest, token: string, error: string) {
  const url = new URL("/embed/lead", request.url);
  url.searchParams.set("t", token);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  // I1: flag OFF ⇒ 404 (no surface). Checked first so a dark deploy is a pure no-op.
  if (!isLeadFormEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // Defense-in-depth (proxy-only posture, Phase 24 trap): a direct *.workers.dev POST lacking the
  // origin secret is 404'd in-route too — the route is deliberately NOT in the origin-guard bypass.
  const blocked = guardDirectWorkerApiRequest(request);
  if (blocked) return blocked;

  const formData = await request.formData();
  const token = String(formData.get("t") ?? "");

  // Embed token gate, split for "reject BEFORE any DB read" (spec §4.1 / diff-review MINOR-1):
  // (1) signature + version + formId are a PURE HMAC check — no DB. A drive-by garbage-token POST
  // 403s here without ever touching the settings row. (2) Only a signature-valid token proceeds to
  // the config read + the `rev` revocation compare (MEDIUM-7). Both are the ONLY non-redirect
  // outcome; a rev-mismatch (revoked embed URL) is indistinguishable from a bad signature (403).
  const parsedToken = parseLeadFormEmbedToken(token);
  const forbidden = () =>
    new NextResponse("Forbidden", { status: 403, headers: { "cache-control": "private, no-store" } });
  if (!parsedToken) return forbidden();

  const config = await getLeadFormConfig();
  if (parsedToken.rev !== config.rev) return forbidden();

  // Honeypot: a hidden field humans never see. Filled ⇒ 303 to thanks (indistinguishable from
  // success — never tip the bot), NO row (I9). Checked first so a honeypot bot always sees success.
  if (String(formData.get("company_website") ?? "").trim() !== "") {
    return redirectToThanks(request, token);
  }

  // Per-render timing nonce.
  const verdict = verifyFormNonce(String(formData.get("formNonce") ?? ""));
  if (verdict.status === "too_fast") {
    // A genuine bot signal (submitted faster than a human could fill). 303 thanks, NO row (I9).
    return redirectToThanks(request, token);
  }
  if (verdict.status === "stale") {
    // A slow human whose nonce aged out (MAJOR-4) — NEVER a silent drop. 303 back to a re-rendered
    // form (fresh nonce minted on the GET).
    return redirectToForm(request, token, "expired");
  }
  if (verdict.status === "invalid") {
    // Missing/tampered nonce — re-render the form rather than silently discard a submission.
    return redirectToForm(request, token, "session");
  }

  // ---- caps + required-field validation (a validation error is a 303 re-render, NOT a drop) ----
  const name = sanitizeLine(String(formData.get("name") ?? ""), MAX_PARSED_NAME_LENGTH);
  if (!name) return redirectToForm(request, token, "name");

  // normalizeEmail REJECTS (returns null) a missing/over-cap/multi-address value — it does NOT
  // truncate — so an invalid required email is a 303 re-render, never a null-email review row.
  const email = normalizeEmail(String(formData.get("email") ?? ""));
  if (!email) return redirectToForm(request, token, "email");

  const message = sanitizeBody(String(formData.get("message") ?? ""), MAX_BODY_TEXT_LENGTH);
  if (!message) return redirectToForm(request, token, "message");

  // Optional fields: read ONLY the ones the config has enabled (a disabled field is ignored on
  // POST, §9 test 12). An enabled+required field left empty → 303 re-render.
  const optionalValues: Record<(typeof OPTIONAL_LEAD_FORM_FIELDS)[number], string | null> = {
    phone: null,
    eventDate: null,
    eventType: null,
    referralSource: null,
  };
  for (const field of OPTIONAL_LEAD_FORM_FIELDS) {
    const fieldConfig = config.fields[field];
    if (!fieldConfig.enabled) continue; // ignored on POST
    const raw = String(formData.get(field) ?? "").trim();
    if (fieldConfig.required && raw === "") {
      return redirectToForm(request, token, "missing");
    }
    optionalValues[field] = raw === "" ? null : raw;
  }

  // Only ever creates a staging inbound_inquiries row + an authority-less agent_tasks review row
  // (I2). No canonical mutation. A rate-limited/over-cap submission still 303s to thanks (the CRM
  // flood guard marked it spam internally — indistinguishable to the submitter, and still no
  // canonical write). The nonceId → synthetic message_id makes a double-submit idempotent (B2).
  await ingestWebFormInquiry({
    name,
    email,
    phone: optionalValues.phone,
    eventDate: optionalValues.eventDate,
    eventType: optionalValues.eventType,
    referralSource: optionalValues.referralSource,
    message,
    nonceId: verdict.id,
  });

  return redirectToThanks(request, token);
}
