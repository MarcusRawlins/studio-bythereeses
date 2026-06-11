import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-questionnaire-responses-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { db } = await import("@/db/client");
  const { questionnaireQuestions, questionnaireResponses, questionnaires } = await import("@/db/schema");
  const { createQuestionnaireContext } = await import("@/lib/questionnaire-links");
  const route = await import("./route");
  const database = (await import("@/db/client")).rawDb();
  const now = "2026-05-29T12:00:00.000Z";
  const questionnaireId = "questionnaire-response-route-test";
  const questionId = "question-response-route-test-notes";
  const instagramQuestionId = "question-response-route-test-instagram";

  await db.insert(questionnaires).values({
    id: questionnaireId,
    title: "Route Response Test",
    description: "Guards public questionnaire response payloads.",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(questionnaireQuestions).values({
    id: questionId,
    questionnaireId,
    title: "Timeline notes",
    description: null,
    type: "paragraph",
    required: false,
    optionsJson: null,
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(questionnaireQuestions).values({
    id: instagramQuestionId,
    questionnaireId,
    title: "Instagram",
    description: null,
    type: "short_text",
    required: false,
    optionsJson: null,
    sortOrder: 2,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const formData = new FormData();
    formData.set(questionId, "x".repeat(5001));

    const response = await route.POST(
      new Request(`https://studio.bythereeses.com/api/questionnaires/${questionnaireId}/responses`, {
        method: "POST",
        body: formData,
      }),
      { params: Promise.resolve({ id: questionnaireId }) },
    );

    assert.equal(response.status, 400);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /Answer too long/);

    const rows = await db.query.questionnaireResponses.findMany({
      where: eq(questionnaireResponses.questionnaireId, questionnaireId),
    });
    assert.equal(rows.length, 0, "oversized questionnaire answers should not be persisted");

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
      VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
    `).run(now);

    const contextFormData = new FormData();
    contextFormData.set("context", createQuestionnaireContext(questionnaireId, "project-1", "client-1"));
    contextFormData.set(questionId, "First look before ceremony, then family portraits.");
    contextFormData.set(instagramQuestionId, "alexphoto");

    const contextResponse = await route.POST(
      new Request(`https://studio.bythereeses.com/api/questionnaires/${questionnaireId}/responses`, {
        method: "POST",
        body: contextFormData,
      }),
      { params: Promise.resolve({ id: questionnaireId }) },
    );

    assert.equal(contextResponse.status, 303);
    const [savedResponse] = await db.query.questionnaireResponses.findMany({
      where: eq(questionnaireResponses.questionnaireId, questionnaireId),
    });
    assert.equal(savedResponse.projectId, "project-1");
    assert.equal(savedResponse.clientId, "client-1");
    assert.equal(typeof savedResponse.submittedAt, "string");

    const source = database.prepare(`
      SELECT project_id, kind, title, body, source_type, source_id
      FROM project_sources
      WHERE source_id = ?
    `).get(savedResponse.id);
    assert.equal(source.project_id, "project-1");
    assert.equal(source.kind, "questionnaire_response");
    assert.equal(source.title, "Questionnaire: Route Response Test");
    assert.match(source.body, /First look before ceremony/);
    assert.equal(source.source_type, "questionnaire_response");
    assert.equal(source.source_id, savedResponse.id);

    const syncedClient = database.prepare(`
      SELECT instagram_handle
      FROM clients
      WHERE id = 'client-1'
    `).get() as { instagram_handle: string | null };
    assert.equal(syncedClient.instagram_handle, "@alexphoto");
  } finally {
    database.prepare("DELETE FROM project_sources WHERE project_id = 'project-1'").run();
    database.prepare("DELETE FROM project_participants WHERE project_id = 'project-1'").run();
    database.prepare("DELETE FROM projects WHERE id = 'project-1'").run();
    database.prepare("DELETE FROM clients WHERE id = 'client-1'").run();
    await db.delete(questionnaireResponses).where(eq(questionnaireResponses.questionnaireId, questionnaireId));
    await db.delete(questionnaireQuestions).where(eq(questionnaireQuestions.questionnaireId, questionnaireId));
    await db.delete(questionnaires).where(eq(questionnaires.id, questionnaireId));
  }

  console.log("questionnaire responses route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
