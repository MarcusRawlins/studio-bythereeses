// Phase 13 §10 — autopay / card-on-file acceptance tests (tests 3-43, incl. the §10.10/§10.11 attack
// tests). Every scenario STUBS globalThis.fetch so any hit to api.stripe.com is counted — NO real
// network, NO real money. The POST /v1/payment_intents count is the money assertion throughout.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-autopay-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STRIPE_SECRET_KEY = "sk_test_autopay_13";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_autopay_13";
process.env.AUTOPAY_ENABLED = "1";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
delete process.env.EMAIL_SENDING_ENABLED; // most scenarios keep client emails OFF (gate closed)
delete process.env.AUTOPAY_PILOT_ALLOWLIST;
delete process.env.AUTOPAY_MAX_CHARGE_CENTS;

const PI_URL = "https://api.stripe.com/v1/payment_intents";
const RESEND_URL = "https://api.resend.com/emails";
const NOW = new Date("2026-07-08T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

type Call = { url: string; method: string; body: string; idempotencyKey: string | undefined };
const calls: Call[] = [];
const resendCalls: { to: string; subject: string }[] = [];

// -- programmable stub controls --------------------------------------------------------------
let piBehavior: "succeeded" | "requires_action" | "card_declined" | "hard_decline" | "network" | "server_error" = "succeeded";
let sessionGetFail = false;
let sessionStatusDefault = "open";
let sessionStatusQueue: string[] = [];
let expireBehavior: "ok" | "fail" = "ok";
let cancelBehavior: "ok" | "fail" = "ok";
let piGetStatus = "succeeded";
let piCounter = 0;
let lastPiId: string | null = null;

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function sessionFullBody(sessionId: string, status: string, payid: string, iid: string, amountTotal: number, serviceOpen: number) {
  return {
    id: sessionId,
    status,
    payment_status: status === "complete" ? "paid" : "unpaid",
    amount_total: amountTotal,
    url: "https://checkout.stripe.com/x",
    payment_intent: `pi_manual_${payid}`,
    metadata: { payment_id: payid, invoice_id: iid, project_id: "", service_open_cents: String(serviceOpen) },
  };
}
// session context for the cross-channel GET (set per scenario).
let sessionCtx = { sessionId: "", payid: "", iid: "", amountTotal: 0, serviceOpen: 0 };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = init?.body != null ? String(init.body) : "";
  calls.push({ url, method, body, idempotencyKey: headers["idempotency-key"] });

  if (url === PI_URL && method === "POST") {
    if (piBehavior === "network") throw new Error("simulated network failure");
    if (piBehavior === "server_error") return jsonResp(500, { error: { message: "server error" } });
    const id = `pi_${++piCounter}`;
    lastPiId = id;
    if (piBehavior === "requires_action") {
      return jsonResp(402, { error: { code: "authentication_required", payment_intent: { id, status: "requires_action" } } });
    }
    if (piBehavior === "card_declined") {
      return jsonResp(402, { error: { code: "card_declined", decline_code: "generic_decline", message: "Your card was declined.", payment_intent: { id, status: "requires_payment_method" } } });
    }
    if (piBehavior === "hard_decline") {
      return jsonResp(402, { error: { code: "card_declined", decline_code: "stolen_card", message: "Card reported stolen.", payment_intent: { id, status: "requires_payment_method" } } });
    }
    return jsonResp(200, { id, status: "succeeded" });
  }
  if (/\/v1\/payment_intents\/[^/]+\/cancel$/.test(url)) {
    if (cancelBehavior === "fail") return jsonResp(400, { error: { message: "cannot cancel" } });
    return jsonResp(200, { id: url.split("/").slice(-2, -1)[0], status: "canceled" });
  }
  if (/\/v1\/payment_intents\/[^/]+$/.test(url) && method === "GET") {
    const id = url.split("/").pop() ?? "";
    return jsonResp(200, { id, status: piGetStatus });
  }
  if (url === "https://api.stripe.com/v1/customers" && method === "POST") {
    return jsonResp(200, { id: `cus_${Math.random().toString(36).slice(2, 8)}` });
  }
  if (url === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") {
    return jsonResp(200, { id: "cs_setup_1", url: "https://checkout.stripe.com/setup", setup_intent: "seti_setup_1" });
  }
  if (/\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(url)) {
    if (expireBehavior === "fail") return jsonResp(400, { error: { message: "session already completed" } });
    return jsonResp(200, { id: sessionCtx.sessionId, status: "expired" });
  }
  if (/\/v1\/checkout\/sessions\/[^/]+$/.test(url) && method === "GET") {
    if (sessionGetFail) return jsonResp(500, { error: { message: "stripe flaky" } });
    const status = sessionStatusQueue.length ? sessionStatusQueue.shift()! : sessionStatusDefault;
    return jsonResp(200, sessionFullBody(sessionCtx.sessionId, status, sessionCtx.payid, sessionCtx.iid, sessionCtx.amountTotal, sessionCtx.serviceOpen));
  }
  if (/\/v1\/payment_methods\/[^/]+\/detach$/.test(url)) {
    return jsonResp(200, {});
  }
  if (url === RESEND_URL && method === "POST") {
    const parsed = JSON.parse(body) as { to?: string; subject?: string };
    resendCalls.push({ to: parsed.to ?? "", subject: parsed.subject ?? "" });
    return jsonResp(200, { id: `email_${resendCalls.length}` });
  }
  return realFetch(input as never, init as never);
}) as typeof fetch;

function piPosts() {
  return calls.filter((c) => c.url === PI_URL && c.method === "POST").length;
}
function resetStub() {
  calls.length = 0;
  resendCalls.length = 0;
  piBehavior = "succeeded";
  sessionGetFail = false;
  sessionStatusDefault = "open";
  sessionStatusQueue = [];
  expireBehavior = "ok";
  cancelBehavior = "ok";
  piGetStatus = "succeeded";
  lastPiId = null;
  sessionCtx = { sessionId: "", payid: "", iid: "", amountTotal: 0, serviceOpen: 0 };
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const engine = await import("./autopay-charge");
  const webhook = await import("./autopay-webhook");
  const consentMod = await import("./autopay-consent");
  const stripeCheckout = await import("./stripe-checkout");
  const database = rawDb();
  const CURRENT_VERSION = consentMod.AUTOPAY_CONSENT_VERSION;

  // ---- seed helpers --------------------------------------------------------------------------
  function seedProjectClient(suffix: string, stage = "planning") {
    const pid = `proj-${suffix}`;
    const cid = `client-${suffix}`;
    database.prepare("INSERT INTO projects (id, name, type, stage, status, created_at, updated_at) VALUES (?, ?, 'wedding', ?, 'active', ?, ?)")
      .run(pid, `Wedding ${suffix}`, stage, NOW_ISO, NOW_ISO);
    database.prepare("INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at) VALUES (?, 'Robin', 'Reese', ?, ?, ?)")
      .run(cid, `robin+${suffix}@example.com`, NOW_ISO, NOW_ISO);
    database.prepare("INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at) VALUES (?, ?, ?, 'primary', 1, ?)")
      .run(`pp-${suffix}`, pid, cid, NOW_ISO);
    return { pid, cid };
  }
  function seedInvoice(suffix: string, pid: string, opts: { status?: string; totalCents: number; cardFeeAmountCents?: number; cardFeePolicy?: string } ) {
    const iid = `inv-${suffix}`;
    database.prepare(`INSERT INTO invoices (id, project_id, invoice_number, status, total_cents, amount_paid_cents, card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?)`)
      .run(iid, pid, `INV-${suffix}`, opts.status ?? "sent", opts.totalCents, opts.cardFeePolicy ?? "studio_absorbs", opts.cardFeeAmountCents ?? 0, NOW_ISO, NOW_ISO);
    return iid;
  }
  function seedPayment(suffix: string, iid: string, opts: { label?: string; amountCents: number; dueDate: string; status?: string; sessionId?: string | null; checkoutStatus?: string }) {
    const payid = `pay-${suffix}`;
    database.prepare(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents, external_payment_id, stripe_checkout_url, stripe_checkout_session_id, stripe_checkout_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, ?, ?, ?)`)
      .run(payid, iid, opts.label ?? "Second installment", opts.amountCents, opts.dueDate, opts.status ?? "pending",
        opts.sessionId ? "https://checkout.stripe.com/x" : null, opts.sessionId ?? null, opts.checkoutStatus ?? "not_created", NOW_ISO, NOW_ISO);
    return payid;
  }
  function seedConsent(suffix: string, pid: string, cid: string, opts: { status?: string; pm?: string | null; version?: string; setupIntentId?: string | null } = {}) {
    const id = `consent-${suffix}`;
    database.prepare(`INSERT INTO autopay_consents (id, project_id, client_id, stripe_customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, consent_version, consent_text_hash, status, setup_intent_id, consented_at, revoked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'visa', '4242', 12, 2030, ?, 'hash', ?, ?, ?, NULL, ?, ?)`)
      .run(id, pid, cid, `cus_${suffix}`, opts.pm === undefined ? `pm_${suffix}` : opts.pm, opts.version ?? CURRENT_VERSION, opts.status ?? "active", opts.setupIntentId ?? null, NOW_ISO, NOW_ISO, NOW_ISO);
    return id;
  }
  const chargeRow = (payid: string) => database.prepare("SELECT * FROM autopay_charges WHERE invoice_payment_id = ? AND dry_run = 0").get(payid) as Record<string, unknown> | undefined;
  const dryRow = (payid: string) => database.prepare("SELECT * FROM autopay_charges WHERE invoice_payment_id = ? AND dry_run = 1").get(payid) as Record<string, unknown> | undefined;
  const dryCount = (payid: string) => database.prepare("SELECT COUNT(*) FROM autopay_charges WHERE invoice_payment_id = ? AND dry_run = 1").pluck().get(payid) as number;
  const realCount = (payid: string) => database.prepare("SELECT COUNT(*) FROM autopay_charges WHERE invoice_payment_id = ? AND dry_run = 0").pluck().get(payid) as number;
  const paymentRow = (payid: string) => database.prepare("SELECT * FROM invoice_payments WHERE id = ?").get(payid) as Record<string, unknown>;
  const invoiceRow = (iid: string) => database.prepare("SELECT * FROM invoices WHERE id = ?").get(iid) as Record<string, unknown>;
  const projectRow = (pid: string) => database.prepare("SELECT * FROM projects WHERE id = ?").get(pid) as Record<string, unknown>;
  const consentRow = (id: string) => database.prepare("SELECT * FROM autopay_consents WHERE id = ?").get(id) as Record<string, unknown>;
  const activityCount = (action: string, needle: string) => database.prepare("SELECT COUNT(*) FROM activity_logs WHERE action = ? AND metadata LIKE ?").pluck().get(action, `%${needle}%`) as number;
  const activityByProject = (action: string, pid: string) => database.prepare("SELECT COUNT(*) FROM activity_logs WHERE action = ? AND project_id = ?").pluck().get(action, pid) as number;
  function isolate(pid: string) {
    database.prepare("UPDATE autopay_consents SET status = 'revoked' WHERE status = 'active' AND project_id != ?").run(pid);
  }
  function piSuccessEvent(chargeId: string, payid: string, iid: string, pidProj: string, serviceCents: number, feeCents: number, piId: string) {
    return {
      type: "payment_intent.succeeded",
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { id: piId, status: "succeeded", metadata: { autopay_charge_id: chargeId, invoice_payment_id: payid, invoice_id: iid, project_id: pidProj, service_amount_cents: String(serviceCents), client_fee_cents: String(feeCents) } } },
    } as Record<string, unknown>;
  }

  let passed = 0;
  const check = (label: string, cond: boolean) => {
    assert.ok(cond, label);
    passed += 1;
  };

  // ===========================================================================================
  // §10.1 test 3 — master dark no-op.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_ENABLED = ""; // OFF
    const s = seedProjectClient("dark");
    const iid = seedInvoice("dark", s.pid, { totalCents: 50000 });
    const payid = seedPayment("dark", iid, { amountCents: 50000, dueDate: "2026-06-01" });
    seedConsent("dark", s.pid, s.cid);
    const result = await engine.runDueAutopayCharges(NOW);
    check("test3: flag off → skipped flag_off", (result as { skipped?: string }).skipped === "flag_off");
    check("test3: flag off → zero api.stripe.com calls", calls.length === 0);
    check("test3: flag off → no charge row", !chargeRow(payid));
    await assert.rejects(engine.setupAutopayConsent(s.pid), /disabled/, "test3: setup route no-ops when dark");
    process.env.AUTOPAY_ENABLED = "1";
  }

  // ===========================================================================================
  // §10.4 test 14 — log_only mode: dry_run=1 row, WOULD charge, ZERO Stripe calls, unpaid.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "log_only";
    const s = seedProjectClient("logonly");
    const iid = seedInvoice("logonly", s.pid, { totalCents: 40000 });
    const payid = seedPayment("logonly", iid, { amountCents: 40000, dueDate: "2026-06-01" });
    seedConsent("logonly", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test14: log_only → zero PI POSTs", piPosts() === 0);
    check("test14: log_only → dry_run=1 row written", !!dryRow(payid) && dryRow(payid)!.status === "pending");
    check("test14: log_only → no real row", !chargeRow(payid));
    check("test14: log_only → installment stays unpaid", paymentRow(payid).status === "pending");
    check("test14: log_only → WOULD charge logged", activityCount("autopay.would_charge", payid) === 1);
    check("test14: log_only → zero client emails", resendCalls.length === 0);
  }

  // ===========================================================================================
  // §10.11 test 43 — dry-run rows are bounded (one upserted row over N ticks).
  // §10.10 test 34 — log_only then live flip: one dry_run=0 row, one charge, dry-run untouched.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "log_only";
    const s = seedProjectClient("bound");
    const iid = seedInvoice("bound", s.pid, { totalCents: 30000 });
    const payid = seedPayment("bound", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("bound", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    await engine.runDueAutopayCharges(NOW);
    await engine.runDueAutopayCharges(NOW);
    check("test43: N log_only ticks → exactly ONE dry_run=1 row", dryCount(payid) === 1);
    const dryUpdatedBefore = dryRow(payid)!.updated_at as string;

    // Flip to live — the partial index lets a fresh dry_run=0 row insert alongside the dry-run row.
    process.env.AUTOPAY_CHARGE_MODE = "live";
    await engine.runDueAutopayCharges(NOW);
    check("test34: live flip → exactly ONE real (dry_run=0) row", realCount(payid) === 1);
    check("test34: live flip → exactly ONE PI POST", piPosts() === 1);
    check("test34: live flip → dry-run row NOT promoted/claimed", dryCount(payid) === 1 && dryRow(payid)!.status === "pending");
    check("test43: dry-run row untouched by the live tick", dryRow(payid)!.updated_at === dryUpdatedBefore);
  }

  // ===========================================================================================
  // §10.4 test 15 — single happy path (live) + webhook records.
  // §10.7 test 28 — money-math parity handled in its own block below.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("happy", "proposal_sent");
    const iid = seedInvoice("happy", s.pid, { totalCents: 60000 });
    const payid = seedPayment("happy", iid, { label: "Retainer", amountCents: 60000, dueDate: "2026-06-01" });
    seedConsent("happy", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    const row = chargeRow(payid)!;
    check("test15: one PI POST", piPosts() === 1);
    check("test15: POST is off_session + confirm", calls.some((c) => c.url === PI_URL && /off_session=true/.test(c.body) && /confirm=true/.test(c.body)));
    check("test15: Idempotency-Key = chargeId:1", calls.find((c) => c.url === PI_URL)!.idempotencyKey === `${row.id}:1`);
    check("test15: POST amount = pinned", calls.find((c) => c.url === PI_URL)!.body.includes(`amount=60000`));
    check("test15: row → charging after POST (webhook is authoritative)", row.status === "charging");
    // webhook lands.
    const evt = piSuccessEvent(row.id as string, payid, iid, s.pid, 60000, 0, lastPiId!);
    await webhook.recordAutopayPaymentIntentSucceeded(evt);
    check("test15: webhook → installment paid", paymentRow(payid).status === "paid");
    check("test15: webhook → row charged", chargeRow(payid)!.status === "charged");
    check("test15: webhook → invoice recomputed paid", invoiceRow(iid).status === "paid");
    check("test15: webhook → stage advanced to retainer_paid", projectRow(s.pid).stage === "retainer_paid");
    check("test15: webhook → externalPaymentId set", paymentRow(payid).external_payment_id === lastPiId);
  }

  // ===========================================================================================
  // §10.4 test 16 — concurrent cron (two ticks): one real row, one PI POST; partial unique index.
  // §10.4 test 18 — key pinned once; a charging row is never re-POSTed.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("concur");
    const iid = seedInvoice("concur", s.pid, { totalCents: 45000 });
    const payid = seedPayment("concur", iid, { amountCents: 45000, dueDate: "2026-06-01" });
    seedConsent("concur", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW); // tick 1
    const row = chargeRow(payid)!;
    await engine.runDueAutopayCharges(NOW); // tick 2 — row is 'charging' (blocking) → no second POST
    check("test16: exactly one real row", realCount(payid) === 1);
    check("test16: exactly one PI POST across two ticks", piPosts() === 1);
    check("test18: idempotency_key pinned once = chargeId:1", row.idempotency_key === `${row.id}:1`);
    // A second dry_run=0 INSERT for the same installment is rejected by the partial UNIQUE index.
    let threw = false;
    try {
      database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, max_attempts, created_at, updated_at)
        VALUES ('dup-concur', ?, ?, ?, 'c', 'cus', 'pm', 1, 1, 0, 'pending', 0, 3, ?, ?)`).run(payid, iid, s.pid, NOW_ISO, NOW_ISO);
    } catch { threw = true; }
    check("test16: partial UNIQUE(invoice_payment_id) WHERE dry_run=0 blocks a second real row", threw);
  }

  // ===========================================================================================
  // §10.3 selection — tests 9,10,11,13.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    // test 9: future/null due → not selected.
    const s9 = seedProjectClient("sel-future");
    const i9 = seedInvoice("sel-future", s9.pid, { totalCents: 10000 });
    const p9future = seedPayment("sel-future-a", i9, { amountCents: 5000, dueDate: "2026-12-01" });
    const p9null = database.prepare(`INSERT INTO invoice_payments (id, invoice_id, label, amount_cents, due_date, status, paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents, stripe_checkout_status, created_at, updated_at) VALUES ('pay-sel-null', ?, 'x', 5000, NULL, 'pending', 0,0,0,0,0,'not_created', ?, ?)`).run(i9, NOW_ISO, NOW_ISO) && "pay-sel-null";
    seedConsent("sel-future", s9.pid, s9.cid);
    isolate(s9.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test9: future-due not selected", !chargeRow(p9future));
    check("test9: null-due not selected", !chargeRow(p9null));
    check("test9: zero PI POSTs for non-due", piPosts() === 0);

    // test 10: void/draft invoice + settled installment excluded.
    resetStub();
    const s10 = seedProjectClient("sel-void");
    const iv = seedInvoice("sel-void-a", s10.pid, { status: "void", totalCents: 10000 });
    const pv = seedPayment("sel-void-a", iv, { amountCents: 10000, dueDate: "2026-06-01" });
    const idr = seedInvoice("sel-void-b", s10.pid, { status: "draft", totalCents: 10000 });
    const pdr = seedPayment("sel-void-b", idr, { amountCents: 10000, dueDate: "2026-06-01" });
    seedConsent("sel-void", s10.pid, s10.cid);
    isolate(s10.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test10: void invoice excluded", !chargeRow(pv) && piPosts() === 0);
    check("test10: draft invoice excluded", !chargeRow(pdr));

    // test 11: no consent / no pm → excluded.
    resetStub();
    const s11 = seedProjectClient("sel-nopm");
    const i11 = seedInvoice("sel-nopm", s11.pid, { totalCents: 10000 });
    const p11 = seedPayment("sel-nopm", i11, { amountCents: 10000, dueDate: "2026-06-01" });
    seedConsent("sel-nopm", s11.pid, s11.cid, { pm: null }); // active but NO pm
    isolate(s11.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test11: active consent without pm → excluded", !chargeRow(p11) && piPosts() === 0);

    // test 8: stale consent version → excluded.
    resetStub();
    const s8 = seedProjectClient("sel-stale");
    const i8 = seedInvoice("sel-stale", s8.pid, { totalCents: 10000 });
    const p8 = seedPayment("sel-stale", i8, { amountCents: 10000, dueDate: "2026-06-01" });
    seedConsent("sel-stale", s8.pid, s8.cid, { version: "OLD-VERSION" });
    isolate(s8.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test8: stale consent_version → zero charges", !chargeRow(p8) && piPosts() === 0);

    // test 13: pilot allowlist.
    resetStub();
    const sA = seedProjectClient("pilot-a");
    const iA = seedInvoice("pilot-a", sA.pid, { totalCents: 10000 });
    const pA = seedPayment("pilot-a", iA, { amountCents: 10000, dueDate: "2026-06-01" });
    seedConsent("pilot-a", sA.pid, sA.cid);
    const sB = seedProjectClient("pilot-b");
    const iB = seedInvoice("pilot-b", sB.pid, { totalCents: 10000 });
    const pB = seedPayment("pilot-b", iB, { amountCents: 10000, dueDate: "2026-06-01" });
    seedConsent("pilot-b", sB.pid, sB.cid);
    database.prepare("UPDATE autopay_consents SET status='revoked' WHERE status='active' AND project_id NOT IN (?, ?)").run(sA.pid, sB.pid);
    process.env.AUTOPAY_PILOT_ALLOWLIST = sA.pid;
    await engine.runDueAutopayCharges(NOW);
    check("test13: allowlisted project charged", !!chargeRow(pA));
    check("test13: non-allowlisted project NOT charged", !chargeRow(pB));
    delete process.env.AUTOPAY_PILOT_ALLOWLIST;
  }

  // ===========================================================================================
  // §10.3 test 12 + §10.10 test 37 — cap + skipped_capped + cap raised.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    process.env.AUTOPAY_MAX_CHARGE_CENTS = "100000";
    const s = seedProjectClient("cap");
    const iid = seedInvoice("cap", s.pid, { totalCents: 200000 });
    const payid = seedPayment("cap", iid, { amountCents: 150000, dueDate: "2026-06-01" }); // over cap
    seedConsent("cap", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test12: over-cap → skipped_capped row", chargeRow(payid)!.status === "skipped_capped");
    check("test12: over-cap → zero PI POSTs", piPosts() === 0);
    check("test37: alert fired once on transition", activityCount("autopay.skipped_capped", payid) === 1);
    // re-tick, same cap → silent re-skip (no second alert, no state churn).
    await engine.runDueAutopayCharges(NOW);
    check("test37: re-skip silent (no second alert)", activityCount("autopay.skipped_capped", payid) === 1);
    check("test37: still skipped_capped, zero charge", chargeRow(payid)!.status === "skipped_capped" && piPosts() === 0);
    // raise the cap → next tick charges exactly once.
    process.env.AUTOPAY_MAX_CHARGE_CENTS = "200000";
    await engine.runDueAutopayCharges(NOW);
    check("test37: cap raised → charged exactly once", piPosts() === 1 && chargeRow(payid)!.status === "charging");
    delete process.env.AUTOPAY_MAX_CHARGE_CENTS;
  }

  // ===========================================================================================
  // §10.5 test 21 — provable decline → failed_retryable + backoff; retry with NEW key.
  // §10.5 test 22 — at the cap → failed_terminal + manual link.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    process.env.AUTOPAY_MAX_ATTEMPTS = "2";
    const s = seedProjectClient("decline");
    const iid = seedInvoice("decline", s.pid, { totalCents: 30000 });
    const payid = seedPayment("decline", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("decline", s.pid, s.cid);
    isolate(s.pid);
    piBehavior = "card_declined";
    await engine.runDueAutopayCharges(NOW);
    let row = chargeRow(payid)!;
    check("test21: decline → failed_retryable", row.status === "failed_retryable");
    check("test21: next_attempt_at set", !!row.next_attempt_at);
    check("test21: one PI POST", piPosts() === 1);
    // a tick BEFORE next_attempt_at does NOT retry.
    await engine.runDueAutopayCharges(NOW);
    check("test21: pre-backoff tick does NOT retry", piPosts() === 1);
    // a tick AFTER next_attempt_at retries with a NEW key (attempt 2). At attempt cap (2) → terminal.
    const later = new Date(new Date(row.next_attempt_at as string).getTime() + 60_000);
    piBehavior = "card_declined";
    await engine.runDueAutopayCharges(later);
    row = chargeRow(payid)!;
    check("test21: post-backoff retry uses a second PI POST", piPosts() === 2);
    check("test21: retry key = chargeId:2", calls.filter((c) => c.url === PI_URL)[1].idempotencyKey === `${row.id}:2`);
    check("test22: at attempt cap → failed_terminal", row.status === "failed_terminal");
    check("test22: manual fallback minted a checkout link", paymentRow(payid).stripe_checkout_status === "link_ready");
    check("test22: Tyler alerted (manual_fallback logged)", activityCount("autopay.manual_fallback", payid) === 1);
    delete process.env.AUTOPAY_MAX_ATTEMPTS;
  }

  // ===========================================================================================
  // §10.5 test 23 — authentication_required (SCA) → needs_action immediately, manual link, no retry.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("sca");
    const iid = seedInvoice("sca", s.pid, { totalCents: 30000 });
    const payid = seedPayment("sca", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("sca", s.pid, s.cid);
    isolate(s.pid);
    piBehavior = "requires_action";
    await engine.runDueAutopayCharges(NOW);
    check("test23: SCA → needs_action immediately", chargeRow(payid)!.status === "needs_action");
    check("test23: manual on-session link surfaced", paymentRow(payid).stripe_checkout_status === "link_ready");
    check("test23: one PI POST (no off-session retry)", piPosts() === 1);
    // a later tick must NOT re-POST (needs_action is blocking).
    await engine.runDueAutopayCharges(NOW);
    check("test23: needs_action is blocking → zero off-session re-POST", piPosts() === 1);
  }

  // ===========================================================================================
  // §10.5 test 24 + §10.4 test 17 — ambiguous network throw → charging (terminal-unknown), no retry,
  // reconcile tripwire after ~1h; a later payment_intent.succeeded self-heals.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("ambig");
    const iid = seedInvoice("ambig", s.pid, { totalCents: 30000 });
    const payid = seedPayment("ambig", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("ambig", s.pid, s.cid);
    isolate(s.pid);
    piBehavior = "network";
    await engine.runDueAutopayCharges(NOW);
    const row = chargeRow(payid)!;
    check("test24: ambiguous throw → row left charging", row.status === "charging");
    piBehavior = "succeeded";
    await engine.runDueAutopayCharges(NOW);
    check("test17: a charging row is NEVER re-POSTed", piPosts() === 1);
    // reconcile tripwire after ~1h.
    const recon = await engine.getAutopayChargeReconciliation({ now: new Date(NOW.getTime() + 2 * 3600_000) });
    check("test17: stuck 'charging' surfaced as reconcile signal", recon.stuckCharging.some((r) => r.chargeId === row.id));
    // self-heal: a later payment_intent.succeeded converges to charged + records.
    const evt = piSuccessEvent(row.id as string, payid, iid, s.pid, 30000, 0, "pi_selfheal");
    await webhook.recordAutopayPaymentIntentSucceeded(evt);
    check("test24: webhook self-heals → charged + recorded", chargeRow(payid)!.status === "charged" && paymentRow(payid).status === "paid");
  }

  // ===========================================================================================
  // §10.4 test 20 — replayed payment_intent.succeeded → idempotent no-op.
  // §10.4 test 19 — double-record backstop (same pi against a second installment).
  // §10.10 test 31(iii) — different pi on an already-paid installment → CRITICAL + refund candidate.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("replay");
    const iid = seedInvoice("replay", s.pid, { totalCents: 80000 });
    const payid = seedPayment("replay", iid, { amountCents: 40000, dueDate: "2026-06-01" });
    const payid2 = seedPayment("replay-2", iid, { label: "Third", amountCents: 40000, dueDate: "2026-06-02" });
    seedConsent("replay", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    const row = chargeRow(payid)!;
    const piId = lastPiId!;
    const evt = piSuccessEvent(row.id as string, payid, iid, s.pid, 40000, 0, piId);
    await webhook.recordAutopayPaymentIntentSucceeded(evt);
    const paidAtFirst = paymentRow(payid).paid_at;
    // replay same event → no-op.
    await webhook.recordAutopayPaymentIntentSucceeded(evt);
    check("test20: replay same pi → idempotent no-op", paymentRow(payid).paid_at === paidAtFirst);

    // test 19: same pi against a SECOND installment → rejected by unique external id.
    const row2 = chargeRow(payid2)!; // charged too (second installment)
    const evt2SamePi = piSuccessEvent(row2.id as string, payid2, iid, s.pid, 40000, 0, piId); // reuse piId
    await assert.rejects(
      webhook.recordAutopayInstallmentPaid({ ...(row2 as never), invoicePaymentId: payid2, serviceAmountCents: 40000, clientFeeCents: 0, amountCents: 40000, projectId: s.pid, consentId: `consent-replay` } as never, { id: piId, metadata: {} }),
      /already linked/,
      "test19: same pi on a second installment → double-record backstop throws",
    );
    void evt2SamePi;

    // test 31(iii): a DIFFERENT pi for the already-paid installment → CRITICAL + refund candidate.
    const evtDiff = piSuccessEvent(row.id as string, payid, iid, s.pid, 40000, 0, "pi_DIFFERENT");
    const res = await webhook.recordAutopayPaymentIntentSucceeded(evtDiff) as { doubleCharge?: boolean };
    check("test31iii: different pi on paid installment → double charge flagged", res.doubleCharge === true);
    check("test31iii: refund_candidate_pi set on the row", chargeRow(payid)!.refund_candidate_pi === "pi_DIFFERENT");
    check("test31iii: double_charge_detected logged (CRITICAL)", activityCount("autopay.double_charge_detected", row.id as string) === 1);
  }

  // ===========================================================================================
  // §10.10 test 32 — post-claim ineligibility before POST (void / manual-paid / revoke) → aborted.
  // §10.11 test 40 — amount drift after claim → abort, then correct re-charge (R-2 + R-4).
  // ===========================================================================================
  {
    // Consent revoked after claim (simulate via a mid-run revoke is hard; instead seed a state where
    // §6.2a fails). We drive processInstallment through runDue but flip eligibility BEFORE the POST by
    // using amount drift, which the engine re-reads post-claim.
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("drift");
    const iid = seedInvoice("drift", s.pid, { totalCents: 50000 });
    const payid = seedPayment("drift", iid, { amountCents: 50000, dueDate: "2026-06-01" });
    seedConsent("drift", s.pid, s.cid);
    isolate(s.pid);
    // R-2 is a concurrent-edit TOCTOU (the claim re-pins to the fresh value, so a single-threaded run
    // never drifts). Unit-test §6.2a's guard directly: a charge row pinned to a STALE (higher) amount
    // than the installment's live payable is REJECTED as amount_drift (an overcharge waiting to happen).
    const stalePinnedRow = { id: "drift-charge", invoicePaymentId: payid, invoiceId: iid, projectId: s.pid, consentId: "consent-drift", amountCents: 99999, serviceAmountCents: 99999, clientFeeCents: 0 } as never;
    const recheck = await engine.recheckEligibility(stalePinnedRow);
    check("test40/R-2: §6.2a rejects a pinned amount that drifted from the live payable", recheck.ok === false && recheck.reason === "amount_drift");
    // R-4: an aborted_ineligible(amount_drift) row is re-claimable — the next tick re-pins the fresh
    // correct amount and charges exactly once.
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, abort_reason, created_at, updated_at)
      VALUES ('drift-charge', ?, ?, ?, 'consent-drift', 'cus_drift', 'pm_drift', 99999, 99999, 0, 'aborted_ineligible', 0, 1, 3, 'amount_drift', ?, ?)`).run(payid, iid, s.pid, NOW_ISO, NOW_ISO);
    await engine.runDueAutopayCharges(NOW);
    check("test40/R-4: aborted_ineligible re-claimed with fresh pin → one charge at corrected amount", piPosts() === 1 && chargeRow(payid)!.status === "charging" && chargeRow(payid)!.amount_cents === 50000);

    // test 32: void invoice AFTER a claim → aborted; and it stays blocked forever (R-4 counter-case).
    resetStub();
    const s2 = seedProjectClient("void-after");
    const iid2 = seedInvoice("void-after", s2.pid, { totalCents: 50000 });
    const payid2 = seedPayment("void-after", iid2, { amountCents: 50000, dueDate: "2026-06-01" });
    seedConsent("void-after", s2.pid, s2.cid);
    isolate(s2.pid);
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, created_at, updated_at)
      VALUES ('void-charge', ?, ?, ?, 'consent-void-after', 'cus', 'pm', 50000, 50000, 0, 'pending', 0, 0, 3, ?, ?)`).run(payid2, iid2, s2.pid, NOW_ISO, NOW_ISO);
    database.prepare("UPDATE invoices SET status='void' WHERE id=?").run(iid2);
    await engine.runDueAutopayCharges(NOW);
    check("test32: void-after-claim → zero POST (row not claimable: invoice not collectible)", piPosts() === 0);
    check("test41 counter-case: void invoice never re-qualifies", chargeRow(payid2)!.status === "pending");
  }

  // ===========================================================================================
  // §10.11 test 41 — aborted_ineligible re-claimable after cure (revoke → re-consent).
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("cure");
    const iid = seedInvoice("cure", s.pid, { totalCents: 50000 });
    const payid = seedPayment("cure", iid, { amountCents: 50000, dueDate: "2026-06-01" });
    // Start with a REVOKED consent + an aborted_ineligible row (consent_revoked).
    seedConsent("cure", s.pid, s.cid, { status: "revoked" });
    isolate(s.pid);
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, abort_reason, created_at, updated_at)
      VALUES ('cure-charge', ?, ?, ?, 'consent-cure', 'cus', 'pm_cure', 50000, 50000, 0, 'aborted_ineligible', 0, 1, 3, 'consent_inactive', ?, ?)`).run(payid, iid, s.pid, NOW_ISO, NOW_ISO);
    await engine.runDueAutopayCharges(NOW);
    check("test41: revoked consent → aborted row NOT re-charged", piPosts() === 0 && chargeRow(payid)!.status === "aborted_ineligible");
    // Client re-consents (fresh active row, current version).
    seedConsent("cure2", s.pid, s.cid, { pm: "pm_cure2" });
    database.prepare("UPDATE autopay_consents SET status='revoked' WHERE status='active' AND project_id != ?").run(s.pid);
    await engine.runDueAutopayCharges(NOW);
    check("test41: after re-consent → aborted_ineligible re-claimed, charged once", piPosts() === 1 && chargeRow(payid)!.status === "charging");
  }

  // ===========================================================================================
  // §10.10 test 31(i/ii) + §10.11 tests 38/39 — cross-channel resolution (§6.2b).
  // ===========================================================================================
  {
    // 31(i): manual paid first (session complete) → abort + settle, ZERO PI POST.
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("xchan-complete");
    const iid = seedInvoice("xchan-complete", s.pid, { totalCents: 40000 });
    const payid = seedPayment("xchan-complete", iid, { amountCents: 40000, dueDate: "2026-06-01", sessionId: "cs_complete", checkoutStatus: "link_ready" });
    seedConsent("xchan-complete", s.pid, s.cid);
    isolate(s.pid);
    sessionCtx = { sessionId: "cs_complete", payid, iid, amountTotal: 40000, serviceOpen: 40000 };
    sessionStatusDefault = "complete";
    await engine.runDueAutopayCharges(NOW);
    check("test31i: session complete → ZERO PI POST", piPosts() === 0);
    check("test31i: row → aborted_ineligible(session_complete)", chargeRow(payid)!.status === "aborted_ineligible" && chargeRow(payid)!.abort_reason === "session_complete");
    check("test31i: manual payment recorded via settle", paymentRow(payid).status === "paid");

    // 31(ii): open hosted tab → expire FIRST, then POST (assert order).
    resetStub();
    const s2 = seedProjectClient("xchan-open");
    const i2 = seedInvoice("xchan-open", s2.pid, { totalCents: 40000 });
    const p2 = seedPayment("xchan-open", i2, { amountCents: 40000, dueDate: "2026-06-01", sessionId: "cs_open", checkoutStatus: "link_ready" });
    seedConsent("xchan-open", s2.pid, s2.cid);
    isolate(s2.pid);
    sessionCtx = { sessionId: "cs_open", payid: p2, iid: i2, amountTotal: 40000, serviceOpen: 40000 };
    sessionStatusDefault = "open";
    expireBehavior = "ok";
    await engine.runDueAutopayCharges(NOW);
    const expireIdx = calls.findIndex((c) => /\/expire$/.test(c.url));
    const postIdx = calls.findIndex((c) => c.url === PI_URL && c.method === "POST");
    check("test31ii: expire called before the PI POST", expireIdx >= 0 && postIdx >= 0 && expireIdx < postIdx);
    check("test31ii: one PI POST after expire", piPosts() === 1);

    // test 38: session read FAILS → FAIL CLOSED (no POST, row back to pending), then succeeds next tick.
    resetStub();
    const s3 = seedProjectClient("xchan-nullread");
    const i3 = seedInvoice("xchan-nullread", s3.pid, { totalCents: 40000 });
    const p3 = seedPayment("xchan-nullread", i3, { amountCents: 40000, dueDate: "2026-06-01", sessionId: "cs_flaky", checkoutStatus: "link_ready" });
    seedConsent("xchan-nullread", s3.pid, s3.cid);
    isolate(s3.pid);
    sessionCtx = { sessionId: "cs_flaky", payid: p3, iid: i3, amountTotal: 40000, serviceOpen: 40000 };
    sessionGetFail = true;
    await engine.runDueAutopayCharges(NOW);
    check("test38: session read fails → ZERO PI POST (fail closed)", piPosts() === 0);
    check("test38: row released back to pending", chargeRow(p3)!.status === "pending");
    // Build caution (a): a zero-charge §6.2b deferral must NOT burn the retry budget — attempt_count
    // is decremented back and the idempotency key cleared (re-derived on re-claim).
    check("test-cautionA: deferral decrements attempt_count (no burned attempt)", chargeRow(p3)!.attempt_count === 0 && chargeRow(p3)!.idempotency_key === null);
    sessionGetFail = false;
    sessionStatusDefault = "expired";
    await engine.runDueAutopayCharges(NOW);
    check("test38: next tick (read succeeds, expired session) → charges once", piPosts() === 1);

    // test 39: expire rejected because the session completed in the window → re-GET complete → abort+settle.
    resetStub();
    const s4 = seedProjectClient("xchan-expfail");
    const i4 = seedInvoice("xchan-expfail", s4.pid, { totalCents: 40000 });
    const p4 = seedPayment("xchan-expfail", i4, { amountCents: 40000, dueDate: "2026-06-01", sessionId: "cs_expfail", checkoutStatus: "link_ready" });
    seedConsent("xchan-expfail", s4.pid, s4.cid);
    isolate(s4.pid);
    sessionCtx = { sessionId: "cs_expfail", payid: p4, iid: i4, amountTotal: 40000, serviceOpen: 40000 };
    sessionStatusQueue = ["open", "complete"]; // first GET open, re-GET complete
    expireBehavior = "fail";
    await engine.runDueAutopayCharges(NOW);
    check("test39: expire fail → re-GET complete → ZERO PI POST + abort", piPosts() === 0 && chargeRow(p4)!.status === "aborted_ineligible");
  }

  // ===========================================================================================
  // §10.11 test 42 — cancel-rejected-because-succeeded → converge to charged, never mint a link.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("r5");
    const iid = seedInvoice("r5", s.pid, { totalCents: 30000 });
    const payid = seedPayment("r5", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("r5", s.pid, s.cid);
    isolate(s.pid);
    piBehavior = "requires_action"; // SCA → fallback path runs cancel
    cancelBehavior = "fail"; // cancel rejected...
    piGetStatus = "succeeded"; // ...because the PI actually SUCCEEDED (slow-confirm race)
    await engine.runDueAutopayCharges(NOW);
    check("test42: cancel-rejected-succeeded → row converged to charged", chargeRow(payid)!.status === "charged");
    check("test42: NO manual link minted on top of a succeeded charge", paymentRow(payid).stripe_checkout_status !== "link_ready");
    check("test42: installment recorded paid via the settle recorder", paymentRow(payid).status === "paid");
  }

  // ===========================================================================================
  // §10.2 consent — tests 4, 5, 6, 7 + §10.10 test 35 (re-consent M6).
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "log_only";
    const s = seedProjectClient("consent");
    // test 4: setup → one customer, one setup session, one pending consent, current version + hash, no card data.
    const setup = await engine.setupAutopayConsent(s.pid);
    check("test4: setup returns a hosted setup url", setup.url.includes("checkout.stripe.com"));
    const pending = database.prepare("SELECT * FROM autopay_consents WHERE project_id=? AND status='pending'").get(s.pid) as Record<string, unknown>;
    check("test4: pending consent with current version + hash", pending.consent_version === CURRENT_VERSION && !!pending.consent_text_hash);
    check("test4: no PAN/CVC column exists on the consent row", !("card_number" in pending) && !("cvc" in pending));
    check("test4: exactly one customer created", calls.filter((c) => c.url === "https://api.stripe.com/v1/customers").length === 1);

    // test 5: setup_intent.succeeded → active + pm + last4/brand only + audit.
    const setupIntentEvt = {
      type: "setup_intent.succeeded",
      data: { object: { id: pending.setup_intent_id, metadata: { consent_id: pending.id, project_id: s.pid }, payment_method: { id: "pm_new", card: { brand: "visa", last4: "4242", exp_month: 11, exp_year: 2031 } } } },
    } as Record<string, unknown>;
    await webhook.recordAutopaySetupIntentSucceeded(setupIntentEvt);
    const active = consentRow(pending.id as string);
    check("test5: consent flips to active", active.status === "active");
    check("test5: stores pm + last4/brand only", active.stripe_payment_method_id === "pm_new" && active.card_last4 === "4242" && active.card_brand === "visa");
    check("test5: consent_granted logged", activityCount("autopay.consent_granted", pending.id as string) === 1);

    // test 35 (M6): a SECOND setup_intent.succeeded for a project with an active consent → supersede + activate.
    const setup2 = await engine.setupAutopayConsent(s.pid);
    void setup2;
    const pending2 = database.prepare("SELECT * FROM autopay_consents WHERE project_id=? AND status='pending'").get(s.pid) as Record<string, unknown>;
    const evt2 = {
      type: "setup_intent.succeeded",
      data: { object: { id: pending2.setup_intent_id, metadata: { consent_id: pending2.id, project_id: s.pid }, payment_method: { id: "pm_updated", card: { brand: "amex", last4: "0005" } } } },
    } as Record<string, unknown>;
    await webhook.recordAutopaySetupIntentSucceeded(evt2);
    const activeRows = database.prepare("SELECT COUNT(*) FROM autopay_consents WHERE project_id=? AND status='active'").pluck().get(s.pid) as number;
    check("test35: re-consent → exactly one active consent (unique index never throws)", activeRows === 1);
    check("test35: the NEW card is the active one", (consentRow(pending2.id as string)).status === "active" && (consentRow(pending.id as string)).status === "revoked");

    // test 7: revoke → CAS active→revoked + best-effort detach + audit; engine skips next tick.
    resetStub();
    const rev = await engine.revokeAutopayConsent(s.pid);
    check("test7: revoke flips exactly one active→revoked", rev.revoked === 1);
    check("test7: best-effort detach called", calls.some((c) => /\/payment_methods\/[^/]+\/detach$/.test(c.url)));
    check("test7: consent_revoked logged", activityByProject("autopay.consent_revoked", s.pid) >= 1);
    const activeAfter = database.prepare("SELECT COUNT(*) FROM autopay_consents WHERE project_id=? AND status='active'").pluck().get(s.pid) as number;
    check("test7: zero active consents after revoke", activeAfter === 0);

    // test 6 (IDOR): setup/revoke derive project ONLY from the passed project id (token), never a body.
    // The server functions take projectId (resolved from the token by the route) — a body id is never read.
    check("test6: setup/revoke are project-scoped by argument (no body-sourced id)", engine.setupAutopayConsent.length === 1 && engine.revokeAutopayConsent.length === 1);
  }

  // ===========================================================================================
  // §10.5 test 5 (setup_failed) + §10.9 test 30 — reconciliation tripwires.
  // ===========================================================================================
  {
    resetStub();
    const s = seedProjectClient("recon");
    // pending consent with a seti_ older than ~1h → WARN.
    database.prepare(`INSERT INTO autopay_consents (id, project_id, client_id, stripe_customer_id, consent_version, status, setup_intent_id, created_at, updated_at) VALUES ('recon-consent', ?, ?, 'cus', ?, 'pending', 'seti_stuck', ?, ?)`)
      .run(s.pid, s.cid, CURRENT_VERSION, NOW_ISO, NOW_ISO);
    const recon = await engine.getAutopayChargeReconciliation({ now: new Date(NOW.getTime() + 2 * 3600_000) });
    check("test30: pending consent with seti > 1h → WARN signal", recon.consentStuckPending.some((r) => r.consentId === "recon-consent"));
    const reconFresh = await engine.getAutopayChargeReconciliation({ now: NOW });
    check("test30: a fresh pending consent → no signal", !reconFresh.consentStuckPending.some((r) => r.consentId === "recon-consent"));

    // setup_intent.setup_failed → consent failed.
    const failEvt = { type: "setup_intent.setup_failed", data: { object: { id: "seti_stuck", metadata: { consent_id: "recon-consent" } } } } as Record<string, unknown>;
    await webhook.recordAutopaySetupIntentFailed(failEvt);
    check("test5: setup_failed → consent status failed", consentRow("recon-consent").status === "failed");
  }

  // ===========================================================================================
  // §10.6 test 25/26/33 + §10.10 test 36 (out-of-order) — webhook security + convergence.
  // ===========================================================================================
  {
    // test 33: a non-autopay payment_intent.succeeded (no autopay_charge_id) → IGNORED (no write, no failure).
    resetStub();
    const nonAutopayEvt = { type: "payment_intent.succeeded", data: { object: { id: "pi_manual_xyz", metadata: {} } } } as Record<string, unknown>;
    const dispatch = await import("./autopay-webhook");
    const res33 = await dispatch.dispatchAutopayWebhookEvent(nonAutopayEvt, "payment_intent.succeeded");
    check("test33: non-autopay PI → ignored (not_autopay), no throw", !!res33 && (res33 as { reason?: string }).reason === "not_autopay");

    // test 25: a bad-signature autopay event is rejected pre-verification (StripeWebhookSignatureError).
    await assert.rejects(
      stripeCheckout.handleStripeCheckoutWebhook(JSON.stringify({ type: "payment_intent.succeeded" }), "t=1,v1=bad"),
      (err: unknown) => err instanceof Error && err.name === "StripeWebhookSignatureError",
      "test25: bad-signature autopay event → signature reject (carve-out preserved)",
    );

    // A verified autopay event rides the existing route + dispatch.
    const s = seedProjectClient("verified");
    const iid = seedInvoice("verified", s.pid, { totalCents: 30000 });
    const payid = seedPayment("verified", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("verified", s.pid, s.cid);
    isolate(s.pid);
    process.env.AUTOPAY_CHARGE_MODE = "live";
    await engine.runDueAutopayCharges(NOW);
    const row = chargeRow(payid)!;
    const evtBody = JSON.stringify(piSuccessEvent(row.id as string, payid, iid, s.pid, 30000, 0, lastPiId!));
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${evtBody}`).digest("hex");
    await stripeCheckout.handleStripeCheckoutWebhook(evtBody, `t=${ts},v1=${sig}`);
    check("test26/happy: a verified autopay PI event routes + records", chargeRow(payid)!.status === "charged" && paymentRow(payid).status === "paid");

    // test 36: a late payment_failed for a SUPERSEDED pi vs a charged row → no-op (PI-guarded CAS).
    const lateFail = { type: "payment_intent.payment_failed", data: { object: { id: "pi_SUPERSEDED", status: "requires_payment_method", metadata: { autopay_charge_id: row.id }, last_payment_error: { code: "card_declined", decline_code: "generic_decline" } } } } as Record<string, unknown>;
    await webhook.recordAutopayPaymentIntentFailed(lateFail);
    check("test36: late payment_failed for a superseded pi → charged row untouched (0 rows)", chargeRow(payid)!.status === "charged");
  }

  // ===========================================================================================
  // §10.7 test 28 — money-math parity: autopay vs the manual checkout settle → identical ledger.
  // §10.8 test 29 — email gating at the helper layer.
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    // Autopay side (client_pays fee to exercise the split).
    const sa = seedProjectClient("parity-auto", "proposal_sent");
    const ia = seedInvoice("parity-auto", sa.pid, { totalCents: 20000, cardFeeAmountCents: 600, cardFeePolicy: "client_pays" });
    const pa = seedPayment("parity-auto", ia, { label: "Retainer", amountCents: 20000, dueDate: "2026-06-01" });
    seedConsent("parity-auto", sa.pid, sa.cid);
    isolate(sa.pid);
    await engine.runDueAutopayCharges(NOW);
    const rowA = chargeRow(pa)!;
    await webhook.recordAutopayPaymentIntentSucceeded(piSuccessEvent(rowA.id as string, pa, ia, sa.pid, 20000, 600, lastPiId!));
    const autoPay = paymentRow(pa);

    // Manual side — identical installment settled via the existing checkout settle.
    const sm = seedProjectClient("parity-man", "proposal_sent");
    const im = seedInvoice("parity-man", sm.pid, { totalCents: 20000, cardFeeAmountCents: 600, cardFeePolicy: "client_pays" });
    const pm = seedPayment("parity-man", im, { label: "Retainer", amountCents: 20000, dueDate: "2026-06-01" });
    const manualSession = { id: "cs_manual_parity", status: "complete", payment_status: "paid", amount_total: 20600, url: "https://x", payment_intent: "pi_manual_parity", metadata: { payment_id: pm, invoice_id: im, service_open_cents: "20000" } };
    await stripeCheckout.settleInvoicePaymentCheckoutSession(manualSession);
    const manPay = paymentRow(pm);

    for (const col of ["paid_amount_cents", "client_fee_cents", "processing_fee_cents", "gross_collected_cents", "net_deposit_cents"]) {
      check(`test28: ${col} byte-identical (autopay == manual settle)`, autoPay[col] === manPay[col]);
    }
    check("test28: both invoices recompute identically", invoiceRow(ia).amount_paid_cents === invoiceRow(im).amount_paid_cents);
    check("test28: both advance stage identically", projectRow(sa.pid).stage === projectRow(sm.pid).stage);

    // test 29: email gating at the helper layer.
    const emails = await import("./autopay-emails");
    // (a) EMAIL_SENDING_ENABLED off → helper short-circuits (gated), zero resend calls.
    delete process.env.EMAIL_SENDING_ENABLED;
    resendCalls.length = 0;
    const gatedOff = await emails.sendAutopayReceipt({ toEmail: "x@example.com", projectName: "P", installmentLabel: "L", amountCents: 100, chargedOnDate: "2026-07-08", cardBrand: "visa", cardLast4: "4242", balanceRemainingCents: 0 });
    check("test29a: EMAIL_SENDING off → helper returns gated, ZERO resend calls", gatedOff.ok === false && gatedOff.reason === "gated" && resendCalls.length === 0);
    // (b) log_only → zero emails even with EMAIL_SENDING on.
    process.env.EMAIL_SENDING_ENABLED = "1";
    process.env.RESEND_API_KEY = "re_test";
    process.env.UNSUBSCRIBE_SECRET = "unsub_secret";
    process.env.AUTOPAY_CHARGE_MODE = "log_only";
    resendCalls.length = 0;
    const gatedLog = await emails.sendAutopayReceipt({ toEmail: "x@example.com", projectName: "P", installmentLabel: "L", amountCents: 100, chargedOnDate: "2026-07-08", cardBrand: "visa", cardLast4: "4242", balanceRemainingCents: 0 });
    check("test29b: log_only → zero emails even with EMAIL_SENDING on", gatedLog.ok === false && resendCalls.length === 0);
    // (c) live + EMAIL_SENDING on → receipt sends; suppressed recipient → no send.
    process.env.AUTOPAY_CHARGE_MODE = "live";
    resendCalls.length = 0;
    const sent = await emails.sendAutopayReceipt({ toEmail: "receipt@example.com", projectName: "P", installmentLabel: "L", amountCents: 100, chargedOnDate: "2026-07-08", cardBrand: "visa", cardLast4: "4242", balanceRemainingCents: 0 });
    check("test29c: live + EMAIL_SENDING on → receipt sent", sent.ok === true && resendCalls.length === 1);
    database.prepare("INSERT INTO email_suppressions (email, suppressed_at, source) VALUES ('suppressed@example.com', ?, 'unsubscribe')").run(NOW_ISO);
    resendCalls.length = 0;
    const suppressed = await emails.sendAutopayReceipt({ toEmail: "suppressed@example.com", projectName: "P", installmentLabel: "L", amountCents: 100, chargedOnDate: "2026-07-08", cardBrand: "visa", cardLast4: "4242", balanceRemainingCents: 0 });
    check("test29c: suppressed recipient → no send", suppressed.ok === false && resendCalls.length === 0);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_SENDING_ENABLED;
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MAJOR-1: hard-cap bypass on the aborted_ineligible re-claim path.
  // An over-cap re-qualified aborted_ineligible row must NOT be re-claimed over the ceiling — it
  // routes to skipped_capped (ONE alert), then charges once after the cap is raised (§5.1 rule 7).
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    process.env.AUTOPAY_MAX_CHARGE_CENTS = "100000";
    const s = seedProjectClient("m1cap");
    const iid = seedInvoice("m1cap", s.pid, { totalCents: 200000 });
    const payid = seedPayment("m1cap", iid, { amountCents: 150000, dueDate: "2026-06-01" }); // over cap
    seedConsent("m1cap", s.pid, s.cid);
    isolate(s.pid);
    // A re-qualifiable aborted_ineligible row (an earlier amount_drift abort). On this tick §5.1
    // re-selects the installment; the fresh payable (150000) is OVER cap.
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, abort_reason, created_at, updated_at)
      VALUES ('m1cap-charge', ?, ?, ?, 'consent-m1cap', 'cus', 'pm_m1cap', 150000, 150000, 0, 'aborted_ineligible', 0, 1, 3, 'amount_drift', ?, ?)`).run(payid, iid, s.pid, NOW_ISO, NOW_ISO);
    await engine.runDueAutopayCharges(NOW);
    check("major1: over-cap aborted_ineligible NOT re-claimed → zero PI POST", piPosts() === 0);
    check("major1: over-cap aborted_ineligible → skipped_capped", chargeRow(payid)!.status === "skipped_capped");
    check("major1: skipped_capped alert fired once on transition", activityCount("autopay.skipped_capped", payid) === 1);
    await engine.runDueAutopayCharges(NOW); // still over cap → silent re-skip
    check("major1: re-skip silent (no second alert), still zero charge", activityCount("autopay.skipped_capped", payid) === 1 && piPosts() === 0);
    process.env.AUTOPAY_MAX_CHARGE_CENTS = "200000"; // raise the cap
    await engine.runDueAutopayCharges(NOW);
    check("major1: cap raised → charged exactly once at the pinned amount", piPosts() === 1 && chargeRow(payid)!.status === "charging" && chargeRow(payid)!.amount_cents === 150000);
    delete process.env.AUTOPAY_MAX_CHARGE_CENTS;
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MEDIUM-2: the Layer-2 CAS carries in-statement retry-pacing guards, so a
  // STALE pre-read can't claim a row another tick meanwhile carried to failed_retryable with a future
  // next_attempt_at. Single-threaded the JS isClaimable() fast-path and the CAS guard are redundant;
  // the CAS guard is the concurrency backstop — validated here at the statement level (the exact
  // predicate added to the engine's claiming UPDATE).
  // ===========================================================================================
  {
    const s = seedProjectClient("m2cas");
    const iid = seedInvoice("m2cas", s.pid, { totalCents: 30000 });
    const payid = seedPayment("m2cas", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    const future = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES ('m2-charge', ?, ?, ?, 'c', 'cus', 'pm', 30000, 30000, 0, 'failed_retryable', 0, 1, 3, ?, ?, ?)`).run(payid, iid, s.pid, future, NOW_ISO, NOW_ISO);
    const casGuard = (nowIso: string) => database.prepare(
      `UPDATE autopay_charges SET status='charging', claim_token='tok', attempt_count = attempt_count + 1, updated_at=?
       WHERE id='m2-charge' AND dry_run=0 AND status IN ('pending','failed_retryable','skipped_capped','aborted_ineligible')
         AND (status != 'failed_retryable' OR (attempt_count < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))`,
    ).run(nowIso, nowIso) as { changes: number };
    const blocked = casGuard(NOW_ISO);
    check("medium2: CAS with a future next_attempt_at matches 0 rows (no stale claim)", blocked.changes === 0 && chargeRow(payid)!.status === "failed_retryable");
    database.prepare("UPDATE autopay_charges SET next_attempt_at=? WHERE id='m2-charge'").run(new Date(NOW.getTime() - 86_400_000).toISOString());
    const claimed = casGuard(NOW_ISO);
    check("medium2: CAS with a past next_attempt_at claims (1 row)", claimed.changes === 1 && chargeRow(payid)!.status === "charging");
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MEDIUM-3 (§7 MINOR-7): active consents on an outdated consent_version
  // surface a WARN health signal (a version bump silently halts charging until re-consent).
  // ===========================================================================================
  {
    process.env.AUTOPAY_ENABLED = "1";
    const health = await import("./system-health");
    const sa = seedProjectClient("verdrift-a");
    seedConsent("verdrift-a", sa.pid, sa.cid, { version: "OLD-VERSION" }); // active + stale
    const sb = seedProjectClient("verdrift-b");
    seedConsent("verdrift-b", sb.pid, sb.cid); // active + current
    database.prepare("UPDATE autopay_consents SET status='revoked' WHERE status='active' AND project_id NOT IN (?, ?)").run(sa.pid, sb.pid);
    const report = await health.computeSystemHealth({ now: NOW });
    const sig = report.signals.find((x) => x.key === "autopay-consent-version-mismatch");
    check("medium3: version-mismatch WARN present, value = stale active count", !!sig && sig.severity === "warn" && sig.value === 1);
    database.prepare("UPDATE autopay_consents SET status='revoked' WHERE project_id=? AND status='active'").run(sa.pid); // cure it
    const report2 = await health.computeSystemHealth({ now: NOW });
    check("medium3: zero stale → no signal (dark/zero is silent)", !report2.signals.some((x) => x.key === "autopay-consent-version-mismatch"));
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MEDIUM-4: a payment_failed webhook resolving a charging row to needs_action
  // must run the §6.6 fallback — cancel the residual PI + mint the manual link + notify — exactly as
  // the sync path does (the webhook path previously skipped it).
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    const s = seedProjectClient("m4wh");
    const iid = seedInvoice("m4wh", s.pid, { totalCents: 30000 });
    const payid = seedPayment("m4wh", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("m4wh", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW); // succeeded POST → row charging WITH a persisted pi id
    const row = chargeRow(payid)!;
    check("medium4: precondition — row charging with a persisted pi id", row.status === "charging" && !!row.stripe_payment_intent_id);
    cancelBehavior = "ok";
    const failEvt = { type: "payment_intent.payment_failed", data: { object: { id: row.stripe_payment_intent_id, status: "requires_action", metadata: { autopay_charge_id: row.id }, last_payment_error: { code: "authentication_required" } } } } as Record<string, unknown>;
    await webhook.recordAutopayPaymentIntentFailed(failEvt);
    check("medium4: webhook resolves the row to needs_action", chargeRow(payid)!.status === "needs_action");
    check("medium4: residual PI canceled (no double-charge path)", calls.some((c) => /\/v1\/payment_intents\/[^/]+\/cancel$/.test(c.url)));
    check("medium4: manual checkout link minted", paymentRow(payid).stripe_checkout_status === "link_ready");
    check("medium4: manual_fallback notified", activityCount("autopay.manual_fallback", payid) === 1);
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MINOR-1: a real autopay charge emails exactly ONE receipt; a replayed
  // success adds none (the paid-transition rowcount gate + the already-settled short-circuit).
  // ===========================================================================================
  {
    resetStub();
    process.env.AUTOPAY_CHARGE_MODE = "live";
    process.env.EMAIL_SENDING_ENABLED = "1";
    process.env.RESEND_API_KEY = "re_test";
    process.env.UNSUBSCRIBE_SECRET = "unsub_secret";
    const s = seedProjectClient("m1rcpt");
    const iid = seedInvoice("m1rcpt", s.pid, { totalCents: 30000 });
    const payid = seedPayment("m1rcpt", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    seedConsent("m1rcpt", s.pid, s.cid);
    isolate(s.pid);
    await engine.runDueAutopayCharges(NOW);
    const row = chargeRow(payid)!;
    const evt = piSuccessEvent(row.id as string, payid, iid, s.pid, 30000, 0, lastPiId!);
    resendCalls.length = 0;
    await webhook.recordAutopayPaymentIntentSucceeded(evt);
    check("minor1: exactly one receipt on first record", resendCalls.length === 1);
    await webhook.recordAutopayPaymentIntentSucceeded(evt); // replay
    check("minor1: replayed success → no additional receipt", resendCalls.length === 1);
    delete process.env.EMAIL_SENDING_ENABLED;
    delete process.env.RESEND_API_KEY;
  }

  // ===========================================================================================
  // Diff-review rev-2.2 — MINOR-2: the double-charge reconciliation scan covers needs_action /
  // failed_terminal rows too (a different-pi success can flag refund_candidate_pi post-fallback).
  // ===========================================================================================
  {
    const s = seedProjectClient("m2dc");
    const iid = seedInvoice("m2dc", s.pid, { totalCents: 30000 });
    const payid = seedPayment("m2dc", iid, { amountCents: 30000, dueDate: "2026-06-01" });
    database.prepare(`INSERT INTO autopay_charges (id, invoice_payment_id, invoice_id, project_id, consent_id, stripe_customer_id, stripe_payment_method_id, amount_cents, service_amount_cents, client_fee_cents, status, dry_run, attempt_count, max_attempts, refund_candidate_pi, created_at, updated_at)
      VALUES ('m2dc-charge', ?, ?, ?, 'c', 'cus', 'pm', 30000, 30000, 0, 'failed_terminal', 0, 3, 3, 'pi_DOUBLE', ?, ?)`).run(payid, iid, s.pid, NOW_ISO, NOW_ISO);
    const recon = await engine.getAutopayChargeReconciliation({ now: NOW });
    check("minor2: failed_terminal row with refund_candidate_pi surfaced in doubleCharge", recon.doubleCharge.some((r) => r.chargeId === "m2dc-charge" && r.refundCandidatePi === "pi_DOUBLE"));
  }

  console.log(`autopay-charge.test.ts: all ${passed} assertions passed`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
