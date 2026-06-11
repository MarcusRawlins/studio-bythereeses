import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-questionnaires-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Questionnaire Route Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);

  const formData = new FormData();
  formData.set("title", "Wedding weekend details");
  formData.set("description", "Client-facing details for the wedding weekend.");
  formData.set("status", "active");

  const response = await POST(new Request("https://studio.test/api/projects/project-1/questionnaires", {
    method: "POST",
    body: formData,
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/studio\.test\/questionnaires\/.+\?projectId=project-1$/);

  const questionnaire = database.prepare(`
    SELECT id, title, description, status
    FROM questionnaires
  `).get() as {
    id: string;
    title: string;
    description: string | null;
    status: string;
  };
  assert.deepEqual({
    title: questionnaire.title,
    description: questionnaire.description,
    status: questionnaire.status,
  }, {
    title: "Wedding weekend details",
    description: "Client-facing details for the wedding weekend.",
    status: "active",
  });
  assert.deepEqual(database.prepare(`
    SELECT title, type
    FROM questionnaire_questions
    WHERE questionnaire_id = ?
  `).get(questionnaire.id), {
    title: "New question",
    type: "short_text",
  });
  assert.deepEqual(database.prepare(`
    SELECT action
    FROM activity_logs
  `).get(), {
    action: "questionnaire.created",
  });

  console.log("project questionnaire route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
