import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-invoice-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createInvoiceFromAgent, updateInvoiceFromAgent } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_amount_cents, created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-LOCKED', 'draft', 900000, 0,
      'client_pays', 26130, ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => createInvoiceFromAgent("project-1", {
      invoiceNumber: "INV-AGENT",
      totalCents: 900000,
      sourceType: "project_source",
      sourceId: "source-1",
    }),
    /Invoices and payment schedules require Tyler approval/,
  );
  await assert.rejects(
    () => updateInvoiceFromAgent("project-1", "invoice-1", {
      totalCents: 1000000,
    }),
    /Invoices and payment schedules require Tyler approval/,
  );

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM invoices
    WHERE invoice_number = 'INV-AGENT'
  `).get(), { count: 0 });
  assert.deepEqual(database.prepare(`
    SELECT total_cents
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), { total_cents: 900000 });

  console.log("agent invoice tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
