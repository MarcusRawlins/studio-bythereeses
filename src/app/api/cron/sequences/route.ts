import { recordJobRun } from "@/lib/job-runs";
import { runDueSequences, sequencesEnabled } from "@/lib/sequences";
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

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || process.env.SCHEDULER_LINK_SECRET;
  if (!configuredSecret) {
    // Fail closed: never run the sequence job on an unconfigured secret.
    return NextResponse.json({ error: "Cron secret is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Guaranteed no-op on a dark deploy: a registered cron with the flag off moves
  // zero rows (defense-in-depth; runDueSequences also self-guards). Phase 21: a
  // flag-off run is a SUCCESSFUL run — record ok:true so staleness does not alarm.
  if (!sequencesEnabled()) {
    await recordJobRun("sequence-runner", true);
    return NextResponse.json({ skipped: "flag_off" });
  }

  // Phase 21 heartbeat: record then PRESERVE the fail-loud contract — a throw records a
  // FAILURE and is re-raised (Next returns 500) rather than being masked into a 2xx.
  try {
    const result = await runDueSequences();
    await recordJobRun("sequence-runner", true);
    return NextResponse.json(result);
  } catch (error) {
    await recordJobRun("sequence-runner", false, error instanceof Error ? error.message : "Sequence runner threw.");
    throw error;
  }
}
