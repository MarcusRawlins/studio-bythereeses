// Phase 21 — immediate-critical alert dedupe (§4.4). For each CRITICAL signal with a stable
// alert_key we fire the email ONCE per condition instance and re-arm on clear:
//   - INSERT ... ON CONFLICT(alert_key) DO NOTHING; email ONLY when the insert created the row
//     (first sighting) — so the same stuck refund does not re-email every hour.
//   - A key that was previously resolved (resolved_at set) but recurs is RE-ARMED and emails
//     again.
//   - A key no longer present in the computed report is marked resolved_at so a future
//     recurrence re-arms.
// No db.transaction()/db.batch() (D1 rejects them) — per-object convergence only. NON-CANONICAL:
// writes ONLY health_alerts.

import { db } from "@/db/client";
import { healthAlerts } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { criticalAlertSignals, type SystemHealthReport } from "@/lib/system-health";
import { sendAdminAlertEmail } from "@/lib/email";

export type AlertSender = (input: { subject: string; text: string }) => Promise<boolean>;

export type ProcessAlertsResult = {
  emailedKeys: string[];
  resolvedKeys: string[];
  skippedKeys: string[];
  // Keys where a send was ATTEMPTED this run but the sender returned false (delivery failed).
  // lastSentAt stays NULL → the send is RETRIED next run, and the monitor route treats a
  // properly-configured attempted-and-failed send as a delivery failure (fail-loud, §4.2).
  failedKeys: string[];
};

export async function processImmediateCriticalAlerts(input: {
  report: SystemHealthReport;
  now?: Date;
  send?: AlertSender;
}): Promise<ProcessAlertsResult> {
  const now = (input.now ?? new Date()).toISOString();
  const send = input.send ?? sendAdminAlertEmail;
  const active = criticalAlertSignals(input.report);
  const activeKeys = new Set(active.map((s) => s.alertKey as string));
  // Alert-key prefixes whose SOURCE failed to read this run (e.g. the finance/refund read threw).
  // The resolve sweep MUST NOT resolve/re-arm these keys — the condition may still be active but
  // was unreadable, and resolving it would re-email the same stuck refund every flapping cycle
  // (FIX 5). Carried on the report by computeSystemHealth.
  const degradedPrefixes = input.report.degradedAlertKeyPrefixes ?? [];
  const isDegraded = (key: string) => degradedPrefixes.some((prefix) => key.startsWith(prefix));

  const emailedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const failedKeys: string[] = [];

  for (const signal of active) {
    const alertKey = signal.alertKey as string;
    // First-sighting insert (dedupe only — do NOT stamp lastSentAt here; the send+stamp is a
    // SEPARATE step gated on delivery success, so a failed critical email is never permanently
    // deduped away — FIX 1).
    await db
      .insert(healthAlerts)
      .values({ alertKey, severity: "critical", firstSeenAt: now, lastSentAt: null, resolvedAt: null })
      .onConflictDoNothing({ target: healthAlerts.alertKey });

    const existing = await db.query.healthAlerts.findFirst({ where: eq(healthAlerts.alertKey, alertKey) });

    // Genuine recurrence: a previously-resolved key recurs → re-arm (clear resolved + lastSentAt
    // so it re-sends). Treated as NOT-already-sent below.
    if (existing?.resolvedAt) {
      await db
        .update(healthAlerts)
        .set({ resolvedAt: null, firstSeenAt: now, lastSentAt: null, severity: "critical" })
        .where(eq(healthAlerts.alertKey, alertKey));
    }

    // Already alerted = row exists, unresolved, AND lastSentAt IS NOT NULL. "Row exists" alone is
    // NOT "already alerted" — a row whose lastSentAt is null (first send failed, or a fresh
    // re-arm) must RETRY the send.
    const alreadySent = Boolean(existing?.lastSentAt) && !existing?.resolvedAt;
    if (alreadySent) {
      skippedKeys.push(alertKey);
      continue;
    }

    // Send, and stamp lastSentAt ONLY when the send actually succeeded.
    const delivered = await send({ subject: `Reese CRM CRITICAL: ${signal.label}`, text: signal.detail });
    if (delivered) {
      await db.update(healthAlerts).set({ lastSentAt: now }).where(eq(healthAlerts.alertKey, alertKey));
      emailedKeys.push(alertKey);
    } else {
      // lastSentAt stays NULL → retried next run; surfaced as a delivery failure to the route.
      failedKeys.push(alertKey);
    }
  }

  // Resolve any previously-unresolved key that is no longer active → re-arms on next recurrence.
  // Skip keys whose SOURCE was degraded this run (FIX 5): a failing read must not silently
  // resolve/re-arm an alert whose condition it could not evaluate.
  const openRows = await db.query.healthAlerts.findMany({ where: isNull(healthAlerts.resolvedAt) });
  const resolvedKeys: string[] = [];
  for (const row of openRows) {
    if (activeKeys.has(row.alertKey)) continue;
    if (isDegraded(row.alertKey)) continue;
    await db
      .update(healthAlerts)
      .set({ resolvedAt: now })
      .where(and(eq(healthAlerts.alertKey, row.alertKey), isNull(healthAlerts.resolvedAt)));
    resolvedKeys.push(row.alertKey);
  }

  return { emailedKeys, resolvedKeys, skippedKeys, failedKeys };
}
