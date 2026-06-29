import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-questionnaire-response-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: QuestionnaireResponseDetailPage } = await import("./page");
  const database = rawDb();
  const now = "2026-06-28T12:00:00.000Z";

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES ('client-1', 'Tiffany', 'Moy', 'tmoy18@gmail.com', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES ('project-1', 'Tiffany & Tim Wedding', 'wedding', 'retainer_paid', 'active', '2026-07-18', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Photography Timeline & Vision Questionnaire', 'Timeline planning.', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO questionnaire_questions (
      id, questionnaire_id, title, description, type, required, sort_order, created_at, updated_at
    ) VALUES
      ('question-1', 'questionnaire-1', 'Couple details', 'Please provide the following information about you two.', 'section', 0, 1, ?, ?),
      ('question-2', 'questionnaire-1', 'Bride''s full name', NULL, 'short_text', 1, 2, ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO questionnaire_responses (
      id, questionnaire_id, project_id, client_id, respondent_name, respondent_email,
      submitted_at, answers_json, created_at, updated_at
    ) VALUES (
      'response-1', 'questionnaire-1', 'project-1', 'client-1', 'Tiffany Moy',
      'tmoy18@gmail.com', '2026-06-16T22:26:00.000Z',
      '[{"questionId":"question-2","title":"Bride''s full name","value":"Tiffany Moy"}]',
      ?, ?
    )
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id,
      created_at, updated_at
    ) VALUES (
      'source-response-1', 'project-1', 'questionnaire_response',
      'Photography Timeline & Vision Questionnaire', 'Submitted questionnaire answers.',
      'Submitted timeline questionnaire.', 'Studio UI', 'questionnaire_response', 'response-1',
      ?, ?
    )
  `).run(now, now);

  const markup = renderToStaticMarkup(await QuestionnaireResponseDetailPage({
    params: Promise.resolve({ id: "questionnaire-1", responseId: "response-1" }),
  }));

  assert.match(markup, /Questionnaire response/);
  assert.match(markup, /Tiffany Moy/);
  assert.match(markup, /tmoy18@gmail.com/);
  assert.match(markup, /Tiffany &amp; Tim Wedding/);
  assert.match(markup, /Create timeline/);
  assert.match(markup, /action="\/api\/projects\/project-1\/agent-tasks"/);
  assert.match(markup, /name="assignedAgent" value="Timeline Agent"/);
  assert.match(markup, /name="projectSourceId" value="source-response-1"/);
  assert.match(markup, /Create timeline and family formal list from Photography Timeline &amp; Vision Questionnaire/);
  assert.match(markup, /Do not change the canonical wedding date/);
  assert.match(markup, /Edit responses/);
  assert.match(markup, /Answers/);
  assert.doesNotMatch(markup, /xl:grid-cols-4"><div class="rounded-md border border-\[var\(--line\)\] bg-\[var\(--surface\)\] p-5 shadow-sm"/);

  console.log("questionnaire response detail page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
