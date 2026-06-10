import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-checkout-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "secret";
process.env.STRIPE_SECRET_KEY = "sk_test_agent_checkout";
process.env.NEXT_PUBLIC_APP_URL = "https://studio.bythereeses.com";

function agentRequest(token = "secret") {
  return new Request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/payments/payment-final/checkout", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'client', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-AGENT-CHECKOUT', 'partially_paid', 100000, 30000,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents, net_deposit_cents,
      created_at, updated_at
    ) VALUES (
      'payment-paid', 'invoice-1', 'Retainer', 30000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 30000, 900, 900, 30900, 30000, ?, ?
    ), (
      'payment-final', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, 0, 0, ?, ?
    )
  `).run(now, now, now, now);

  const originalFetch = globalThis.fetch;
  const stripeCalls: Array<{ url: string; body: URLSearchParams; headers: Headers }> = [];
  globalThis.fetch = (async (url, init) => {
    stripeCalls.push({
      url: String(url),
      body: new URLSearchParams(String(init?.body ?? "")),
      headers: new Headers(init?.headers),
    });
    return Response.json({
      id: "cs_test_agent_invoice_final",
      url: "https://checkout.stripe.com/c/pay/cs_test_agent_invoice_final",
    });
  }) as typeof fetch;

  try {
    const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/invoices/invoice-1/payments/payment-final/checkout", {
      method: "POST",
    }), { params: Promise.resolve({ id: "invoice-1", paymentId: "payment-final" }) });
    assert.equal(unauthorized.status, 401);
    assert.equal(stripeCalls.length, 0);

    const response = await route.POST(agentRequest(), { params: Promise.resolve({ id: "invoice-1", paymentId: "payment-final" }) });
    assert.equal(response.status, 201);
    const body = await response.json() as {
      checkout: {
        invoiceId: string;
        projectId: string;
        paymentId: string;
        checkoutUrl: string;
        checkoutSessionId: string;
        checkoutStatus: string;
        clientPayableOpenCents: number;
        reused: boolean;
      };
    };
    assert.deepEqual(body.checkout, {
      invoiceId: "invoice-1",
      projectId: "project-1",
      paymentId: "payment-final",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_agent_invoice_final",
      checkoutSessionId: "cs_test_agent_invoice_final",
      checkoutStatus: "link_ready",
      clientPayableOpenCents: 72030,
      reused: false,
    });

    const reusedResponse = await route.POST(agentRequest(), { params: Promise.resolve({ id: "invoice-1", paymentId: "payment-final" }) });
    assert.equal(reusedResponse.status, 201);
    const reusedBody = await reusedResponse.json() as { checkout: { reused: boolean; clientPayableOpenCents: number } };
    assert.equal(reusedBody.checkout.reused, true);
    assert.equal(reusedBody.checkout.clientPayableOpenCents, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(stripeCalls.length, 1);
  assert.equal(stripeCalls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(stripeCalls[0].headers.get("authorization"), "Bearer sk_test_agent_checkout");
  assert.equal(stripeCalls[0].headers.get("stripe-version"), "2026-02-25.clover");
  assert.equal(stripeCalls[0].body.get("mode"), "payment");
  assert.equal(stripeCalls[0].body.get("customer_email"), "alex@example.com");
  assert.equal(stripeCalls[0].body.get("line_items[0][price_data][unit_amount]"), "72030");
  assert.equal(stripeCalls[0].body.get("metadata[invoice_id]"), "invoice-1");
  assert.equal(stripeCalls[0].body.get("metadata[payment_id]"), "payment-final");
  assert.equal(stripeCalls[0].body.get("metadata[project_id]"), "project-1");

  assert.deepEqual(database.prepare(`
    SELECT status, paid_amount_cents, stripe_checkout_url, stripe_checkout_session_id, stripe_checkout_status
    FROM invoice_payments
    WHERE id = 'payment-final'
  `).get(), {
    status: "pending",
    paid_amount_cents: 0,
    stripe_checkout_url: "https://checkout.stripe.com/c/pay/cs_test_agent_invoice_final",
    stripe_checkout_session_id: "cs_test_agent_invoice_final",
    stripe_checkout_status: "link_ready",
  });

  const activity = database.prepare("SELECT action, actor_type, actor_name, metadata FROM activity_logs WHERE action = 'invoice.checkout_session_created'").get() as {
    action: string;
    actor_type: string;
    actor_name: string;
    metadata: string;
  };
  assert.equal(activity.action, "invoice.checkout_session_created");
  assert.equal(activity.actor_type, "agent");
  assert.equal(activity.actor_name, "The Reeses Studio Agent");
  assert.deepEqual(JSON.parse(activity.metadata), {
    invoiceId: "invoice-1",
    paymentId: "payment-final",
    checkoutSessionId: "cs_test_agent_invoice_final",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_agent_invoice_final",
    clientPayableOpenCents: 72030,
    serviceOpenCents: 70000,
    remainingClientFeeCents: 2030,
  });

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-orphan', 'Needs Client Agent Checkout Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-orphan', 'project-orphan', 'INV-AGENT-ORPHAN-CHECKOUT', 'sent', 100000, 0,
      'client_pays', 290, 30, 2930,
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, created_at, updated_at
    ) VALUES (
      'payment-orphan', 'invoice-orphan', 'Retainer', 100000, '2026-08-19', 'pending', ?, ?
    )
  `).run(now, now);

  const fetchCountBeforeOrphan = stripeCalls.length;
  const orphanResponse = await route.POST(new Request("https://studio.bythereeses.com/api/agent/invoices/invoice-orphan/payments/payment-orphan/checkout", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
  }), { params: Promise.resolve({ id: "invoice-orphan", paymentId: "payment-orphan" }) });
  assert.equal(orphanResponse.status, 400);
  assert.deepEqual(await orphanResponse.json(), {
    error: "Add a primary client with an email address before creating a checkout link for this invoice payment.",
  });
  assert.equal(stripeCalls.length, fetchCountBeforeOrphan);

  console.log("agent invoice checkout route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
