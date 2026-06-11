import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-questionnaire-link-route-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "questionnaire-link-token";
process.env.NEXT_PUBLIC_SCHEDULE_URL = "https://schedule.bythereeses.com";

function request(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer questionnaire-link-token",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  const { rawDb } = await import("@/db/client");
  const { verifyQuestionnaireContext } = await import("@/lib/questionnaire-links");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO questionnaires (id, title, description, status, created_at, updated_at)
    VALUES ('questionnaire-1', 'Timeline Questionnaire', 'Planning form', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES
      ('project-1', 'Questionnaire Link Wedding', 'wedding', 'planning', 'active', ?, ?),
      ('project-2', 'Other Questionnaire Link Wedding', 'wedding', 'planning', 'active', ?, ?)
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

  const unauthorized = await route.POST(new Request("https://studio.bythereeses.com/api/agent/projects/project-1/questionnaire-links", {
    method: "POST",
    body: JSON.stringify({ questionnaireId: "questionnaire-1", clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(unauthorized.status, 401);

  process.env.ORIGIN_PROXY_SECRET = "proxy-secret";
  const blockedWorker = await route.POST(request("https://reese-photography-crm.example.workers.dev/api/agent/projects/project-1/questionnaire-links", {
    method: "POST",
    body: JSON.stringify({ questionnaireId: "questionnaire-1", clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(blockedWorker.status, 404);
  delete process.env.ORIGIN_PROXY_SECRET;

  const wrongClient = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/questionnaire-links", {
    method: "POST",
    body: JSON.stringify({ questionnaireId: "questionnaire-1", clientId: "client-2" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });
  assert.equal(wrongClient.status, 400);
  assert.deepEqual(await wrongClient.json(), { error: "Questionnaire client is not linked to this project." });

  const response = await route.POST(request("https://studio.bythereeses.com/api/agent/projects/project-1/questionnaire-links", {
    method: "POST",
    body: JSON.stringify({ questionnaireId: "questionnaire-1", clientId: "client-1" }),
  }), {
    params: Promise.resolve({ id: "project-1" }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.link.projectId, "project-1");
  assert.equal(body.link.clientId, "client-1");
  assert.equal(body.link.questionnaireId, "questionnaire-1");
  assert.match(body.link.questionnaireUrl, /^https:\/\/schedule\.bythereeses\.com\/questionnaires\/questionnaire-1\/preview\?context=/);
  assert.match(body.link.timelineCallUrl, /^https:\/\/schedule\.bythereeses\.com\/book\/wedding-photography-vision-and-timeline-call\?/);

  const context = new URL(body.link.questionnaireUrl).searchParams.get("context");
  assert.deepEqual(verifyQuestionnaireContext(context, "questionnaire-1"), {
    questionnaireId: "questionnaire-1",
    projectId: "project-1",
    clientId: "client-1",
    expiresAt: verifyQuestionnaireContext(context, "questionnaire-1")?.expiresAt,
  });

  assert.deepEqual(database.prepare("SELECT action, actor_type, actor_name FROM activity_logs ORDER BY created_at DESC LIMIT 1").get(), {
    action: "questionnaire.link_created_by_agent",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  console.log("agent questionnaire link route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
