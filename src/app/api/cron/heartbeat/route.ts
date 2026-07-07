import { recordJobRun, type JobName } from "@/lib/job-runs";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bearer-authed heartbeat endpoint for jobs that run OUTSIDE the Cloudflare Worker (the launchd
// backup script POSTs it after a successful backup:data). Writes ONLY job_runs (non-canonical),
// so it is safe next to the other cron entries in the origin-guard bypass list. 503 unset /
// 401 wrong (constant-time) — identical shape to the other cron routes.

function secretsMatch(provided: string | null, expected: string) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only these known operational job keys may be written via the public heartbeat endpoint (no
// arbitrary key injection). Restricted to backup-d1 ONLY (FIX 6): it is the sole job that runs
// OUT-of-Worker (the launchd backup script). scheduler-reminders / sequence-runner write their own
// heartbeat CRM-side inside the bearer-authed cron route; allowing them here would let a
// CRON_SECRET compromise (the secret sits in plaintext in the mac-mini launchd script — the
// weakest custody point) forge fresh liveness for those jobs and SUPPRESS the exact staleness
// alarms this phase builds.
const ALLOWED_HEARTBEAT_JOBS = new Set<JobName>(["backup-d1"]);

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || process.env.SCHEDULER_LINK_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Cron secret is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { job?: unknown; ok?: unknown; error?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const job = typeof body.job === "string" ? (body.job as JobName) : null;
  if (!job || !ALLOWED_HEARTBEAT_JOBS.has(job)) {
    return NextResponse.json({ error: "Unknown or missing job." }, { status: 400 });
  }
  const ok = body.ok !== false; // default true unless explicitly false
  const error = typeof body.error === "string" ? body.error : null;

  await recordJobRun(job, ok, ok ? null : error ?? "Heartbeat reported failure.");
  return NextResponse.json({ recorded: job, ok });
}
