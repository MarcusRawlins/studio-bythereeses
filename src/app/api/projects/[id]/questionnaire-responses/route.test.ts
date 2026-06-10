import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-questionnaire-responses-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Questionnaire Response Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Wrong Questionnaire Response Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Wrong', 'Client', 'wrong@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES
      ('participant-1', 'project-1', 'client-1', 'primary', 1, ?),
      ('participant-2', 'project-2', 'client-2', 'primary', 1, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, status, external_question_count, last_response_count, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'active', 0, 0, ?, ?)
  `).run(now, now);

  const wrongClientForm = new FormData();
  wrongClientForm.set("questionnaireId", "questionnaire-1");
  wrongClientForm.set("clientId", "client-2");

  const originalConsoleError = console.error;
  console.error = () => {};
  const wrongClientResponse = await POST(new Request("https://studio.test/api/projects/project-1/questionnaire-responses", {
    method: "POST",
    body: wrongClientForm,
  }), { params: Promise.resolve({ id: "project-1" }) }).finally(() => {
    console.error = originalConsoleError;
  });

  assert.equal(wrongClientResponse.status, 400);
  assert.deepEqual(await wrongClientResponse.json(), { error: "Questionnaire client is not linked to this project." });
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM questionnaire_responses").get(), { count: 0 });

  const formData = new FormData();
  formData.set("questionnaireId", "questionnaire-1");
  formData.set("clientId", "client-1");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/questionnaire-responses", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/studio\.test\/questionnaires\/questionnaire-1\/responses\/.+\/edit$/);

  const draft = database.prepare(`
    SELECT id, questionnaire_id, project_id, client_id, respondent_name, respondent_email, submitted_at
    FROM questionnaire_responses
  `).get() as { id: string };
  assert.deepEqual({
    ...draft,
    id: Boolean(draft.id),
  }, {
    id: true,
    questionnaire_id: "questionnaire-1",
    project_id: "project-1",
    client_id: "client-1",
    respondent_name: "Avery Stone",
    respondent_email: "avery@example.com",
    submitted_at: null,
  });

  const duplicateResponse = await POST(new Request("https://studio.test/api/projects/project-1/questionnaire-responses", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(duplicateResponse.status, 303);
  assert.equal(duplicateResponse.headers.get("location"), `https://studio.test/questionnaires/questionnaire-1/responses/${draft.id}/edit`);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS count FROM questionnaire_responses").get(), { count: 1 });

  assert.deepEqual(database.prepare(`
    SELECT action, project_id, client_id
    FROM activity_logs
  `).get(), {
    action: "questionnaire.response.draft_created",
    project_id: "project-1",
    client_id: "client-1",
  });

  console.log("project questionnaire response route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
