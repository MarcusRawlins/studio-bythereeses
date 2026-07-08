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
  evaluateDmarcRecord,
  checkDmarc,
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

// ---------------------------------------------------------------------------
// Phase 25 (§3.1, §6 tests 1-7) — DMARC evaluator + checkDmarc network layer.
// ---------------------------------------------------------------------------

// 8 (spec test 1). Valid record -> pass, policy, hasRua.
{
  const result = evaluateDmarcRecord(["v=DMARC1; p=none; rua=mailto:hello@bythereeses.com; pct=100"]);
  assert.equal(result.pass, true);
  assert.equal(result.policy, "none");
  assert.equal(result.hasRua, true);
}

// 9 (spec test 2). Missing record (empty TXT array) -> pass:false, detail names the
// missing record and its expected location.
{
  const result = evaluateDmarcRecord([], { domain: "bythereeses.com" });
  assert.equal(result.pass, false);
  assert.match(result.detail, /No DMARC record found/i);
  assert.match(result.detail, /_dmarc\.bythereeses\.com/);
}

// 10 (spec test 3). Malformed (unrelated TXT record at the same name) -> pass:false, not a throw.
{
  assert.doesNotThrow(() => evaluateDmarcRecord(["some-unrelated-txt-value"]));
  const result = evaluateDmarcRecord(["some-unrelated-txt-value"]);
  assert.equal(result.pass, false);
}

// 11 (spec test 4, MEDIUM 3). Duplicate v=DMARC1 records -> pass:false, RFC 7489 "no policy" cited.
{
  const result = evaluateDmarcRecord([
    "v=DMARC1; p=none; rua=mailto:a@x.com",
    "v=DMARC1; p=reject",
  ]);
  assert.equal(result.pass, false);
  assert.match(result.detail, /multiple DMARC records/i);
  assert.match(result.detail, /RFC 7489/);
}

// 12 (spec test 5, MEDIUM 3). Missing required p= tag -> pass:false, detail names it.
{
  const result = evaluateDmarcRecord(["v=DMARC1; rua=mailto:hello@bythereeses.com"]);
  assert.equal(result.pass, false);
  assert.match(result.detail, /p=/);
}

// 13 (spec test 6). checkDmarc network layer + DoH response-shape edge cases (MINOR 11).
{
  // Quote-stripping + basic PASS.
  const passDeps = { fetchJson: async () => ({ ok: true, status: 200, json: { Answer: [{ data: '"v=DMARC1; p=none; rua=mailto:hello@bythereeses.com"' }] } }) };
  const passRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, passDeps);
  assert.equal(passRows.length, 1);
  assert.equal(passRows[0].section, "DNS (DMARC)");
  assert.equal(passRows[0].status, "PASS");

  // Multi-string TXT concatenation (split by the resolver into two quoted pieces for ONE record)
  // must NOT be treated as two separate/duplicate records.
  const splitDeps = {
    fetchJson: async () => ({
      ok: true,
      status: 200,
      json: { Answer: [{ type: 16, data: '"v=DMARC1; p=none; " "rua=mailto:hello@bythereeses.com"' }] },
    }),
  };
  const splitRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, splitDeps);
  assert.equal(splitRows[0].status, "PASS", "a TXT value split across multiple quoted strings is concatenated, not treated as a duplicate record");

  // Absent Answer array (NXDOMAIN) -> the same "missing record" FAIL as test 2, not a network FAIL.
  const nxdomainDeps = { fetchJson: async () => ({ ok: true, status: 200, json: { Status: 3 } }) };
  const nxdomainRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, nxdomainDeps);
  assert.equal(nxdomainRows[0].status, "FAIL");
  assert.match(nxdomainRows[0].detail, /No DMARC record found/i);

  // A CNAME-type Answer entry must be skipped, not inspected for v=DMARC1.
  const cnameDeps = {
    fetchJson: async () => ({
      ok: true,
      status: 200,
      json: { Answer: [{ type: 5, data: '"v=DMARC1; p=none"' }] }, // type 5 = CNAME; must be ignored
    }),
  };
  const cnameRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, cnameDeps);
  assert.equal(cnameRows[0].status, "FAIL", "a CNAME-type Answer entry must be skipped, not read as a DMARC record");

  // Network error (thrown) -> one FAIL row with a network-error detail, never an uncaught throw.
  const throwDeps = { fetchJson: async () => { throw new Error("dns resolver unreachable"); } };
  const throwRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, throwDeps);
  assert.equal(throwRows[0].status, "FAIL");
  assert.match(throwRows[0].detail, /Network error/);

  // Diff-review Finding 1: Google DoH reports an UPSTREAM resolver failure as HTTP 200 +
  // { Status: 2 } (SERVFAIL) with no Answer. That must render a RESOLVER-ERROR detail — never the
  // false "No DMARC record found" claim (the spec explicitly rules that out for resolver outages,
  // or Tyler burns time re-adding a record that exists). NXDOMAIN (Status 3) stays a genuine
  // missing-record FAIL (asserted above).
  const servfailDeps = { fetchJson: async () => ({ ok: true, status: 200, json: { Status: 2 } }) };
  const servfailRows = await checkDmarc({ RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>" }, servfailDeps);
  assert.equal(servfailRows[0].status, "FAIL");
  assert.match(servfailRows[0].detail, /resolver error/i, "SERVFAIL renders a resolver-error detail");
  assert.doesNotMatch(servfailRows[0].detail, /No DMARC record found/i, "SERVFAIL never claims the record is missing");
}

// 14 (spec test 7). checkDmarc runs UNCONDITIONALLY (no SKIP branch) regardless of which other
// env vars are set/unset, and is exported (unlike checkStripe/checkResend/checkTwilio).
{
  assert.equal(typeof checkDmarc, "function", "checkDmarc must be exported (MINOR 11)");
  const emptyEnvDeps = { fetchJson: async () => ({ ok: true, status: 200, json: {} }) };
  const rowsNoEnv = await checkDmarc({}, emptyEnvDeps);
  assert.equal(rowsNoEnv.length, 1, "checkDmarc always produces exactly one row, even with zero env vars set");

  const fullEnvDeps = { fetchJson: async () => ({ ok: true, status: 200, json: {} }) };
  const rowsFullEnv = await checkDmarc(
    { RESEND_FROM_EMAIL: "The Reeses <hello@bythereeses.com>", STRIPE_SECRET_KEY: "sk_x", TWILIO_ACCOUNT_SID: "AC_x", TWILIO_AUTH_TOKEN: "tok" },
    fullEnvDeps,
  );
  assert.equal(rowsFullEnv.length, 1, "checkDmarc always produces exactly one row regardless of which other providers are configured");
}

console.log("config preflight tests passed");
