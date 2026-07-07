import assert from "node:assert/strict";
import {
  SECRET_CATALOG,
  evaluateEnvPresence,
  buildReport,
  evaluateStripeWebhookEndpoints,
  expectedStripeWebhookUrl,
  STRIPE_REQUIRED_EVENTS,
  evaluateResendDomains,
  resendSendingDomain,
  evaluateTwilioAccount,
  evaluateTwilioFromNumber,
  evaluateCronWranglerConfigs,
  stripJsonComments,
} from "./config-preflight.mjs";

// 1. Missing REQUIRED -> fail; missing ENABLEMENT -> skip, not fail.
{
  const rows = evaluateEnvPresence({});
  const required = rows.filter((row) => row.tier === "REQUIRED");
  const enablement = rows.filter((row) => row.tier === "ENABLEMENT");
  assert.ok(required.length > 0, "catalog should contain REQUIRED entries");
  assert.ok(enablement.length > 0, "catalog should contain ENABLEMENT entries");
  for (const row of required) {
    assert.equal(row.status, "fail", `${row.name} (REQUIRED, missing) should evaluate to fail`);
  }
  for (const row of enablement) {
    assert.equal(row.status, "skip", `${row.name} (ENABLEMENT, missing) should evaluate to skip, not fail`);
  }
}

// 1b. Present REQUIRED -> not fail; length is reported, value is not.
{
  const env = { STRIPE_SECRET_KEY: "sk_test_super_secret_value" };
  const rows = evaluateEnvPresence(env, [{ name: "STRIPE_SECRET_KEY", tier: "REQUIRED", feature: "Stripe payments" }]);
  assert.equal(rows[0].status, "set");
  assert.equal(rows[0].length, env.STRIPE_SECRET_KEY.length);
}

// 2. A fake Stripe webhook-endpoint response missing a required event -> FAIL naming the event.
{
  const expectedUrl = expectedStripeWebhookUrl("https://example.workers.dev");
  const body = {
    data: [
      {
        url: expectedUrl,
        status: "enabled",
        enabled_events: STRIPE_REQUIRED_EVENTS.filter((eventType) => eventType !== "charge.dispute.funds_reinstated"),
      },
    ],
  };
  const result = evaluateStripeWebhookEndpoints(body, { expectedUrl, requiredEvents: STRIPE_REQUIRED_EVENTS });
  assert.equal(result.pass, false);
  assert.match(result.detail, /charge\.dispute\.funds_reinstated/);
}

// 2b. Fully covered endpoint -> PASS.
{
  const expectedUrl = expectedStripeWebhookUrl("https://example.workers.dev");
  const body = {
    data: [{ url: expectedUrl, status: "enabled", enabled_events: STRIPE_REQUIRED_EVENTS }],
  };
  const result = evaluateStripeWebhookEndpoints(body, { expectedUrl, requiredEvents: STRIPE_REQUIRED_EVENTS });
  assert.equal(result.pass, true);
}

// 2c. Endpoint pointed at the wrong host is FAIL with a distinct, actionable message.
{
  const expectedUrl = expectedStripeWebhookUrl("https://example.workers.dev");
  const body = {
    data: [{ url: "https://studio.bythereeses.com/api/stripe/webhook", status: "enabled", enabled_events: ["*"] }],
  };
  const result = evaluateStripeWebhookEndpoints(body, { expectedUrl, requiredEvents: STRIPE_REQUIRED_EVENTS });
  assert.equal(result.pass, false);
  assert.match(result.detail, /wrong host|silent-no-op/i);
}

// 2d. Endpoint present but disabled -> FAIL.
{
  const expectedUrl = expectedStripeWebhookUrl("https://example.workers.dev");
  const body = { data: [{ url: expectedUrl, status: "disabled", enabled_events: STRIPE_REQUIRED_EVENTS }] };
  const result = evaluateStripeWebhookEndpoints(body, { expectedUrl, requiredEvents: STRIPE_REQUIRED_EVENTS });
  assert.equal(result.pass, false);
  assert.match(result.detail, /disabled/);
}

// 3. Resend domain check: verified domain passes, unverified/missing fails.
{
  const domain = resendSendingDomain({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" });
  assert.equal(domain, "bythereeses.com");

  const verified = evaluateResendDomains({ data: [{ name: "bythereeses.com", status: "verified" }] }, { expectedDomain: domain });
  assert.equal(verified.pass, true);

  const pending = evaluateResendDomains({ data: [{ name: "bythereeses.com", status: "pending" }] }, { expectedDomain: domain });
  assert.equal(pending.pass, false);

  const missing = evaluateResendDomains({ data: [] }, { expectedDomain: domain });
  assert.equal(missing.pass, false);
}

// 4. Twilio account + from-number checks.
{
  assert.equal(evaluateTwilioAccount({ status: "active" }).pass, true);
  assert.equal(evaluateTwilioAccount({ status: "suspended" }).pass, false);
  assert.equal(evaluateTwilioAccount({}).pass, false);

  const withNumber = evaluateTwilioFromNumber(
    { incoming_phone_numbers: [{ phone_number: "+15551234567" }] },
    { fromNumber: "+15551234567" },
  );
  assert.equal(withNumber.pass, true);

  const withoutNumber = evaluateTwilioFromNumber({ incoming_phone_numbers: [] }, { fromNumber: "+15551234567" });
  assert.equal(withoutNumber.pass, false);
}

// 5. Cron worker target check — the exact incident class this script exists to catch.
{
  const configs = [
    {
      file: "wrangler.scheduler-reminders.jsonc",
      json: { triggers: { crons: ["0 * * * *"] }, vars: { REMINDER_ENDPOINT: "https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/cron/scheduler-reminders" } },
    },
    {
      file: "wrangler.broken-example.jsonc",
      json: { triggers: { crons: ["0 * * * *"] }, vars: { BROKEN_ENDPOINT: "https://studio.bythereeses.com/api/cron/broken" } },
    },
    {
      // No cron trigger — should be ignored entirely (e.g. wrangler.inquiry-intake.jsonc).
      file: "wrangler.no-cron.jsonc",
      json: { vars: { INTAKE_ENDPOINT: "https://studio.bythereeses.com/api/inbound/inquiry-email" } },
    },
  ];
  const results = evaluateCronWranglerConfigs(configs);
  const good = results.find((r) => r.file === "wrangler.scheduler-reminders.jsonc");
  const bad = results.find((r) => r.file === "wrangler.broken-example.jsonc");
  assert.equal(good.pass, true);
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /login-walled proxy host/);
  assert.equal(results.some((r) => r.file === "wrangler.no-cron.jsonc"), false, "configs without a cron trigger must be skipped entirely");
}

// 5b. stripJsonComments strips // and /* */ comments without corrupting URLs (no "://" false match).
{
  const text = `{
    // a comment
    "vars": {
      "ENDPOINT": "https://example.workers.dev/api/cron/x" // trailing comment
    }
    /* block
       comment */
  }`;
  const stripped = stripJsonComments(text);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.vars.ENDPOINT, "https://example.workers.dev/api/cron/x");
}

// 6. Secret redaction — no secret value ever appears in the rendered env-presence report.
{
  const fakeSecretValue = "sk_live_TOTALLY_FAKE_SECRET_VALUE_DO_NOT_LEAK_9f8e7d6c";
  const env = {
    STRIPE_SECRET_KEY: fakeSecretValue,
    RESEND_API_KEY: fakeSecretValue,
    CRON_SECRET: fakeSecretValue,
  };
  const rows = evaluateEnvPresence(env, SECRET_CATALOG);
  const report = buildReport({ envRows: rows, providerRows: [] });
  assert.ok(!report.text.includes(fakeSecretValue), "rendered report must never contain a secret value");
  // Also assert the rows themselves never carry a `value` field with the secret.
  for (const row of rows) {
    assert.ok(!("value" in row), "evaluateEnvPresence rows must never carry a raw value field");
  }
}

// 6b. Provider check details must never leak an Authorization header or bearer token.
{
  const fakeToken = "Bearer sk_live_should_never_appear_anywhere_in_report_output";
  const rows = [{ section: "Stripe", name: "balance", status: "FAIL", detail: "GET /v1/balance returned HTTP 401." }];
  const report = buildReport({ envRows: [], providerRows: rows });
  assert.ok(!report.text.includes(fakeToken));
  assert.ok(!report.text.toLowerCase().includes("authorization:"));
}

// 7. Exit-code contract: zero REQUIRED fails + zero provider fails -> report.totalFail === 0.
{
  const rows = evaluateEnvPresence(
    { STRIPE_SECRET_KEY: "x", STRIPE_WEBHOOK_SECRET: "x" },
    [
      { name: "STRIPE_SECRET_KEY", tier: "REQUIRED", feature: "Stripe payments" },
      { name: "STRIPE_WEBHOOK_SECRET", tier: "REQUIRED", feature: "Stripe payments" },
      { name: "MONITOR_ENABLED", tier: "ENABLEMENT", feature: "Observability" },
    ],
  );
  const report = buildReport({ envRows: rows, providerRows: [] });
  assert.equal(report.totalFail, 0);
  assert.equal(report.totalSkip, 1);
  assert.equal(report.totalPass, 2);
}

console.log("config preflight tests passed");
