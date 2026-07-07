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

  const emailedKeys: string[] = [];
  const skippedKeys: string[] = [];

  for (const signal of active) {
    const alertKey = signal.alertKey as string;
    // First-sighting insert. If it creates the row → send.
    const inserted = await db
      .insert(healthAlerts)
      .values({ alertKey, severity: "critical", firstSeenAt: now, lastSentAt: null, resolvedAt: null })
      .onConflictDoNothing({ target: healthAlerts.alertKey })
      .returning({ alertKey: healthAlerts.alertKey });

    if (inserted.length > 0) {
      await send({ subject: `Reese CRM CRITICAL: ${signal.label}`, text: signal.detail });
      await db.update(healthAlerts).set({ lastSentAt: now }).where(eq(healthAlerts.alertKey, alertKey));
      emailedKeys.push(alertKey);
      continue;
    }

    // Row already exists. Re-arm only if it was previously resolved (a genuine recurrence).
    const existing = await db.query.healthAlerts.findFirst({ where: eq(healthAlerts.alertKey, alertKey) });
    if (existing?.resolvedAt) {
      await db
        .update(healthAlerts)
        .set({ resolvedAt: null, firstSeenAt: now, lastSentAt: now, severity: "critical" })
        .where(eq(healthAlerts.alertKey, alertKey));
      await send({ subject: `Reese CRM CRITICAL: ${signal.label}`, text: signal.detail });
      emailedKeys.push(alertKey);
    } else {
      skippedKeys.push(alertKey); // already alerted, unresolved → dedupe (no re-email).
    }
  }

  // Resolve any previously-unresolved key that is no longer active → re-arms on next recurrence.
  const openRows = await db.query.healthAlerts.findMany({ where: isNull(healthAlerts.resolvedAt) });
  const resolvedKeys: string[] = [];
  for (const row of openRows) {
    if (!activeKeys.has(row.alertKey)) {
      await db
        .update(healthAlerts)
        .set({ resolvedAt: now })
        .where(and(eq(healthAlerts.alertKey, row.alertKey), isNull(healthAlerts.resolvedAt)));
      resolvedKeys.push(row.alertKey);
    }
  }

  return { emailedKeys, resolvedKeys, skippedKeys };
}
