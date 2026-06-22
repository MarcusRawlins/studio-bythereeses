import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-six-figure-workflows-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { sixFigureWorkflowTemplates, upsertSixFigureWorkflowTemplates } = await import("./six-figure-workflows");
  const database = rawDb();

  assert.equal(sixFigureWorkflowTemplates.length >= 6, true);
  assert.equal(new Set(sixFigureWorkflowTemplates.map((template) => template.id)).size, sixFigureWorkflowTemplates.length);

  const firstResult = await upsertSixFigureWorkflowTemplates();
  assert.deepEqual(firstResult, {
    upserted: sixFigureWorkflowTemplates.length,
    ids: sixFigureWorkflowTemplates.map((template) => template.id),
  });

  const rows = database.prepare(`
    SELECT id, type, name, trigger, subject, body, status
    FROM templates
    WHERE id LIKE 'six-figure-workflow-%'
    ORDER BY id
  `).all() as Array<{
    id: string;
    type: string;
    name: string;
    trigger: string | null;
    subject: string | null;
    body: string;
    status: string;
  }>;

  assert.equal(rows.length, sixFigureWorkflowTemplates.length);
  assert.equal(rows.some((row) => row.id === "six-figure-workflow-lead-contact-cadence"), true);
  assert.equal(rows.some((row) => row.id === "six-figure-workflow-consultation-to-booking"), true);
  assert.equal(rows.some((row) => row.id === "six-figure-workflow-planning-to-anniversary"), true);
  assert.equal(rows.some((row) => row.id === "six-figure-workflow-post-delivery"), true);
  assert.equal(rows.some((row) => row.id === "six-figure-workflow-referral-follow-up-email"), true);
  assert.equal(rows.some((row) => row.type === "workflow"), true);
  assert.equal(rows.some((row) => row.type === "email"), true);
  assert.equal(rows.some((row) => row.type === "questionnaire"), true);

  const leadCadence = rows.find((row) => row.id === "six-figure-workflow-lead-contact-cadence");
  assert.equal(leadCadence?.trigger, "New inquiry received");
  assert.match(leadCadence?.body ?? "", /Day 1 introduction text/);
  assert.match(leadCadence?.body ?? "", /final close-the-loop email/);

  await upsertSixFigureWorkflowTemplates();
  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM templates
    WHERE id LIKE 'six-figure-workflow-%'
  `).get(), { count: sixFigureWorkflowTemplates.length });

  console.log("six figure workflow tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
