import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-templates-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function postTemplate(route: { POST: (request: Request) => Promise<Response> }, formData: FormData) {
  return route.POST(new Request("https://studio.bythereeses.com/api/templates", {
    method: "POST",
    body: formData,
  }));
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();

  const createForm = new FormData();
  createForm.set("_action", "create");
  createForm.set("type", "contract");
  createForm.set("status", "active");
  createForm.set("name", " Wedding Agreement ");
  createForm.set("trigger", " proposal accepted ");
  createForm.set("subject", " Your agreement ");
  createForm.set("body", " Agreement for {{client.name}} and {{project.name}}. ");

  const createResponse = await postTemplate(route, createForm);
  assert.equal(createResponse.status, 303);
  assert.equal(createResponse.headers.get("location"), "https://studio.bythereeses.com/templates");

  const created = database.prepare(`
    SELECT id, type, status, name, trigger, subject, body
    FROM templates
    WHERE name = 'Wedding Agreement'
  `).get() as {
    id: string;
    type: string;
    status: string;
    name: string;
    trigger: string;
    subject: string;
    body: string;
  };
  assert.deepEqual({
    type: created.type,
    status: created.status,
    name: created.name,
    trigger: created.trigger,
    subject: created.subject,
    body: created.body,
  }, {
    type: "contract",
    status: "active",
    name: "Wedding Agreement",
    trigger: "proposal accepted",
    subject: "Your agreement",
    body: "Agreement for {{client.name}} and {{project.name}}.",
  });

  const updateForm = new FormData();
  updateForm.set("_action", "update");
  updateForm.set("templateId", created.id);
  updateForm.set("type", "email");
  updateForm.set("status", "draft");
  updateForm.set("name", " Inquiry Follow-up ");
  updateForm.set("trigger", " 24 hours after inquiry ");
  updateForm.set("subject", " Let's talk ");
  updateForm.set("body", " Thanks for reaching out. ");

  const updateResponse = await postTemplate(route, updateForm);
  assert.equal(updateResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT type, status, name, trigger, subject, body
    FROM templates
    WHERE id = ?
  `).get(created.id), {
    type: "email",
    status: "draft",
    name: "Inquiry Follow-up",
    trigger: "24 hours after inquiry",
    subject: "Let's talk",
    body: "Thanks for reaching out.",
  });

  const proposalPackageForm = new FormData();
  proposalPackageForm.set("_action", "create");
  proposalPackageForm.set("type", "proposal_package");
  proposalPackageForm.set("status", "active");
  proposalPackageForm.set("name", " Signature Collection ");
  proposalPackageForm.set("trigger", " discovery call complete ");
  proposalPackageForm.set("subject", " Collection overview ");
  proposalPackageForm.set("body", " Package options, terms, and client-facing explanation. ");

  const proposalPackageResponse = await postTemplate(route, proposalPackageForm);
  assert.equal(proposalPackageResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT type, status, name, trigger, subject, body
    FROM templates
    WHERE name = 'Signature Collection'
  `).get(), {
    type: "proposal_package",
    status: "active",
    name: "Signature Collection",
    trigger: "discovery call complete",
    subject: "Collection overview",
    body: "Package options, terms, and client-facing explanation.",
  });

  const reminderForm = new FormData();
  reminderForm.set("_action", "create");
  reminderForm.set("type", "reminder");
  reminderForm.set("status", "draft");
  reminderForm.set("name", " Invoice Follow-up ");
  reminderForm.set("trigger", " 3 days before due date ");
  reminderForm.set("body", " Friendly payment follow-up for open balances. ");

  const reminderResponse = await postTemplate(route, reminderForm);
  assert.equal(reminderResponse.status, 303);
  assert.deepEqual(database.prepare(`
    SELECT type, status, name, trigger, subject, body
    FROM templates
    WHERE name = 'Invoice Follow-up'
  `).get(), {
    type: "reminder",
    status: "draft",
    name: "Invoice Follow-up",
    trigger: "3 days before due date",
    subject: null,
    body: "Friendly payment follow-up for open balances.",
  });

  const deleteForm = new FormData();
  deleteForm.set("_action", "delete");
  deleteForm.set("templateId", created.id);

  const deleteResponse = await postTemplate(route, deleteForm);
  assert.equal(deleteResponse.status, 303);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM templates").get(), { count: 2 });

  assert.deepEqual(database.prepare(`
    SELECT action
    FROM activity_logs
    WHERE action LIKE 'template.%'
    ORDER BY created_at
  `).all(), [
    { action: "template.created" },
    { action: "template.updated" },
    { action: "template.created" },
    { action: "template.created" },
    { action: "template.deleted" },
  ]);

  console.log("templates route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
