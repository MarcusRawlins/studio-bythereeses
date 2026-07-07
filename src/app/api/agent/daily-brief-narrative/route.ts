import { db } from "@/db/client";
import { dailyBriefNarrations } from "@/db/schema";
import { guardAgentApiRequest } from "@/lib/agent-api";
import { redactSecretEnvValues } from "@/lib/job-runs";
import { guardDirectWorkerApiRequest } from "@/lib/origin-guard";
import { dateKeyInTimeZone } from "@/lib/timezone";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 18 (§3.3) — the narration is agent-composed free text with no schema constraining what it
// can contain, flowing into the digest email that buildHealthDigest carries an explicit invariant
// against (system-health.ts:522-524: "It MUST NEVER interpolate process.env"). Long enough for
// 4-6 sentences, short enough that a narration can never smuggle in a large blob.
const MAX_NARRATIVE_LEN = 1500;

// Strip C0 control characters and DEL (defense-in-depth cap/trim, same discipline as
// sanitizeJobRunError's own cap/trim) while preserving newlines (0x0A) — the narration is a short
// prose paragraph, not a single-line field.
const STRIPPABLE_CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F]/g;
function stripControlCharsPreservingNewlines(value: string): string {
  return value.replace(STRIPPABLE_CONTROL_CHARS, "").replace(/[ \t]+/g, " ").trim();
}

type NarrationInput = { narrative?: unknown };

// Phase 18 — new read-only-JSON-in/write-endpoint-out surface (§3.3), double-guarded exactly like
// /api/agent/health (route.ts:1-22). Body: { narrative: string }. Not exported as an MCP tool —
// this is a write endpoint; it stays REST-only, matching studio_draft_sms/studio_draft_email.
export async function POST(request: Request) {
  const blockedOrigin = guardDirectWorkerApiRequest(request);
  if (blockedOrigin) return blockedOrigin;

  const unauthorized = await guardAgentApiRequest(request);
  if (unauthorized) return unauthorized;

  let body: NarrationInput;
  try {
    body = (await request.json()) as NarrationInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawNarrative = typeof body.narrative === "string" ? body.narrative : "";
  const trimmed = rawNarrative.trim();
  if (!trimmed) {
    return NextResponse.json({ error: "narrative is required." }, { status: 400 });
  }

  // §3.3 (A-3), diff-review MAJOR-1: STRIP control characters FIRST, THEN redact, THEN cap. Order
  // is load-bearing: redactSecretEnvValues does a literal `split(secret).join(...)`, so a secret
  // split by an interleaved control char (e.g. an ANSI escape in pasted log output —
  // `sk_live_sup\x01ersecret`) would not match the literal value and, if the strip ran AFTERWARD,
  // the control char would be deleted and the full secret would reassemble in storage → straight
  // into the digest email, defeating the A-3 invariant. Stripping first collapses the split so the
  // literal-value redaction can catch it. (Whitespace runs collapse to a single space in the same
  // strip, which cannot reassemble a spaceless env secret.) Reuse the extracted redaction loop —
  // never re-implement it.
  const stripped = stripControlCharsPreservingNewlines(trimmed);
  const cleaned = redactSecretEnvValues(stripped).slice(0, MAX_NARRATIVE_LEN);
  if (!cleaned) {
    return NextResponse.json({ error: "narrative is required." }, { status: 400 });
  }

  const dayKey = dateKeyInTimeZone(new Date(), "America/New_York");
  const generatedAt = new Date().toISOString();

  // No db.transaction()/db.batch() (D1 rejects them, job-runs.ts:17) — a single INSERT ... ON
  // CONFLICT upsert. A second call the same day overwrites (last-write-wins, §5): at most one
  // row/day, never a duplicate, never a second AI spend charged to anyone.
  await db
    .insert(dailyBriefNarrations)
    .values({ dayKey, narrative: cleaned, generatedAt })
    .onConflictDoUpdate({
      target: dailyBriefNarrations.dayKey,
      set: { narrative: cleaned, generatedAt },
    });

  return NextResponse.json({ ok: true, dayKey });
}
