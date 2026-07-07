#!/usr/bin/env node
// Config-at-rest verification preflight (Phase 21 companion — see
// docs/specs/phase-21-observability-alerting.md §7 "Relationship to
// provider-config verification").
//
// This answers a DIFFERENT question than scripts/production-smoke.mjs (surface
// reachability) and the Phase 21 runtime heartbeats (did jobs run): "is every
// provider actually WIRED?" — is the secret present, is the key still valid,
// is the webhook subscribed to the right URL + events, is the cron pointed at
// the right host. It is READ-ONLY (GET/HEAD only, never POST/DELETE) and is
// meant to be run by Tyler, on his machine, where the real secrets live.
//
// NEVER print a secret value, an Authorization header, or a URL containing a
// token. Every provider call is individually skippable (its secret absent),
// individually timeout-guarded, and never throws past its own check.
//
// Run: node scripts/config-preflight.mjs   (or: npm run config:preflight)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 8000;

// Matches the convention in scripts/production-smoke.mjs (SMOKE_WORKER_ORIGIN).
const WORKER_ORIGIN =
  process.env.SMOKE_WORKER_ORIGIN || "https://reese-photography-crm.solitary-flower-c3ab.workers.dev";
const STUDIO_HOST = "studio.bythereeses.com";

// ---------------------------------------------------------------------------
// 1. Secret / config-var catalog — derived from `grep -r process.env. src
//    workers pages-proxy` (see the report for the exact commands), grouped by
//    feature. Tiers:
//      REQUIRED   — a currently-live, unflagged (or fail-closed-in-prod)
//                   feature breaks or silently misbehaves without this.
//      ENABLEMENT — gates a feature that ships dark by design (an off-by-
//                   default flag per AGENTS.md guardrail #1). Absence is
//                   EXPECTED until Tyler enables that phase — never a FAIL.
//      OPTIONAL   — has a safe code default, or is cosmetic/dev-only.
// ---------------------------------------------------------------------------
export const SECRET_CATALOG = [
  // --- Stripe payments (live: invoice checkout is core Phase 1-11 CRM) ---
  { name: "STRIPE_SECRET_KEY", tier: "REQUIRED", feature: "Stripe payments", note: "Checkout session creation + Balance/webhook-endpoint reads." },
  { name: "STRIPE_WEBHOOK_SECRET", tier: "REQUIRED", feature: "Stripe payments", note: "Signature verification in handleStripeCheckoutWebhook (stripe-checkout.ts)." },

  // --- Resend transactional email (live: booking confirmation/reminder mail is unflagged) ---
  { name: "RESEND_API_KEY", tier: "REQUIRED", feature: "Resend email", note: "resendRequest() (src/lib/email.ts) — booking confirm/reminder mail always attempts to send; missing key silently returns delivered:false." },
  { name: "RESEND_FROM_EMAIL", tier: "OPTIONAL", feature: "Resend email", note: "Has a code default (\"The Reeses <hello@bythereeses.com>\")." },
  { name: "SCHEDULER_ADMIN_EMAIL", tier: "OPTIONAL", feature: "Resend email", note: "Has a code default (hello@bythereeses.com)." },
  { name: "RESEND_UNSUBSCRIBE_MAILBOX", tier: "OPTIONAL", feature: "Resend email", note: "Has a code default (unsubscribe@bythereeses.com); only used by sequence email." },

  // --- Resend bounce/complaint webhook (Phase 24, CR-6 — ships dark: unset secret → 503 no-op) ---
  { name: "RESEND_WEBHOOK_SECRET", tier: "ENABLEMENT", feature: "Resend bounce/complaint webhook", note: "SVIX signature verification in verifyResendWebhookPayload (resend-webhook.ts). Unset → route 503 no-op (the dark mechanism, by design). If RESEND_API_KEY is set but this is unset, bounces/complaints are silently dropped on the floor — see docs/email-deliverability.md fix #2. A rotated/wrong secret is NOT caught here; that is covered by the resend-webhook-signature WARN heartbeat signal instead." },

  // --- Cron auth (live: scheduler-reminders runs hourly today) ---
  { name: "CRON_SECRET", tier: "REQUIRED", feature: "Cron auth", note: "Bearer secret for /api/cron/scheduler-reminders (live), /sequences, /systems-monitor, /heartbeat. 503 unset / 401 wrong." },

  // --- Booking / link signing (live, fails closed in production) ---
  { name: "SCHEDULER_LINK_SECRET", tier: "REQUIRED", feature: "Booking links", note: "Manage/reschedule + questionnaire link signing (scheduler.ts, questionnaire-links.ts). Throws in production if unset AND AUTH_SECRET is also unset." },
  { name: "AUTH_SECRET", tier: "OPTIONAL", feature: "Booking links", note: "Fallback for SCHEDULER_LINK_SECRET; not independently required if that is set." },

  // --- Private asset delivery (live, fails closed in production) ---
  { name: "R2_URL_SIGNING_SECRET", tier: "REQUIRED", feature: "Private assets (R2)", note: "Signed asset URL HMAC (assets.ts). Throws in production if unset." },

  // --- Agent/MCP access (live per docs/studio-agent-access.md) ---
  { name: "STUDIO_AGENT_API_TOKEN", tier: "REQUIRED", feature: "Agent/MCP API", note: "Bearer guard for /api/agent/* + /api/mcp (agent-api.ts). 503 unset / 401 wrong." },

  // --- Origin/admin auth boundary (live security boundary between Pages proxy and Worker) ---
  { name: "ORIGIN_PROXY_SECRET", tier: "REQUIRED", feature: "Origin guard", note: "Blocks direct *.workers.dev admin/API access (origin-guard.ts) unless this header is presented by the trusted proxy." },
  { name: "ADMIN_PROOF_SECRET", tier: "REQUIRED", feature: "Admin auth", note: "admin-proxy-auth.ts verification fails closed (undefined) when unset." },
  { name: "ADMIN_SESSION_SECRET", tier: "REQUIRED", feature: "Admin auth", note: "Pages-proxy admin session cookie HMAC (pages-proxy/_worker.js)." },
  { name: "ADMIN_ALLOWED_EMAIL", tier: "OPTIONAL", feature: "Admin auth", note: "Pages-proxy Google-login allowlist; has a hardcoded fallback (hello@bythereeses.com)." },

  // --- Google (admin login uses the SAME client id/secret as calendar OAuth) ---
  { name: "GOOGLE_CLIENT_ID", tier: "REQUIRED", feature: "Google OAuth (admin login + calendar)", note: "pages-proxy admin Google Sign-In AND google-calendar.ts." },
  { name: "GOOGLE_CLIENT_SECRET", tier: "REQUIRED", feature: "Google OAuth (admin login + calendar)", note: "Same dual use as GOOGLE_CLIENT_ID; pages-proxy/_worker.js:454 token exchange." },
  { name: "GOOGLE_REDIRECT_URI", tier: "OPTIONAL", feature: "Google OAuth", note: "Set as a plain wrangler.jsonc var already; has a localhost dev default." },
  { name: "GOOGLE_REFRESH_TOKEN", tier: "OPTIONAL", feature: "Google Calendar sync", note: "Calendar sync degrades gracefully (googleCredentialsReady() gate) when absent — not yet connected, not a live-breaking gap." },
  { name: "GOOGLE_CALENDAR_ID", tier: "OPTIONAL", feature: "Google Calendar sync", note: "Plain wrangler.jsonc var with a value already; falls back to \"primary\"." },
  { name: "GOOGLE_CALENDAR_IDS", tier: "OPTIONAL", feature: "Google Calendar sync", note: "Plain wrangler.jsonc var with a value already; falls back to \"primary\"." },

  // --- Twilio SMS (Phase 8b — ships behind SMS_ENABLED, off by default) ---
  { name: "SMS_ENABLED", tier: "ENABLEMENT", feature: "Twilio SMS", note: "Off-by-default transport flag (sms.ts smsEnabled()). Absence = SMS not yet turned on." },
  { name: "TWILIO_ACCOUNT_SID", tier: "ENABLEMENT", feature: "Twilio SMS", note: "sendTwilioMessage() fails closed in prod only when SMS is actually reached; SMS_ENABLED gate is checked first." },
  { name: "TWILIO_AUTH_TOKEN", tier: "ENABLEMENT", feature: "Twilio SMS", note: "Same as above." },
  { name: "TWILIO_FROM_NUMBER", tier: "ENABLEMENT", feature: "Twilio SMS", note: "Same as above." },
  { name: "TWILIO_PUBLIC_WEBHOOK_URL_STATUS", tier: "ENABLEMENT", feature: "Twilio SMS", note: "StatusCallback URL Twilio signs against (sms.ts / twilio/status route)." },
  { name: "TWILIO_PUBLIC_WEBHOOK_URL_INBOUND", tier: "ENABLEMENT", feature: "Twilio SMS", note: "Inbound webhook signature-verification URL (twilio/inbound route)." },

  // --- Sequences (Phase 8c — off-by-default per-sequence-type flags) ---
  { name: "SEQUENCES_ENABLED", tier: "ENABLEMENT", feature: "Automated sequences", note: "cron/sequences route gate." },
  { name: "SEQUENCES_PREEVENT", tier: "ENABLEMENT", feature: "Automated sequences", note: "Per-sequence-type flag." },
  { name: "SEQUENCES_REVIEW", tier: "ENABLEMENT", feature: "Automated sequences", note: "Per-sequence-type flag." },
  { name: "SEQUENCES_DUNNING", tier: "ENABLEMENT", feature: "Automated sequences", note: "Per-sequence-type flag." },
  { name: "SEQUENCES_DUNNING_AUTOSEND", tier: "ENABLEMENT", feature: "Automated sequences", note: "Auto-send sub-flag of dunning sequences." },
  { name: "UNSUBSCRIBE_SECRET", tier: "ENABLEMENT", feature: "Automated sequences", note: "Sequence-email unsubscribe token signing; only exercised once sequence email actually sends." },
  { name: "UNSUBSCRIBE_BASE_URL", tier: "OPTIONAL", feature: "Automated sequences", note: "Falls back to a code default." },

  // --- Inbound inquiry-email intake (Phase 8a — wrangler.inquiry-intake.jsonc ships INTAKE_ENABLED=false) ---
  { name: "INQUIRY_INTAKE_ENABLED", tier: "ENABLEMENT", feature: "Inbound inquiry intake", note: "Default OFF per wrangler.inquiry-intake.jsonc comment." },
  { name: "INBOUND_INTAKE_SECRET", tier: "ENABLEMENT", feature: "Inbound inquiry intake", note: "Bearer secret shared with the reese-inquiry-intake Worker." },

  // --- Two-way project email (Phase 14 — explicitly dark per handoff-build-state.md) ---
  { name: "EMAIL_SENDING_ENABLED", tier: "ENABLEMENT", feature: "Two-way project email", note: "Outbound project-email send gate (project-communications.ts)." },
  { name: "INBOUND_PROJECT_EMAIL_ENABLED", tier: "ENABLEMENT", feature: "Two-way project email", note: "Inbound client-reply routing gate (inbound-project-email.ts)." },
  { name: "INBOUND_PROJECT_EMAIL_SECRET", tier: "ENABLEMENT", feature: "Two-way project email", note: "Bearer secret shared with the reese-project-email-inbound Worker." },
  { name: "REPLY_TOKEN_SECRET", tier: "ENABLEMENT", feature: "Two-way project email", note: "Signs the per-project reply token embedded in outbound mail." },
  { name: "REPLY_INBOX_DOMAIN", tier: "OPTIONAL", feature: "Two-way project email", note: "Has a code default." },

  // --- Client portal (magic link + gallery — off-by-default per-feature flags) ---
  { name: "PORTAL_MAGIC_LINK_ENABLED", tier: "ENABLEMENT", feature: "Client portal magic link", note: "Off-by-default per api/portal/request-link route." },
  { name: "PORTAL_GALLERY_ENABLED", tier: "ENABLEMENT", feature: "Client portal gallery", note: "Off-by-default per src/lib/portal.ts." },
  { name: "PORTAL_BASE_URL", tier: "OPTIONAL", feature: "Client portal", note: "Falls back to NEXT_PUBLIC_APP_URL." },
  { name: "PORTAL_MAGIC_LINK_TTL_MINUTES", tier: "OPTIONAL", feature: "Client portal magic link", note: "Numeric tuning value with a code default." },
  { name: "PORTAL_MAGIC_LINK_PER_EMAIL_MAX", tier: "OPTIONAL", feature: "Client portal magic link", note: "Numeric tuning value with a code default." },
  { name: "PORTAL_MAGIC_LINK_MAX_PROJECTS", tier: "OPTIONAL", feature: "Client portal magic link", note: "Numeric tuning value with a code default." },

  // --- Finance depth / refund initiation (Phase 9a live-recording, 9b money-gated OFF) ---
  { name: "FINANCE_REFUND_RECORDING", tier: "ENABLEMENT", feature: "Finance refund recording", note: "off | record_only (default) | enforce three-state (stripe-refunds.ts)." },
  { name: "REFUND_INITIATION_ENABLED", tier: "ENABLEMENT", feature: "Refund initiation (9b)", note: "Money-gated: OFF until Tyler's explicit go (AGENTS.md guardrail #2)." },
  { name: "ADMIN_PROOF_ENFORCE", tier: "ENABLEMENT", feature: "Refund initiation (9b)", note: "Fails OPEN when unset (per phase-9b/production-smoke commentary). MUST be set to \"1\" alongside ORIGIN_PROXY_SECRET before REFUND_INITIATION_ENABLED is ever flipped on — flag this loudly if 9b is enabled but this is not." },

  // --- Unified sign+pay (Phase 12 — explicitly dark) ---
  { name: "UNIFIED_SIGN_PAY", tier: "ENABLEMENT", feature: "Unified sign+pay (Phase 12)", note: "Off-by-default per handoff-build-state.md." },

  // --- Phase 21 observability (ships dark by design; monitor Worker un-wired) ---
  { name: "MONITOR_ENABLED", tier: "ENABLEMENT", feature: "Observability (Phase 21)", note: "Gates the monitor route's email + ping only. Ships OFF." },
  { name: "ALERT_EMAIL", tier: "ENABLEMENT", feature: "Observability (Phase 21)", note: "Tyler's address for the daily digest / critical alerts; unset = digest un-wired." },
  { name: "DEADMAN_PING_URL", tier: "ENABLEMENT", feature: "Observability (Phase 21)", note: "Recommended external dead-man's-switch ping (healthchecks.io-style). Absence is a real open gap, but expected until Tyler wires it — not a hard FAIL here." },
  { name: "MONITOR_DIGEST_HOUR", tier: "OPTIONAL", feature: "Observability (Phase 21)", note: "Has a code default digest hour." },
  { name: "MONITOR_REQUIRED_SINCE", tier: "OPTIONAL", feature: "Observability (Phase 21)", note: "Enablement-timestamp override for required-job staleness math; has a code default." },

  // --- Misc / cosmetic / dev-only ---
  { name: "CSP_MODE", tier: "OPTIONAL", feature: "Middleware CSP", note: "report vs enforce mode; has a default." },
  { name: "DATABASE_PATH", tier: "OPTIONAL", feature: "Local dev only", note: "better-sqlite3 path; unused in production (D1 binding is used instead)." },
];

// ---------------------------------------------------------------------------
// 2. Env-presence evaluation (pure, no network, no secret values ever returned).
// ---------------------------------------------------------------------------
export function evaluateEnvPresence(env, catalog = SECRET_CATALOG) {
  return catalog.map((entry) => {
    const raw = env[entry.name];
    const value = typeof raw === "string" ? raw.trim() : raw;
    const isSet = typeof value === "string" && value.length > 0;
    return {
      name: entry.name,
      tier: entry.tier,
      feature: entry.feature,
      note: entry.note,
      isSet,
      length: isSet ? value.length : 0,
      // status is the rendered outcome; ENABLEMENT absence is SKIP, not FAIL.
      status: isSet
        ? "set"
        : entry.tier === "REQUIRED"
          ? "fail"
          : entry.tier === "ENABLEMENT"
            ? "skip"
            : "skip",
    };
  });
}

export function renderEnvLine(result) {
  const value = result.isSet ? `set (len=${result.length})` : result.tier === "ENABLEMENT" ? "not yet enabled" : "MISSING";
  return `  [${result.status === "fail" ? "FAIL" : result.isSet ? "PASS" : "SKIP"}] ${result.name} (${result.tier}) — ${value}`;
}

// ---------------------------------------------------------------------------
// 3. Stripe — GET-only liveness: /v1/balance (key validity) and
//    /v1/webhook_endpoints (subscribed URL + status + event coverage).
//    Derived from code: handleStripeCheckoutWebhook (stripe-checkout.ts) short-
//    circuits checkout.session.completed / .async_payment_succeeded / .expired;
//    everything else is delegated to dispatchStripeRefundOrDisputeEvent
//    (stripe-refunds.ts), which handles charge.refunded, refund.created,
//    refund.updated, and any charge.dispute.* event (created/updated/closed/
//    funds_reinstated are the ones with explicit status-mapping logic).
// ---------------------------------------------------------------------------
export const STRIPE_REQUIRED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
];

export function expectedStripeWebhookUrl(workerOrigin = WORKER_ORIGIN) {
  return `${workerOrigin.replace(/\/$/, "")}/api/stripe/webhook`;
}

// Pure evaluator over an already-fetched /v1/webhook_endpoints response body.
export function evaluateStripeWebhookEndpoints(body, { expectedUrl, requiredEvents = STRIPE_REQUIRED_EVENTS } = {}) {
  const endpoints = Array.isArray(body?.data) ? body.data : [];
  const match = endpoints.find((endpoint) => endpoint?.url === expectedUrl);
  if (!match) {
    const wrongHostHit = endpoints.find((endpoint) => typeof endpoint?.url === "string" && endpoint.url.includes("/api/stripe/webhook"));
    if (wrongHostHit) {
      return {
        pass: false,
        detail: `No webhook endpoint subscribed at the expected URL (${redactUrl(expectedUrl)}). Found a stripe/webhook endpoint pointed elsewhere (wrong host) — this is the same silent-no-op class as the reminders-cron incident.`,
      };
    }
    return { pass: false, detail: `No Stripe webhook endpoint found subscribed to ${redactUrl(expectedUrl)}.` };
  }
  if (match.status !== "enabled") {
    return { pass: false, detail: `Webhook endpoint at the expected URL has status "${match.status}", not "enabled".` };
  }
  const enabledEvents = new Set(Array.isArray(match.enabled_events) ? match.enabled_events : []);
  const coversAll = enabledEvents.has("*");
  const missing = coversAll ? [] : requiredEvents.filter((eventType) => !enabledEvents.has(eventType));
  if (missing.length > 0) {
    return { pass: false, detail: `Webhook endpoint is missing required event(s): ${missing.join(", ")}.` };
  }
  return { pass: true, detail: `Webhook endpoint enabled at the expected URL, covering all ${requiredEvents.length} required event types.` };
}

// ---------------------------------------------------------------------------
// 4. Resend — GET /v1/domains: key validity + the sending domain (derived from
//    RESEND_FROM_EMAIL's default / configured from-address in email.ts) is
//    present and verified.
// ---------------------------------------------------------------------------
export function resendSendingDomain(env = process.env) {
  const from = env.RESEND_FROM_EMAIL || "The Reeses <hello@bythereeses.com>";
  const match = from.match(/@([^\s>]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function evaluateResendDomains(body, { expectedDomain }) {
  const domains = Array.isArray(body?.data) ? body.data : [];
  const match = domains.find((domain) => typeof domain?.name === "string" && domain.name.toLowerCase() === expectedDomain);
  if (!match) {
    return { pass: false, detail: `Sending domain ${expectedDomain} not found in Resend account domains.` };
  }
  if (match.status !== "verified") {
    return { pass: false, detail: `Sending domain ${expectedDomain} has status "${match.status}", not "verified".` };
  }
  return { pass: true, detail: `Sending domain ${expectedDomain} verified.` };
}

// ---------------------------------------------------------------------------
// 5. Twilio — GET account info (key validity + account active) + optionally
//    assert the configured TWILIO_FROM_NUMBER exists among incoming numbers.
// ---------------------------------------------------------------------------
export function evaluateTwilioAccount(body) {
  if (!body || typeof body.status !== "string") {
    return { pass: false, detail: "Twilio account response did not include a status field." };
  }
  if (body.status !== "active") {
    return { pass: false, detail: `Twilio account status is "${body.status}", not "active".` };
  }
  return { pass: true, detail: "Twilio account active." };
}

export function evaluateTwilioFromNumber(body, { fromNumber }) {
  const numbers = Array.isArray(body?.incoming_phone_numbers) ? body.incoming_phone_numbers : [];
  const match = numbers.find((entry) => entry?.phone_number === fromNumber);
  if (!match) {
    return { pass: false, detail: `TWILIO_FROM_NUMBER (${maskPhone(fromNumber)}) not found among this account's incoming phone numbers.` };
  }
  return { pass: true, detail: `TWILIO_FROM_NUMBER (${maskPhone(fromNumber)}) found among incoming phone numbers.` };
}

function maskPhone(value) {
  if (typeof value !== "string" || value.length <= 4) return "***";
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// 6. Cron worker target check (static, no network) — this is the exact class
//    of bug that motivated this script: a cron var pointed at the login-
//    walled proxy host (studio.bythereeses.com/api/cron/*) silently 303s to
//    /admin/login, reads the 200 login page as success, and no-ops forever.
// ---------------------------------------------------------------------------
export function evaluateCronWranglerConfigs(configs) {
  // configs: [{ file, json }] where json is the parsed wrangler.*.jsonc content
  const results = [];
  for (const { file, json } of configs) {
    const hasCron = Array.isArray(json?.triggers?.crons) && json.triggers.crons.length > 0;
    if (!hasCron) continue;
    const vars = json?.vars || {};
    const endpointEntries = Object.entries(vars).filter(([key, value]) => /ENDPOINT|URL/i.test(key) && typeof value === "string" && /^https?:\/\//.test(value));
    if (endpointEntries.length === 0) {
      results.push({ file, pass: false, detail: "Has a cron trigger but no discoverable *_ENDPOINT/*_URL var to check." });
      continue;
    }
    for (const [key, value] of endpointEntries) {
      let host = "";
      try {
        host = new URL(value).hostname;
      } catch {
        results.push({ file, key, pass: false, detail: `${key} is not a valid URL.` });
        continue;
      }
      if (host === STUDIO_HOST) {
        results.push({
          file,
          key,
          pass: false,
          detail: `${key} points at the login-walled proxy host (${STUDIO_HOST}) — this silently 303s to /admin/login and reads the login page as success (the original incident). Must point at the workers.dev origin.`,
        });
      } else if (host.endsWith(".workers.dev")) {
        results.push({ file, key, pass: true, detail: `${key} points at the workers.dev origin (${host}).` });
      } else {
        results.push({ file, key, pass: false, detail: `${key} points at an unexpected host (${host}) — expected a *.workers.dev origin.` });
      }
    }
  }
  return results;
}

// Strip inline // and /* */ comments so wrangler .jsonc parses as JSON.
export function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function loadWranglerConfigs(dir) {
  const files = fs.readdirSync(dir).filter((name) => /^wrangler(\..+)?\.jsonc?$/.test(name));
  const configs = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const json = JSON.parse(stripJsonComments(text));
      configs.push({ file, json });
    } catch (error) {
      configs.push({ file, json: null, parseError: error instanceof Error ? error.message : String(error) });
    }
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Redaction helpers — never print secret values, Authorization headers, or a
// URL containing a token/query string.
// ---------------------------------------------------------------------------
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[unparseable url]";
  }
}

// ---------------------------------------------------------------------------
// Network layer — injectable so tests never make real requests. Every call is
// timeout-guarded and try/caught by the caller; a network failure renders as
// FAIL for that specific check, never a crash.
// ---------------------------------------------------------------------------
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const defaultDeps = { fetchJson: fetchJsonWithTimeout };

// ---------------------------------------------------------------------------
// Provider check runners — each returns a list of { section, name, status,
// detail } rows. status is one of PASS / FAIL / SKIP. Each is individually
// wrapped in try/catch so one provider's network hiccup never aborts the rest
// of the report.
// ---------------------------------------------------------------------------
async function checkStripe(env, deps = defaultDeps) {
  const rows = [];
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    rows.push({ section: "Stripe", name: "balance", status: "SKIP", detail: "STRIPE_SECRET_KEY not set." });
    rows.push({ section: "Stripe", name: "webhook_endpoints", status: "SKIP", detail: "STRIPE_SECRET_KEY not set." });
    return rows;
  }
  const authHeader = { Authorization: `Bearer ${key}` };

  try {
    const balance = await deps.fetchJson("https://api.stripe.com/v1/balance", { headers: authHeader });
    rows.push(
      balance.ok
        ? { section: "Stripe", name: "balance (key validity)", status: "PASS", detail: "STRIPE_SECRET_KEY is valid (GET /v1/balance succeeded)." }
        : { section: "Stripe", name: "balance (key validity)", status: "FAIL", detail: `GET /v1/balance returned HTTP ${balance.status}.` },
    );
  } catch (error) {
    rows.push({ section: "Stripe", name: "balance (key validity)", status: "FAIL", detail: `Network error: ${errorMessage(error)}` });
  }

  try {
    const endpoints = await deps.fetchJson("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: authHeader });
    if (!endpoints.ok) {
      rows.push({ section: "Stripe", name: "webhook_endpoints", status: "FAIL", detail: `GET /v1/webhook_endpoints returned HTTP ${endpoints.status}.` });
    } else {
      const expectedUrl = expectedStripeWebhookUrl(env.SMOKE_WORKER_ORIGIN || WORKER_ORIGIN);
      const evaluation = evaluateStripeWebhookEndpoints(endpoints.json, { expectedUrl, requiredEvents: STRIPE_REQUIRED_EVENTS });
      rows.push({ section: "Stripe", name: "webhook_endpoints", status: evaluation.pass ? "PASS" : "FAIL", detail: evaluation.detail });
    }
  } catch (error) {
    rows.push({ section: "Stripe", name: "webhook_endpoints", status: "FAIL", detail: `Network error: ${errorMessage(error)}` });
  }

  return rows;
}

async function checkResend(env, deps = defaultDeps) {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) {
    return [{ section: "Resend", name: "domains", status: "SKIP", detail: "RESEND_API_KEY not set." }];
  }
  try {
    const response = await deps.fetchJson("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) {
      return [{ section: "Resend", name: "domains", status: "FAIL", detail: `GET /domains returned HTTP ${response.status} (key may be invalid/revoked).` }];
    }
    const expectedDomain = resendSendingDomain(env);
    const evaluation = evaluateResendDomains(response.json, { expectedDomain });
    return [{ section: "Resend", name: "domains", status: evaluation.pass ? "PASS" : "FAIL", detail: evaluation.detail }];
  } catch (error) {
    return [{ section: "Resend", name: "domains", status: "FAIL", detail: `Network error: ${errorMessage(error)}` }];
  }
}

async function checkTwilio(env, deps = defaultDeps) {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  if (!sid || !token) {
    return [{ section: "Twilio", name: "account", status: "SKIP", detail: "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set (SMS may be un-enabled)." }];
  }
  const authHeader = { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` };
  const rows = [];
  try {
    const response = await deps.fetchJson(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { headers: authHeader });
    if (!response.ok) {
      rows.push({ section: "Twilio", name: "account", status: "FAIL", detail: `GET account info returned HTTP ${response.status} (key may be invalid/revoked).` });
    } else {
      const evaluation = evaluateTwilioAccount(response.json);
      rows.push({ section: "Twilio", name: "account", status: evaluation.pass ? "PASS" : "FAIL", detail: evaluation.detail });
    }
  } catch (error) {
    rows.push({ section: "Twilio", name: "account", status: "FAIL", detail: `Network error: ${errorMessage(error)}` });
  }

  const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
  if (!fromNumber) {
    rows.push({ section: "Twilio", name: "from_number", status: "SKIP", detail: "TWILIO_FROM_NUMBER not set." });
  } else {
    try {
      const response = await deps.fetchJson(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=100`,
        { headers: authHeader },
      );
      if (!response.ok) {
        rows.push({ section: "Twilio", name: "from_number", status: "FAIL", detail: `GET IncomingPhoneNumbers returned HTTP ${response.status}.` });
      } else {
        const evaluation = evaluateTwilioFromNumber(response.json, { fromNumber });
        rows.push({ section: "Twilio", name: "from_number", status: evaluation.pass ? "PASS" : "FAIL", detail: evaluation.detail });
      }
    } catch (error) {
      rows.push({ section: "Twilio", name: "from_number", status: "FAIL", detail: `Network error: ${errorMessage(error)}` });
    }
  }
  return rows;
}

async function checkDeadman(env, deps = defaultDeps) {
  const url = env.DEADMAN_PING_URL?.trim();
  if (!url) {
    return [{ section: "Deadman ping (Phase 21, enablement)", name: "ping", status: "SKIP", detail: "DEADMAN_PING_URL not set — recommended but not yet enabled (see phase-21 §4.3)." }];
  }
  try {
    let response;
    try {
      response = await deps.fetchJson(url, { method: "HEAD" });
    } catch {
      response = await deps.fetchJson(url, { method: "GET" });
    }
    const pass = response.status >= 200 && response.status < 300;
    return [{
      section: "Deadman ping (Phase 21, enablement)",
      name: "ping",
      status: pass ? "PASS" : "FAIL",
      detail: pass ? `Reachable (HTTP ${response.status}).` : `Returned HTTP ${response.status}.`,
    }];
  } catch (error) {
    return [{ section: "Deadman ping (Phase 21, enablement)", name: "ping", status: "FAIL", detail: `Network error: ${errorMessage(error)}` }];
  }
}

function checkCronTargets(repoRoot) {
  let configs;
  try {
    configs = loadWranglerConfigs(repoRoot);
  } catch (error) {
    return [{ section: "Cron worker targets", name: "wrangler configs", status: "FAIL", detail: `Could not read wrangler configs: ${errorMessage(error)}` }];
  }
  const parseErrors = configs.filter((entry) => entry.parseError);
  const results = evaluateCronWranglerConfigs(configs.filter((entry) => !entry.parseError));
  const rows = parseErrors.map((entry) => ({
    section: "Cron worker targets",
    name: entry.file,
    status: "FAIL",
    detail: `Could not parse ${entry.file}: ${entry.parseError}`,
  }));
  for (const result of results) {
    rows.push({
      section: "Cron worker targets",
      name: `${result.file}${result.key ? ` (${result.key})` : ""}`,
      status: result.pass ? "PASS" : "FAIL",
      detail: result.detail,
    });
  }
  if (rows.length === 0) {
    rows.push({ section: "Cron worker targets", name: "wrangler configs", status: "SKIP", detail: "No wrangler.*.jsonc files with a cron trigger found." });
  }
  return rows;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 7. Report builder — grouped, human-scannable, exit code carries the verdict.
// ---------------------------------------------------------------------------
export function buildReport({ envRows, providerRows }) {
  const lines = [];
  lines.push("=".repeat(72));
  lines.push("CONFIG PREFLIGHT — config-at-rest verification (read-only, one-shot)");
  lines.push("=".repeat(72));

  const byFeature = new Map();
  for (const row of envRows) {
    if (!byFeature.has(row.feature)) byFeature.set(row.feature, []);
    byFeature.get(row.feature).push(row);
  }

  lines.push("");
  lines.push("-- Env presence (no network) --");
  for (const [feature, rows] of byFeature) {
    lines.push(`\n${feature}`);
    for (const row of rows) lines.push(renderEnvLine(row));
  }

  lines.push("");
  lines.push("-- Provider liveness checks (read-only) --");
  const bySection = new Map();
  for (const row of providerRows) {
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section).push(row);
  }
  for (const [section, rows] of bySection) {
    lines.push(`\n${section}`);
    for (const row of rows) {
      lines.push(`  [${row.status}] ${row.name} — ${row.detail}`);
    }
  }

  const envFails = envRows.filter((row) => row.status === "fail").length;
  const envSkips = envRows.filter((row) => row.status === "skip").length;
  const envPasses = envRows.length - envFails - envSkips;

  const providerPasses = providerRows.filter((row) => row.status === "PASS").length;
  const providerFails = providerRows.filter((row) => row.status === "FAIL").length;
  const providerSkips = providerRows.filter((row) => row.status === "SKIP").length;

  const totalPass = envPasses + providerPasses;
  const totalFail = envFails + providerFails;
  const totalSkip = envSkips + providerSkips;

  lines.push("");
  lines.push("=".repeat(72));
  lines.push(`config-preflight: ${totalPass} pass, ${totalFail} fail, ${totalSkip} skipped`);
  lines.push("=".repeat(72));

  return { text: lines.join("\n"), totalPass, totalFail, totalSkip };
}

// ---------------------------------------------------------------------------
// 8. Main — network-touching orchestration. Every secret-bearing string that
//    ever reaches this function stays inside it; nothing downstream (report
//    builder, catalog) ever sees a raw secret value.
// ---------------------------------------------------------------------------
async function main() {
  const env = process.env;
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const envRows = evaluateEnvPresence(env);

  const providerRows = [];
  const checks = [
    checkStripe(env),
    checkResend(env),
    checkTwilio(env),
    checkDeadman(env),
  ];
  const settled = await Promise.allSettled(checks);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      providerRows.push(...result.value);
    } else {
      providerRows.push({ section: "Provider check", name: "unexpected error", status: "FAIL", detail: errorMessage(result.reason) });
    }
  }
  providerRows.push(...checkCronTargets(rootDir));

  const report = buildReport({ envRows, providerRows });
  console.log(report.text);

  process.exit(report.totalFail > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
