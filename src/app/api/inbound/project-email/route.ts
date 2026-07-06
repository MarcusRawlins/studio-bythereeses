import {
  ingestInboundProjectEmail,
  isInboundProjectEmailEnabled,
} from "@/lib/inbound-project-email";
import { MAX_INBOUND_JSON_BYTES, type InboundEmailPayload } from "@/lib/inbound-inquiry";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

// Phase 14 — inbound client-email → EXISTING project thread endpoint. A
// structural copy of /api/inbound/inquiry-email. Fail-closed bearer auth on a
// DEDICATED secret (NOT the shared agent token). Machine-reachable through the
// proxy only; NOT origin-guard-bypassed. Every non-attach / unconfigured / flag-
// off outcome answers NON-2xx so the Worker forwards the message to a human
// (never a silent drop, never a false 2xx-that-didn't-persist).
function secretsMatch(provided: string | null, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.INBOUND_PROJECT_EMAIL_SECRET;
  if (!configuredSecret) {
    // Fail closed (unconfigured). Non-2xx so the Worker forwards.
    return NextResponse.json({ error: "Inbound project-email secret is not configured." }, { status: 503 });
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Server-side feature flag. OFF ⇒ 503 (non-2xx), NEVER 2xx, so the Worker's
  // !res.ok branch forwards the message to the human fallback.
  if (!isInboundProjectEmailEnabled()) {
    return NextResponse.json({ error: "Inbound project email is disabled." }, { status: 503 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_INBOUND_JSON_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let payload: InboundEmailPayload;
  try {
    payload = JSON.parse(rawBody) as InboundEmailPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  // Persist-then-2xx: a 2xx is returned ONLY after the inbound row is durably
  // written (attached). Any non-attach (no/invalid token, deleted project,
  // rate-limited) answers non-2xx so the Worker forwards to a human — never a
  // silent drop, never an auto-attach on a spoofable From.
  try {
    const result = await ingestInboundProjectEmail(payload);
    if (result.attached) {
      return NextResponse.json(
        { attached: true, id: result.id, projectId: result.projectId, deduped: result.deduped },
        { status: 200 },
      );
    }
    // Non-attach → 422 (non-2xx) → Worker forwards to the human fallback.
    return NextResponse.json({ attached: false, reason: result.reason }, { status: 422 });
  } catch {
    // A failure to persist must be a non-2xx so the Worker forwards to a human.
    return NextResponse.json({ error: "Failed to persist inbound email." }, { status: 500 });
  }
}
