import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-timeline-draft-run-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "agent-token";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { createAgentTask } = await import("@/lib/agent-tasks");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-06-29T22:10:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Tiffany', 'Moy', 'tiffany@example.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, created_at, updated_at)
    VALUES ('project-1', 'Tiffany & Tim Wedding', 'wedding', 'planning', 'active', '2026-07-18', 'District Winery', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Photography Timeline & Vision Questionnaire', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Tiffany Moy',
      'tiffany@example.com', ?, ?, ?, ?
    )
  `).run(now, JSON.stringify([
    {
      questionId: "q-ceremony",
      title: "What time will the ceremony begin? How long do you plan on the ceremony lasting?",
      type: "short_text",
      required: true,
      value: "5:30 PM, ~30 mins then cocktail hour",
    },
    {
      questionId: "q-reception",
      title: "What time will the reception begin? Are you planning on doing an entrance?",
      type: "short_text",
      required: true,
      value: "7 PM, yes",
    },
    {
      questionId: "q-bride-parents",
      title: "Bride's parent's names. Please include any step-parents to be included in images.",
      type: "short_text",
      required: true,
      value: "Lili",
    },
  ]), now, now);
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, type, title, required, sort_order, created_at, updated_at
    ) VALUES
      ('q-ceremony', 'questionnaire-1', 'short_text', 'What time will the ceremony begin? How long do you plan on the ceremony lasting?', 1, 1, ?, ?),
      ('q-reception', 'questionnaire-1', 'short_text', 'What time will the reception begin? Are you planning on doing an entrance?', 1, 2, ?, ?),
      ('q-bride-parents', 'questionnaire-1', 'short_text', 'Bride''s parent''s names. Please include any step-parents to be included in images.', 1, 3, ?, ?)
  `).run(now, now, now, now, now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, source_type, source_id, metadata_json, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'questionnaire_response', 'Questionnaire source',
      'Questionnaire body', 'Timeline source', 'questionnaire_response', 'response-1',
      '{"responseId":"response-1"}', ?, ?
    )
  `).run(now, now);

  const task = await createAgentTask({
    projectId: "project-1",
    title: "Create timeline and family formal list",
    instructions: "Draft a timeline.",
    assignedAgent: "Timeline Agent",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  const unauthorized = await route.POST(new Request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/timeline-draft-run`, {
    method: "POST",
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(unauthorized.status, 401);

  const preview = await route.POST(request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/timeline-draft-run`, {
    method: "POST",
    body: JSON.stringify({ projectId: "project-1", previewOnly: true }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.timelineDraftRun.completed, false);
  assert.ok(previewBody.timelineDraftRun.draft.timelineItems.length >= 2);

  const response = await route.POST(request(`https://studio.bythereeses.com/api/agent/tasks/${task.id}/timeline-draft-run`, {
    method: "POST",
    body: JSON.stringify({ projectId: "project-1" }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.timelineDraftRun.completed, true);
  assert.equal(body.timelineDraftRun.completion.status, "completed");

  const row = database.prepare("SELECT status, output_json FROM agent_tasks WHERE id = ?").get(task.id) as { status: string; output_json: string };
  assert.equal(row.status, "completed");
  const output = JSON.parse(row.output_json);
  assert.equal(output.projectId, "project-1");
  assert.equal(output.projectSourceId, "source-1");
  assert.ok(output.timelineDraft.timelineItems.some((item: { title: string }) => item.title === "Ceremony"));

  console.log("agent timeline draft run route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
