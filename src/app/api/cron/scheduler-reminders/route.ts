import { recordJobRun } from "@/lib/job-runs";
import { sendDueSchedulerReminders } from "@/lib/scheduler";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

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
    // Fail closed: never run the reminder job on an unconfigured secret.
    return NextResponse.json({ error: "Cron secret is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Phase 21 heartbeat. Record the outcome, then PRESERVE the fail-loud contract: a thrown
  // job records a FAILURE and STILL returns 500 (monitoring is additive, never masks a
  // failure into a 2xx). await the write before returning (Workers cancel post-response
  // promises).
  let result;
  try {
    result = await sendDueSchedulerReminders();
  } catch (error) {
    await recordJobRun("scheduler-reminders", false, error instanceof Error ? error.message : "Reminder job threw.");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reminder job failed." },
      { status: 500 },
    );
  }

  // "Ran but sent nothing" rule (§2.3): due > 0 with sent === 0 is persistent provider
  // breakage (e.g. RESEND_API_KEY revoked) — record a FAILURE even though the call resolved.
  // A transient blip (failed > 0 but sent > 0) is self-healing next hour → recorded as ok
  // (computeSystemHealth surfaces it as WARN, not a hard failure).
  if (result.due > 0 && result.sent === 0) {
    await recordJobRun(
      "scheduler-reminders",
      false,
      `Reminders ran but sent nothing: ${result.due} due, ${result.failed} failed to deliver.`,
    );
  } else if (result.failed > 0 && result.sent > 0) {
    // Transient partial-send blip — self-healing next hour. Recorded as SUCCESS with an
    // advisory note so computeSystemHealth surfaces WARN (not a hard failure).
    await recordJobRun(
      "scheduler-reminders",
      true,
      `Transient: ${result.failed} of ${result.due} reminders failed to deliver (retries next hour).`,
    );
  } else {
    await recordJobRun("scheduler-reminders", true);
  }
  return NextResponse.json(result);
}
