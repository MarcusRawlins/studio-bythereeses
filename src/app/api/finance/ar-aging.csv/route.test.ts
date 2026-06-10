import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-ar-aging-csv-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'planning', 'active', '2026-09-19', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents, created_at, updated_at
    ) VALUES ('invoice-1', 'project-1', 'INV-AGING', 'sent', 100000, 0, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoice_payments (
      id, invoice_id, label, amount_cents, due_date, status, paid_at, payment_method,
      paid_amount_cents, gross_collected_cents, net_deposit_cents, created_at, updated_at
    ) VALUES (
      'payment-open', 'invoice-1', 'Final payment', 70000, '2026-08-19', 'pending',
      NULL, NULL, 0, 0, 0, ?, ?
    )
  `).run(now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blocked = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/finance/ar-aging.csv?asOfDate=2026-09-20"));
  assert.equal(blocked.status, 404);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/finance/ar-aging.csv?status=all&asOfDate=2026-09-20", {
    headers: { "x-reese-origin-secret": "origin-secret" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /the-reeses-studio-ar-aging-\d{4}-\d{2}-\d{2}\.csv/);
  const csv = await response.text();
  assert.match(csv, /^As Of,Bucket,Invoice,Project,Client,Payment,Due Date,Days Past Due,Open,Status,Source Type,Source ID,Link/m);
  assert.match(csv, /2026-09-20,31-60,INV-AGING,Alex Wedding,Alex Taylor,Final payment,2026-08-19,32,700.00,pending,invoice,payment-open,\/invoices\/invoice-1/);

  console.log("ar aging csv route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
