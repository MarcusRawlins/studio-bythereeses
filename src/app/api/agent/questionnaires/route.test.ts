import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-questionnaires-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "questionnaire-list-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES
      ('questionnaire-active', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?),
      ('questionnaire-draft', 'Draft Questionnaire', 'Not ready yet', 'draft', ?, ?),
      ('questionnaire-archived', 'Old Questionnaire', 'Retired form', 'archived', ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, title, description, type, required, options_json, sort_order, created_at, updated_at
    ) VALUES
      ('question-2', 'questionnaire-active', 'Family priorities', NULL, 'paragraph', 0, NULL, 2, ?, ?),
      ('question-1', 'questionnaire-active', 'Timeline notes', 'Planning notes.', 'paragraph', 1, NULL, 1, ?, ?),
      ('question-draft', 'questionnaire-draft', 'Draft notes', NULL, 'short_text', 0, NULL, 1, ?, ?)
  `).run(now, now, now, now, now, now);

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/questionnaires", {
    headers: { authorization: "Bearer questionnaire-list-token" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/questionnaires"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/questionnaires", {
    headers: {
      authorization: "Bearer questionnaire-list-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.questionnaires, [
    {
      id: "questionnaire-active",
      title: "Timeline Questionnaire",
      description: "Planning form",
      status: "active",
      questionCount: 2,
      updatedAt: now,
      questions: [
        {
          id: "question-1",
          title: "Timeline notes",
          description: "Planning notes.",
          type: "paragraph",
          required: true,
          options: [],
          sortOrder: 1,
        },
        {
          id: "question-2",
          title: "Family priorities",
          description: null,
          type: "paragraph",
          required: false,
          options: [],
          sortOrder: 2,
        },
      ],
    },
  ]);

  const draftResponse = await route.GET(new Request("https://studio.bythereeses.com/api/agent/questionnaires?status=draft&includeQuestions=false", {
    headers: {
      authorization: "Bearer questionnaire-list-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(draftResponse.status, 200);
  const draftBody = await draftResponse.json();
  assert.deepEqual(draftBody.questionnaires, [
    {
      id: "questionnaire-draft",
      title: "Draft Questionnaire",
      description: "Not ready yet",
      status: "draft",
      questionCount: 1,
      updatedAt: now,
    },
  ]);

  console.log("agent questionnaires route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
