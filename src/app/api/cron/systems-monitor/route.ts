import { sendAdminAlertEmail } from "@/lib/email";
import { processImmediateCriticalAlerts } from "@/lib/health-alerts";
import { recordJobRun } from "@/lib/job-runs";
import {
  buildHealthDigest,
  computeSystemHealth,
  deadmanPingUrl,
  monitorEnabled,
} from "@/lib/system-health";
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

function easternHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  const parsed = Number(hour);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

export async function POST(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET || process.env.SCHEDULER_LINK_SECRET;
  if (!configuredSecret) {
    // Fail closed: never run the monitor on an unconfigured secret.
    return NextResponse.json({ error: "Cron secret is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretsMatch(provided, configuredSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Off-by-default: with MONITOR_ENABLED unset the route does ZERO autonomous email/ping and
  // writes no heartbeat — a dark deploy is a guaranteed no-op.
  if (!monitorEnabled()) {
    return NextResponse.json({ skipped: "flag_off" });
  }

  const now = new Date();
  let sentImmediate = 0;
  let sentDigest = false;
  let overall: string = "unknown";

  try {
    const report = await computeSystemHealth({ now });
    overall = report.overall;

    // 1. Immediate critical alerts (deduped via health_alerts — email once per instance).
    const alerts = await processImmediateCriticalAlerts({ report, now });
    sentImmediate = alerts.emailedKeys.length;

    // 2. Daily digest — once per day when the ET hour matches the configured digest hour. The
    //    green digest is itself the liveness signal (§4.3 dead-man's-switch, layer 1).
    const digestHour = Number(process.env.MONITOR_DIGEST_HOUR ?? "8");
    if (easternHour(now) === (Number.isFinite(digestHour) ? digestHour : 8)) {
      const digest = buildHealthDigest(report, { deadmanArmed: Boolean(deadmanPingUrl()) });
      sentDigest = await sendAdminAlertEmail(digest);
    }

    // 3. Outbound dead-man ping (§4.3, layer 2 — the only layer that survives a full-stack
    //    death). OUTBOUND ONLY: we expose no inbound public health endpoint. Best-effort.
    const pingUrl = deadmanPingUrl();
    if (pingUrl) {
      try {
        await fetch(pingUrl, { method: "POST", redirect: "manual" });
      } catch {
        // A failed ping is non-fatal — the external service noticing the ABSENCE is the point.
      }
    }

    // 4. Self-heartbeat LAST, after the real work — success.
    await recordJobRun("systems-monitor", true);
    return NextResponse.json({
      ok: true,
      overall,
      immediateAlertsSent: sentImmediate,
      digestSent: sentDigest,
      resolved: alerts.resolvedKeys.length,
    });
  } catch (error) {
    // Record the failure and PRESERVE fail-loud (non-2xx) so the monitor Worker throws and the
    // dead-man ping does NOT fire — a broken monitor must surface, not silently self-report ok.
    await recordJobRun("systems-monitor", false, error instanceof Error ? error.message : "Systems monitor threw.");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Systems monitor failed.", overall },
      { status: 500 },
    );
  }
}
