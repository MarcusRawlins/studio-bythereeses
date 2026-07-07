import { listStudioDataHealth } from "@/lib/data-health";
import { computeSystemHealth, type HealthSeverity } from "@/lib/system-health";

type StatusTone = "ok" | "warn" | "info" | "critical";

export type StudioSystemStatusItem = {
  label: string;
  status: string;
  tone: StatusTone;
  detail: string;
};

export type StudioSystemStatus = {
  reviewedAt: string;
  dataHealth: Awaited<ReturnType<typeof listStudioDataHealth>>["summary"];
  frontDoor: StudioSystemStatusItem[];
  runtime: StudioSystemStatusItem[];
  operations: StudioSystemStatusItem[];
  tokenPolicy: StudioSystemStatusItem[];
  knownRisks: StudioSystemStatusItem[];
  systemsHealth: StudioSystemStatusItem[];
};

function severityTone(severity: HealthSeverity): StatusTone {
  if (severity === "critical") return "critical";
  if (severity === "warn") return "warn";
  if (severity === "ok") return "ok";
  return "info";
}

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

function item(label: string, status: string, tone: StatusTone, detail: string): StudioSystemStatusItem {
  return { label, status, tone, detail };
}

function configuredItem(label: string, envName: string, detail: string): StudioSystemStatusItem {
  const isConfigured = configured(process.env[envName]);
  return item(label, isConfigured ? "configured" : "missing", isConfigured ? "ok" : "warn", detail);
}

export async function getStudioSystemStatus(): Promise<StudioSystemStatus> {
  const dataHealth = await listStudioDataHealth();

  // Phase 21: the always-on runtime heartbeat view (autonomous jobs + reconciliation queues).
  // Pure read; never throws the page (falls back to an INFO row if the computation fails).
  let systemsHealth: StudioSystemStatusItem[];
  try {
    const health = await computeSystemHealth();
    systemsHealth = [
      item(
        "Overall systems health",
        health.overall,
        severityTone(health.overall === "green" ? "ok" : (health.overall as HealthSeverity)),
        `Autonomous jobs + reconciliation heartbeat as of ${health.generatedAt}. A missing daily Systems email is itself the alarm (dead-man's-switch, phase-21 §4.3).`,
      ),
      ...health.signals.map((signal) =>
        item(signal.label, signal.severity, severityTone(signal.severity), signal.detail),
      ),
    ];
  } catch {
    systemsHealth = [
      item("Overall systems health", "unavailable", "info", "The systems-health computation failed to run this load."),
    ];
  }

  return {
    reviewedAt: "2026-07-03",
    dataHealth: dataHealth.summary,
    systemsHealth,
    frontDoor: [
      item(
        "Studio admin gate",
        "enforced",
        "ok",
        "studio.bythereeses.com is protected by the Pages proxy Google session for the configured admin email.",
      ),
      item(
        "Schedule host isolation",
        "enforced",
        "ok",
        "schedule.bythereeses.com only allows public booking, questionnaire, proposal, and static asset paths.",
      ),
      configuredItem(
        "Worker origin guard",
        "ORIGIN_PROXY_SECRET",
        "Direct workers.dev access is blocked for private routes when this shared origin secret is configured.",
      ),
      item(
        "Security headers",
        "enabled",
        "ok",
        "The Pages proxy applies HSTS, frame denial, nosniff, referrer policy, permissions policy, and a minimal CSP.",
      ),
    ],
    runtime: [
      configuredItem(
        "Agent and MCP API",
        "STUDIO_AGENT_API_TOKEN",
        "Agent routes require Authorization: Bearer <token>. The token value is never displayed here.",
      ),
      configuredItem(
        "Admin session signing",
        "ADMIN_SESSION_SECRET",
        "Studio browser sessions are signed by the Pages proxy before private pages are allowed through.",
      ),
      configuredItem(
        "Cron reminders",
        "CRON_SECRET",
        "Scheduler reminder cron requests require a bearer secret when configured.",
      ),
      configuredItem(
        "Stripe checkout",
        "STRIPE_SECRET_KEY",
        "Payment checkout routes need Stripe credentials before collecting digital payments.",
      ),
      configuredItem(
        "Stripe webhooks",
        "STRIPE_WEBHOOK_SECRET",
        "Webhook requests must validate Stripe signatures before mutating invoice payment state.",
      ),
    ],
    operations: [
      item(
        "Dependency audit",
        "clean",
        "ok",
        "Last verified with npm audit after the Next/PostCSS and esbuild overrides were added.",
      ),
      item(
        "D1 backup",
        "gated",
        "ok",
        "Deploy preflight requires a non-empty D1 export at /Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/d1/latest.sql.",
      ),
      item(
        "Deploy manifest",
        "captured",
        "ok",
        "Worker and Pages deployment IDs are captured under /Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/manifests/.",
      ),
      item(
        "Production smoke",
        "passing",
        "ok",
        "The live smoke checks verify Studio auth redirect, scheduler cache, data health, finance, and MCP tool availability.",
      ),
    ],
    tokenPolicy: [
      item(
        "Proposal links",
        "scoped",
        "ok",
        "Proposal tokens are random, hashed at rest, expiring, revocable, and scoped to proposal/project/client where applicable.",
      ),
      item(
        "Portal links",
        "scoped",
        "ok",
        "Portal tokens are random, hashed at rest, expiring, revocable, and only resolve project-scoped portal context.",
      ),
      item(
        "Token rate limits",
        "enabled",
        "ok",
        "The Pages proxy rate-limits tokenized proposal and portal access by client IP.",
      ),
    ],
    knownRisks: [
      item(
        "Agent credentials",
        "shared token",
        "warn",
        "Replace the shared bearer token with scoped, rotatable credentials before adding external agents or clients.",
      ),
      item(
        "Rate limiting",
        "proxy-local",
        "warn",
        "Move rate limits into Cloudflare WAF or Turnstile if public abuse becomes real.",
      ),
      item(
        "Restore drill",
        "pending",
        "warn",
        "Run a real D1 restore drill and record the rollback path before relying on backups under stress.",
      ),
    ],
  };
}
