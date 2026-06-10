import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-portal-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.NEXT_PUBLIC_APP_URL = "https://studio.test";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { getPortalProjectContext } = await import("@/lib/portal");
  const { PortalProjectView } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T16:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, preferred_name, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', 'Alex', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (
      id, name, type, stage, status, event_date, venue_name, venue_address, city, state, created_at, updated_at
    ) VALUES (
      'project-1', 'Portal Wedding', 'wedding', 'planning', 'active',
      '2026-09-19', 'The Garden House', '1 Garden Ln', 'Hudson', 'NY', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_events (
      id, project_id, type, title, event_date, venue_name, venue_address, city, state, notes, created_at, updated_at
    ) VALUES (
      'event-1', 'project-1', 'welcome_party', 'Welcome party',
      '2026-09-18', 'River Room', '10 Water St', 'Hudson', 'NY',
      'Casual dinner after rehearsal.', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_locations (
      id, project_id, type, name, address, city, state, notes, created_at, updated_at
    ) VALUES (
      'location-1', 'project-1', 'getting_ready', 'Garden House Suite',
      '1 Garden Ln', 'Hudson', 'NY', 'Hair and makeup start here.', ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      payment_notes, accepted_payment_methods_json,
      card_fee_policy, card_fee_amount_cents, stripe_payment_link, zelle_info, venmo_info,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'PORTAL-INV', 'partially_paid', 900000, 300000,
      'Please include your invoice number with manual payments.',
      ?,
      'client_pays', 26130, 'https://pay.stripe.com/test_portal_invoice',
      'Zelle hello@bythereeses.com',
      '@bythereeses',
      ?, ?
    )
  `).run(JSON.stringify([
    { key: "stripe", displayName: "Credit card", passFees: true, instructions: "" },
    { key: "zelle", displayName: "Zelle", instructions: "Zelle hello@bythereeses.com", passFees: false },
    { key: "venmo", displayName: "Venmo", instructions: "@bythereeses", passFees: false },
  ]), now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, client_fee_cents, processing_fee_cents, gross_collected_cents,
      net_deposit_cents, stripe_checkout_url, stripe_checkout_status, created_at, updated_at
    ) VALUES (
      'payment-1', 'invoice-1', 'Retainer', 300000, '2026-06-01', 'paid',
      '2026-06-02T10:00:00.000Z', 'stripe', 300000, 8730, 8730, 308730,
      300000, 'https://checkout.stripe.com/c/pay/cs_portal_retainer', 'paid', ?, ?
    ), (
      'payment-2', 'invoice-1', 'Final payment', 600000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, 0, 0, 'https://checkout.stripe.com/c/pay/cs_portal_final', 'link_ready', ?, ?
    )
  `).run(now, now, now, now);

  const context = await getPortalProjectContext("project-1", "client-1");
  assert.ok(context);

  const markup = renderToStaticMarkup(<PortalProjectView data={context} />);
  assert.match(markup, /Project logistics/);
  assert.match(markup, /Welcome party/);
  assert.match(markup, /River Room/);
  assert.match(markup, /Casual dinner after rehearsal/);
  assert.match(markup, /Garden House Suite/);
  assert.match(markup, /Hair and makeup start here/);
  assert.match(markup, /Client-payable balance/);
  assert.match(markup, /\$6,174/);
  assert.match(markup, /Card fee remaining/);
  assert.match(markup, /\$174/);
  assert.match(markup, /Payment options/);
  assert.match(markup, /Pay this installment/);
  assert.match(markup, /cs_portal_final/);
  assert.match(markup, /Credit card/);
  assert.match(markup, /Processing fees passed to client/);
  assert.match(markup, /Zelle hello@bythereeses\.com/);
  assert.match(markup, /@bythereeses/);
  assert.match(markup, /Please include your invoice number with manual payments/);

  console.log("portal page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
