import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-questionnaire-response-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "questionnaire-token";

async function main() {
  const { rawDb } = await import("@/db/client");
  const { POST } = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

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
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, title, type, required, sort_order, created_at, updated_at
    ) VALUES (
      'question-timeline', 'questionnaire-1', 'Timeline notes', 'paragraph', 1, 0, ?, ?
    ), (
      'question-family', 'questionnaire-1', 'Family priorities', 'paragraph', 0, 1, ?, ?
    ), (
      'question-date', 'questionnaire-1', 'Wedding date', 'short_text', 0, 2, ?, ?
    ), (
      'question-venue', 'questionnaire-1', 'Venue name', 'short_text', 0, 3, ?, ?
    )
  `).run(now, now, now, now, now, now, now, now);

  const response = await POST(new Request("https://studio.test/api/agent/projects/project-1/questionnaire-responses", {
    method: "POST",
    headers: {
      authorization: "Bearer questionnaire-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      questionnaireId: "questionnaire-1",
      clientId: "client-1",
      answers: {
        "question-timeline": "First look before ceremony, then family formals.",
        "question-family": "Grandparents first, then siblings.",
        "question-date": "2026-09-19",
        "question-venue": "The Garden House",
      },
      submit: true,
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.questionnaireResponse.projectId, "project-1");
  assert.equal(body.questionnaireResponse.clientId, "client-1");
  assert.equal(body.questionnaireResponse.questionnaireId, "questionnaire-1");
  assert.equal(body.questionnaireResponse.status, "submitted");
  assert.deepEqual(body.questionnaireResponse.answers.map((answer: {
    questionId: string;
    title: string;
    formattedValue: string;
  }) => ({
    questionId: answer.questionId,
    title: answer.title,
    formattedValue: answer.formattedValue,
  })), [
    {
      questionId: "question-timeline",
      title: "Timeline notes",
      formattedValue: "First look before ceremony, then family formals.",
    },
    {
      questionId: "question-family",
      title: "Family priorities",
      formattedValue: "Grandparents first, then siblings.",
    },
    {
      questionId: "question-date",
      title: "Wedding date",
      formattedValue: "2026-09-19",
    },
    {
      questionId: "question-venue",
      title: "Venue name",
      formattedValue: "The Garden House",
    },
  ]);

  const source = database.prepare(`
    SELECT project_id, kind, title, body, source_type, source_id
    FROM project_sources
    WHERE source_id = ?
  `).get(body.questionnaireResponse.id);
  assert.equal(source.project_id, "project-1");
  assert.equal(source.kind, "questionnaire_response");
  assert.equal(source.title, "Questionnaire: Timeline Questionnaire");
  assert.match(source.body, /Grandparents first/);
  assert.equal(source.source_type, "questionnaire_response");
  assert.equal(source.source_id, body.questionnaireResponse.id);
  assert.deepEqual(database.prepare(`
    SELECT event_date, venue_name, calendar_sync_status
    FROM projects
    WHERE id = 'project-1'
  `).get(), {
    event_date: "2026-09-19",
    venue_name: "The Garden House",
    calendar_sync_status: "needs_google_connection",
  });

  const secondResponse = await POST(new Request("https://studio.test/api/agent/projects/project-1/questionnaire-responses", {
    method: "POST",
    headers: {
      authorization: "Bearer questionnaire-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      responseId: body.questionnaireResponse.id,
      questionnaireId: "questionnaire-1",
      answers: {
        "question-timeline": "Updated from the planning call.",
      },
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(secondResponse.status, 200);
  assert.equal(database.prepare(`
    SELECT count(*) AS count
    FROM questionnaire_responses
    WHERE project_id = 'project-1'
  `).get().count, 1);

  const thirdResponse = await POST(new Request("https://studio.test/api/agent/projects/project-1/questionnaire-responses", {
    method: "POST",
    headers: {
      authorization: "Bearer questionnaire-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      questionnaireId: "questionnaire-1",
      clientId: "client-1",
      answers: {
        "question-timeline": "Final canonical timeline answer.",
        "question-venue": "The Conservatory",
      },
      submit: true,
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });

  assert.equal(thirdResponse.status, 200);
  const thirdBody = await thirdResponse.json();
  assert.equal(thirdBody.questionnaireResponse.id, body.questionnaireResponse.id);
  assert.equal(database.prepare(`
    SELECT count(*) AS count
    FROM questionnaire_responses
    WHERE project_id = 'project-1' AND questionnaire_id = 'questionnaire-1' AND client_id = 'client-1'
  `).get().count, 1);
  assert.deepEqual(database.prepare(`
    SELECT answers_json
    FROM questionnaire_responses
    WHERE id = ?
  `).get(body.questionnaireResponse.id), {
    answers_json: JSON.stringify([
      {
        questionId: "question-timeline",
        title: "Timeline notes",
        type: "paragraph",
        required: true,
        value: "Final canonical timeline answer.",
      },
      {
        questionId: "question-family",
        title: "Family priorities",
        type: "paragraph",
        required: false,
        value: "",
      },
      {
        questionId: "question-date",
        title: "Wedding date",
        type: "short_text",
        required: false,
        value: "",
      },
      {
        questionId: "question-venue",
        title: "Venue name",
        type: "short_text",
        required: false,
        value: "The Conservatory",
      },
    ]),
  });
  assert.deepEqual(database.prepare(`
    SELECT venue_name
    FROM projects
    WHERE id = 'project-1'
  `).get(), { venue_name: "The Conservatory" });

  const unauthorized = await POST(new Request("https://studio.test/api/agent/projects/project-1/questionnaire-responses", {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      questionnaireId: "questionnaire-1",
      answers: { "question-timeline": "Nope" },
    }),
  }), { params: Promise.resolve({ id: "project-1" }) });
  assert.equal(unauthorized.status, 401);

  console.log("agent questionnaire response route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
