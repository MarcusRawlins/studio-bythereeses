import { runDueAutopayCharges } from "@/lib/autopay-charge";
import { autopayEnabled } from "@/lib/autopay-flags";
import { recordJobRun } from "@/lib/job-runs";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretsMatch(provided: string | null, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Phase 13 — the autopay charge cron. A structural clone of cron/sequences/route.ts: CRON_SECRET
// (fallback SCHEDULER_LINK_SECRET) 503-if-unset / timing-safe 401-if-mismatch; flag-off = record ok +
// skip (a flag-off run is a SUCCESSFUL run so staleness never alarms); heartbeat + fail-loud (a throw
// records a FAILURE and returns 500, never masked into a 2xx). `autopay-charger` is a staleness-
// alertable, CRITICAL job — a silently-dead autopay cron is a money-relevant outage.
export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || process.env.SCHEDULER_LINK_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Cron secret is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Guaranteed no-op on a dark deploy (I1): with AUTOPAY_ENABLED off the engine selects nothing and
  // calls no Stripe endpoint. A flag-off run is a SUCCESSFUL run — record ok so staleness never alarms.
  if (!autopayEnabled()) {
    await recordJobRun("autopay-charger", true);
    return NextResponse.json({ skipped: "flag_off" });
  }

  try {
    const result = await runDueAutopayCharges();
    await recordJobRun("autopay-charger", true);
    return NextResponse.json(result);
  } catch (error) {
    await recordJobRun("autopay-charger", false, error instanceof Error ? error.message : "Autopay charger threw.");
    throw error;
  }
}
