import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-communications-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    createProjectCommunicationFromAgent,
    createProjectCommunicationFromForm,
    updateProjectCommunicationFromAgent,
    updateProjectCommunicationFromForm,
  } = await import("./project-communications");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Alex Wedding', 'wedding', 'inquiry', 'active', ?, ?),
      ('project-2', 'Other Wedding', 'wedding', 'inquiry', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, phone, created_at, updated_at)
    VALUES ('client-1', 'Alex', 'Taylor', 'alex@example.com', '555-0100', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-1', 'project-1', 'client-1', 'primary', 1, ?)
  `).run(now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, created_at, updated_at
    ) VALUES (
      'source-1', 'project-1', 'discovery_call', 'Discovery call notes',
      'Client wants a calm proposal follow-up.', 'Follow-up source summary', 'Studio UI', ?, ?
    ), (
      'source-2', 'project-1', 'discovery_call', 'Corrected discovery call notes',
      'Cleaned follow-up source.', 'Corrected follow-up source summary', 'Studio UI', ?, ?
    ), (
      'other-source', 'project-2', 'discovery_call', 'Other source',
      'Wrong project notes.', 'Wrong source summary', 'Studio UI', ?, ?
    )
  `).run(now, now, now, now, now, now);

  const draft = await createProjectCommunicationFromAgent("project-1", {
    subject: "Your wedding proposal next steps",
    body: "Hi Alex, here is the calm next-step recap from our call.",
    status: "draft",
    sourceType: "project_source",
    sourceId: "source-1",
  });

  assert.equal(draft.projectId, "project-1");
  assert.equal(draft.clientId, "client-1");
  assert.equal(draft.direction, "outbound");
  assert.equal(draft.channel, "email");
  assert.equal(draft.status, "draft");
  assert.equal(draft.recipientName, "Alex Taylor");
  assert.equal(draft.recipientEmail, "alex@example.com");
  assert.equal(draft.sourceType, "project_source");
  assert.equal(draft.sourceId, "source-1");

  assert.deepEqual(database.prepare(`
    SELECT project_id, client_id, direction, channel, status, subject, body, recipient_name, recipient_email, source_type, source_id, created_by
    FROM project_communications
    WHERE id = ?
  `).get(draft.id), {
    project_id: "project-1",
    client_id: "client-1",
    direction: "outbound",
    channel: "email",
    status: "draft",
    subject: "Your wedding proposal next steps",
    body: "Hi Alex, here is the calm next-step recap from our call.",
    recipient_name: "Alex Taylor",
    recipient_email: "alex@example.com",
    source_type: "project_source",
    source_id: "source-1",
    created_by: "agent",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE project_id = ?
  `).get("project-1"), {
    action: "project.communication.created_by_agent",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  // Phase 14 §8: the agent send-clamp now covers EMAIL as well as SMS. An
  // agent-authored email row can only ever land "draft" — a prompt-injected agent
  // can never flip it to "sent" ("we emailed them" that never went out). Body
  // edits still apply (drafts are agent-editable); only the send-state is clamped.
  const clampedUpdate = await updateProjectCommunicationFromAgent("project-1", draft.id, {
    status: "sent",
    body: "Hi Alex, here is the polished follow-up from our discovery call.",
  });

  assert.equal(clampedUpdate.id, draft.id);
  assert.equal(clampedUpdate.status, "draft", "agent email status:sent is clamped to draft (§8)");
  assert.equal(clampedUpdate.body, "Hi Alex, here is the polished follow-up from our discovery call.");

  assert.deepEqual(database.prepare(`
    SELECT status, body
    FROM project_communications
    WHERE id = ?
  `).get(draft.id), {
    status: "draft",
    body: "Hi Alex, here is the polished follow-up from our discovery call.",
  });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE action = 'project.communication.updated_by_agent'
  `).get(), {
    action: "project.communication.updated_by_agent",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  // Agent create with status:sent (email) → also clamped to draft.
  const autoTimestampDraft = await createProjectCommunicationFromAgent("project-1", {
    subject: "Auto timestamp follow-up",
    body: "This communication should stay a draft even if asked to send.",
    status: "draft",
  });
  const clampedFlip = await updateProjectCommunicationFromAgent("project-1", autoTimestampDraft.id, {
    status: "sent",
  });
  assert.equal(clampedFlip.status, "draft", "agent email flip to sent → draft (§8)");

  const agentCreatedSent = await createProjectCommunicationFromAgent("project-1", {
    subject: "Already sent follow-up",
    body: "This email claims to already be sent.",
    status: "sent",
  });
  assert.equal(agentCreatedSent.status, "draft", "agent email create status:sent → draft (§8)");

  const relinked = await updateProjectCommunicationFromAgent("project-1", draft.id, {
    sourceType: "project_source",
    sourceId: "source-2",
  });

  assert.equal(relinked.id, draft.id);
  assert.equal(relinked.sourceType, "project_source");
  assert.equal(relinked.sourceId, "source-2");
  assert.deepEqual(database.prepare(`
    SELECT source_type, source_id
    FROM project_communications
    WHERE id = ?
  `).get(draft.id), {
    source_type: "project_source",
    source_id: "source-2",
  });

  await assert.rejects(
    () => updateProjectCommunicationFromAgent("project-1", draft.id, {
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );

  await assert.rejects(
    () => createProjectCommunicationFromAgent("project-1", {
      subject: "Half-linked source",
      body: "This should not write with only a source id.",
      sourceId: "source-1",
    }),
    /Project communication source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => updateProjectCommunicationFromAgent("project-1", draft.id, {
      sourceType: null,
      sourceId: "source-1",
    }),
    /Project communication source links require sourceType when sourceId is set/,
  );

  await assert.rejects(
    () => updateProjectCommunicationFromAgent("project-2", draft.id, { status: "archived" }),
    /Communication not found/,
  );

  await assert.rejects(
    () => createProjectCommunicationFromAgent("project-1", {
      subject: "Wrong source",
      body: "This should not write.",
      sourceType: "project_source",
      sourceId: "other-source",
    }),
    /Project source not found/,
  );

  await assert.rejects(
    () => createProjectCommunicationFromAgent("project-1", {
      subject: "Missing body",
      body: " ",
    }),
    /Communication body is required/,
  );

  const formData = new FormData();
  formData.set("clientId", "client-1");
  formData.set("direction", "outbound");
  formData.set("channel", "email");
  formData.set("status", "draft");
  formData.set("subject", "Studio follow-up draft");
  formData.set("body", "Hi Alex, this draft was created from the Studio project page.");
  formData.set("recipientName", "Alex T.");
  formData.set("recipientEmail", "ALEX@EXAMPLE.COM");
  formData.set("sourceId", "source-1");

  const studioDraft = await createProjectCommunicationFromForm("project-1", formData);
  assert.equal(studioDraft.projectId, "project-1");
  assert.equal(studioDraft.clientId, "client-1");
  assert.equal(studioDraft.createdBy, "admin");
  assert.equal(studioDraft.recipientName, "Alex T.");
  assert.equal(studioDraft.recipientEmail, "alex@example.com");
  assert.equal(studioDraft.sourceType, "project_source");
  assert.equal(studioDraft.sourceId, "source-1");

  assert.deepEqual(database.prepare(`
    SELECT created_by, source_type, source_id
    FROM project_communications
    WHERE id = ?
  `).get(studioDraft.id), {
    created_by: "admin",
    source_type: "project_source",
    source_id: "source-1",
  });

  const updateFormData = new FormData();
  updateFormData.set("status", "sent");
  updateFormData.set("channel", "email");
  updateFormData.set("direction", "outbound");
  updateFormData.set("subject", "Studio follow-up draft");
  updateFormData.set("body", "Hi Alex, this exact communication is now marked sent from Studio.");
  updateFormData.set("recipientName", "Alex T.");
  updateFormData.set("recipientEmail", "alex@example.com");

  const studioSent = await updateProjectCommunicationFromForm("project-1", studioDraft.id, updateFormData);
  assert.equal(studioSent.id, studioDraft.id);
  assert.equal(studioSent.status, "sent");
  assert.equal(studioSent.body, "Hi Alex, this exact communication is now marked sent from Studio.");

  assert.deepEqual(database.prepare(`
    SELECT COUNT(*) AS count
    FROM project_communications
    WHERE subject = 'Studio follow-up draft'
  `).get(), { count: 1 });

  assert.deepEqual(database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE action = 'project.communication.updated_by_admin'
  `).get(), {
    action: "project.communication.updated_by_admin",
    actor_type: "admin",
    actor_name: "The Reeses Studio",
  });

  console.log("project communication tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
