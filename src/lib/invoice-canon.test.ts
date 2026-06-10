import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-invoice-canon-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

function statusForm(projectId: string, status: string) {
  const formData = new FormData();
  formData.set("invoiceId", "invoice-1");
  formData.set("projectId", projectId);
  formData.set("status", status);
  return formData;
}

function createInvoiceForm(projectId: string) {
  const formData = new FormData();
  formData.set("projectId", projectId);
  formData.set("invoiceNumber", "INV-MISSING-PROJECT");
  formData.set("total", "1000.00");
  formData.set("retainerPercent", "30");
  formData.set("installmentCount", "1");
  return formData;
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createInvoiceFromForm, invoiceStatusOptions, updateInvoiceStatusFromForm } = await import("./sales");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Invoice Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Invoice Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO invoices (
      id, project_id, invoice_number, status, total_cents, amount_paid_cents,
      card_fee_policy, card_fee_percent_bps, card_fee_fixed_cents, card_fee_amount_cents,
      created_at, updated_at
    ) VALUES (
      'invoice-1', 'project-1', 'INV-CANON', 'draft', 500000, 0,
      'studio_absorbs', 0, 0, 0,
      ?, ?
    )
  `).run(now, now);

  await assert.rejects(
    () => createInvoiceFromForm(createInvoiceForm("missing-project")),
    /Project not found/,
  );
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM invoices
    WHERE invoice_number = 'INV-MISSING-PROJECT'
  `).get(), { count: 0 });

  await assert.rejects(
    () => updateInvoiceStatusFromForm(statusForm("project-2", "paid")),
    /Invoice does not belong to this project/,
  );

  assert.deepEqual(database.prepare(`
    SELECT status, sent_at, paid_at
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    status: "draft",
    sent_at: null,
    paid_at: null,
  });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM activity_logs").get(), { count: 0 });

  const result = await updateInvoiceStatusFromForm(statusForm("project-1", "sent"));
  assert.deepEqual(result, { invoiceId: "invoice-1", projectId: "project-1" });
  const sentInvoice = database.prepare(`
    SELECT status, sent_at, paid_at
    FROM invoices
    WHERE id = 'invoice-1'
  `).get() as { status: string; sent_at: string | null; paid_at: string | null };
  assert.equal(sentInvoice.status, "sent");
  assert.ok(sentInvoice.sent_at);
  assert.equal(sentInvoice.paid_at, null);

  assert.deepEqual(database.prepare(`
    SELECT action, project_id
    FROM activity_logs
    WHERE action = 'invoice.status_updated'
  `).get(), {
    action: "invoice.status_updated",
    project_id: "project-1",
  });

  await assert.rejects(
    () => updateInvoiceStatusFromForm(statusForm("project-1", "paid")),
    /Use the invoice payment endpoint to record paid invoice state/,
  );
  await assert.rejects(
    () => updateInvoiceStatusFromForm(statusForm("project-1", "partially_paid")),
    /Use the invoice payment endpoint to record paid invoice state/,
  );
  assert.deepEqual(database.prepare(`
    SELECT status, amount_paid_cents, paid_at
    FROM invoices
    WHERE id = 'invoice-1'
  `).get(), {
    status: "sent",
    amount_paid_cents: 0,
    paid_at: null,
  });
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_logs
    WHERE action = 'invoice.status_updated'
  `).get(), { count: 1 });
  assert.ok(
    !invoiceStatusOptions.some((option) => option.value === "paid" || option.value === "partially_paid"),
    "manual invoice status options should not include ledger-owned paid states",
  );

  const oversizedRetainer = new FormData();
  oversizedRetainer.set("projectId", "project-1");
  oversizedRetainer.set("invoiceNumber", "INV-OVERSIZED-RETAINER");
  oversizedRetainer.set("total", "1000.00");
  oversizedRetainer.set("retainerAmount", "1500.00");
  oversizedRetainer.set("installmentCount", "1");
  const oversizedResult = await createInvoiceFromForm(oversizedRetainer);
  assert.deepEqual(database.prepare(`
    SELECT total_cents
    FROM invoices
    WHERE id = ?
  `).get(oversizedResult.invoiceId), {
    total_cents: 100000,
  });
  assert.deepEqual(database.prepare(`
    SELECT label, amount_cents
    FROM invoice_payments
    WHERE invoice_id = ?
    ORDER BY label
  `).all(oversizedResult.invoiceId), [
    { label: "Retainer", amount_cents: 100000 },
  ]);
  assert.deepEqual(database.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS scheduled_cents
    FROM invoice_payments
    WHERE invoice_id = ?
  `).get(oversizedResult.invoiceId), {
    scheduled_cents: 100000,
  });

  console.log("invoice canon tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
