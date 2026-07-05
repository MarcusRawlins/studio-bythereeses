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
  // zero rows (defense-in-depth; runDueSequences also self-guards).
  if (!sequencesEnabled()) {
    return NextResponse.json({ skipped: "flag_off" });
  }

  return NextResponse.json(await runDueSequences());
}
