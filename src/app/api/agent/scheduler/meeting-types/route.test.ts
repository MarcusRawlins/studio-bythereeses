import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-agent-scheduler-meeting-types-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");
process.env.STUDIO_AGENT_API_TOKEN = "scheduler-token";
process.env.NEXT_PUBLIC_SCHEDULE_URL = "https://schedule.bythereeses.com";

async function main() {
  const { rawDb } = await import("@/db/client");
  const route = await import("./route");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Scheduler Link Wedding', 'wedding', 'planning', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-1', 'Avery', 'Stone', 'avery@example.com', ?, ?),
      ('client-2', 'Wrong', 'Client', 'wrong@example.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO scheduler_meeting_types (
      id, slug, name, description, duration_minutes, buffer_minutes, location_type, location_label,
      invitee_questions_json, collect_payment, price_cents, stripe_payment_link, is_active, created_at, updated_at
    ) VALUES
      (
        'meeting-1', 'discovery-call', 'Discovery Call', 'Intro call.', 45, 15, 'zoom', 'Zoom',
        ?, 0, NULL, NULL, 1, ?, ?
      ),
      (
        'meeting-2', 'paid-consult', 'Paid Consultation', 'Paid planning call.', 60, 15, 'zoom', 'Zoom',
        ?, 1, 25000, 'https://pay.stripe.com/test_consult', 1, ?, ?
      ),
      (
        'meeting-archived', 'old-call', 'Old Call', 'Retired call.', 30, 15, 'zoom', 'Zoom',
        NULL, 0, NULL, NULL, 0, ?, ?
      )
  `).run(
    JSON.stringify([{ id: "vision", label: "What should we cover?", type: "textarea", required: false }]),
    now,
    now,
    JSON.stringify([{ id: "goal", label: "Main planning goal", type: "text", required: false }]),
    now,
    now,
    now,
    now,
  );

  process.env.ORIGIN_PROXY_SECRET = "origin-secret";
  const blockedOrigin = await route.GET(new Request("https://reese-photography-crm.solitary-flower-c3ab.workers.dev/api/agent/scheduler/meeting-types", {
    headers: { authorization: "Bearer scheduler-token" },
  }));
  assert.equal(blockedOrigin.status, 404);

  const unauthorized = await route.GET(new Request("https://studio.bythereeses.com/api/agent/scheduler/meeting-types"));
  assert.equal(unauthorized.status, 401);

  const response = await route.GET(new Request("https://studio.bythereeses.com/api/agent/scheduler/meeting-types?projectId=project-1&clientId=client-1", {
    headers: {
      authorization: "Bearer scheduler-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.meetingTypes.some((meetingType: { id: string }) => meetingType.id === "meeting-discovery-call"));
  const discoveryCall = body.meetingTypes.find((meetingType: { id: string }) => meetingType.id === "meeting-1");
  const paidConsult = body.meetingTypes.find((meetingType: { id: string }) => meetingType.id === "meeting-2");
  assert.equal(discoveryCall.slug, "discovery-call");
  assert.equal(discoveryCall.bookingUrl, "https://schedule.bythereeses.com/book/discovery-call");
  assert.match(discoveryCall.projectBookingUrl, /^https:\/\/schedule\.bythereeses\.com\/book\/discovery-call\?project=/);
  assert.deepEqual(discoveryCall.inviteeQuestions, [
    { id: "vision", label: "What should we cover?", type: "textarea", required: false },
  ]);
  assert.equal(paidConsult.collectPayment, true);
  assert.equal(paidConsult.priceCents, 25000);
  assert.equal(paidConsult.stripePaymentLink, "https://pay.stripe.com/test_consult");

  const wrongClient = await route.GET(new Request("https://studio.bythereeses.com/api/agent/scheduler/meeting-types?projectId=project-1&clientId=client-2", {
    headers: {
      authorization: "Bearer scheduler-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(wrongClient.status, 400);
  assert.deepEqual(await wrongClient.json(), { error: "Scheduler client is not linked to this project." });

  const archived = await route.GET(new Request("https://studio.bythereeses.com/api/agent/scheduler/meeting-types?includeInactive=true", {
    headers: {
      authorization: "Bearer scheduler-token",
      "x-reese-origin-secret": "origin-secret",
    },
  }));
  assert.equal(archived.status, 200);
  assert.ok((await archived.json()).meetingTypes.some((meetingType: { id: string }) => meetingType.id === "meeting-archived"));

  console.log("agent scheduler meeting type route tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
