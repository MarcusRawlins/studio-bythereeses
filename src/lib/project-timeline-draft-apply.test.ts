import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-timeline-draft-apply-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { db } = await import("@/db/client");
  const { projectTimelineItems } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { applyProjectTimelineDraft } = await import("./project-timeline");

  const stamp = Date.now();
  const now = "2026-06-01T12:00:00.000Z";
  const projectId = `test-project-timeline-draft-${stamp}`;
  const projectSourceId = `test-source-timeline-draft-${stamp}`;
  const taskId = `test-task-timeline-draft-${stamp}`;

  const database = db.$client;
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, created_at, updated_at)
    VALUES (?, 'Timeline Draft Apply Test', 'wedding', 'planning', 'active', '2026-09-19', 'The Grand Hall', ?, ?)
  `).run(projectId, now, now);
  database.prepare(`
    INSERT INTO project_sources (
      id, project_id, kind, title, body, summary, captured_by, source_type, source_id, created_at, updated_at
    ) VALUES (?, ?, 'questionnaire_response', 'Questionnaire: Timeline', 'body', 'summary', 'Studio Questionnaire', 'questionnaire_response', ?, ?, ?)
  `).run(projectSourceId, projectId, projectSourceId, now, now);

  const timelineDraft = {
    projectId,
    sourceIds: [projectSourceId],
    assumptions: [],
    openQuestions: [],
    timelineItems: [
      { title: "Ceremony", description: "Outdoor garden ceremony.", startAt: "02:00 PM", confidence: "high" },
      { title: "Reception entrance", description: "Grand entrance.", startAt: "not a real time", confidence: "medium" },
    ],
    familyFormals: [],
    locationSuggestions: [],
  };
  const outputJson = JSON.stringify({ projectId, projectSourceId, timelineDraft });
  database.prepare(`
    INSERT INTO agent_tasks (id, project_id, title, status, priority, assigned_agent, source_type, source_id, output_json, completed_at, created_at, updated_at)
    VALUES (?, ?, 'Timeline draft', 'completed', 'normal', 'Timeline Agent', 'project_source', ?, ?, ?, ?, ?)
  `).run(taskId, projectId, projectSourceId, outputJson, now, now, now);

  // -------------------------------------------------------------------
  // Test 6 — Timeline-draft apply + idempotent re-apply.
  // Test 12 — ISO startAt composition (M5), folded in here.
  // -------------------------------------------------------------------
  const applied1 = await applyProjectTimelineDraft({ projectId, outputJson, confirmReplace: false, actorName: "Tyler" });
  assert.equal(applied1.ok, true);
  if (!applied1.ok) throw new Error("unreachable");
  assert.equal(applied1.timelineItems.length, 2);

  const rows1 = await db.query.projectTimelineItems.findMany({
    where: (item, { and, eq }) => and(eq(item.projectId, projectId), eq(item.sourceType, "project_source"), eq(item.sourceId, projectSourceId)),
  });
  assert.equal(rows1.length, 2);

  const ceremonyRow = rows1.find((row) => row.title === "Ceremony");
  assert.equal(ceremonyRow?.startAt, "2026-09-19T14:00:00.000Z", "a parsable 12-hour time must compose into ISO, anchored to project.eventDate");

  const receptionRow = rows1.find((row) => row.title === "Reception entrance");
  assert.equal(receptionRow?.startAt, null, "an unparsable time must never produce a non-ISO startAt");
  assert.match(receptionRow?.description ?? "", /not a real time/, "the raw unparsed text must be carried in the description");

  // Re-apply with no hand edits present — idempotent replace-by-source, same count.
  const applied2 = await applyProjectTimelineDraft({ projectId, outputJson, confirmReplace: false, actorName: "Tyler" });
  assert.equal(applied2.ok, true);
  if (!applied2.ok) throw new Error("unreachable");
  const rows2 = await db.query.projectTimelineItems.findMany({
    where: (item, { and, eq }) => and(eq(item.projectId, projectId), eq(item.sourceType, "project_source"), eq(item.sourceId, projectSourceId)),
  });
  assert.equal(rows2.length, 2, "idempotent re-apply must not duplicate rows");

  // -------------------------------------------------------------------
  // Test 14 — Timeline hand-edit protection (M4).
  // -------------------------------------------------------------------
  const editedItem = rows2[0];
  await db.update(projectTimelineItems)
    .set({ title: "Tyler's hand-edited title", updatedAt: "2030-01-01T00:00:00.000Z" })
    .where(eq(projectTimelineItems.id, editedItem.id));

  const appliedNoConfirm = await applyProjectTimelineDraft({ projectId, outputJson, confirmReplace: false, actorName: "Tyler" });
  assert.equal(appliedNoConfirm.ok, false);
  if (appliedNoConfirm.ok) throw new Error("unreachable");
  assert.ok("needsConfirm" in appliedNoConfirm && appliedNoConfirm.needsConfirm, "a hand-edited item must block a silent replace");
  if (!("needsConfirm" in appliedNoConfirm)) throw new Error("unreachable");
  assert.equal(appliedNoConfirm.handEditedCount, 1);

  const rowsAfterBlockedReplace = await db.query.projectTimelineItems.findMany({
    where: (item, { and, eq }) => and(eq(item.projectId, projectId), eq(item.sourceType, "project_source"), eq(item.sourceId, projectSourceId)),
  });
  assert.equal(rowsAfterBlockedReplace.length, 2, "a blocked replace must leave the existing (hand-edited) rows intact");
  assert.ok(rowsAfterBlockedReplace.some((row) => row.title === "Tyler's hand-edited title"), "the hand edit must survive an unconfirmed re-apply");

  const appliedWithConfirm = await applyProjectTimelineDraft({ projectId, outputJson, confirmReplace: true, actorName: "Tyler" });
  assert.equal(appliedWithConfirm.ok, true);
  if (!appliedWithConfirm.ok) throw new Error("unreachable");
  const rowsAfterConfirmedReplace = await db.query.projectTimelineItems.findMany({
    where: (item, { and, eq }) => and(eq(item.projectId, projectId), eq(item.sourceType, "project_source"), eq(item.sourceId, projectSourceId)),
  });
  assert.equal(rowsAfterConfirmedReplace.length, 2, "a confirmed re-apply replaces the draft-sourced items");
  assert.ok(!rowsAfterConfirmedReplace.some((row) => row.title === "Tyler's hand-edited title"), "the confirmed replace must overwrite the hand edit");

  // Route-validation friendly errors (rev 2 MINOR).
  const crossProjectResult = await applyProjectTimelineDraft({
    projectId: "some-other-project",
    outputJson,
    confirmReplace: false,
  });
  assert.equal(crossProjectResult.ok, false);
  if (crossProjectResult.ok) throw new Error("unreachable");
  assert.match(crossProjectResult.error, /different project/i);

  const missingSourceResult = await applyProjectTimelineDraft({
    projectId,
    outputJson: JSON.stringify({ projectId, timelineDraft }),
    confirmReplace: false,
  });
  assert.equal(missingSourceResult.ok, false);
  if (missingSourceResult.ok) throw new Error("unreachable");
  assert.match(missingSourceResult.error, /no source link/i);

  const emptyItemsResult = await applyProjectTimelineDraft({
    projectId,
    outputJson: JSON.stringify({ projectId, projectSourceId, timelineDraft: { ...timelineDraft, timelineItems: [] } }),
    confirmReplace: false,
  });
  assert.equal(emptyItemsResult.ok, false);
  if (emptyItemsResult.ok) throw new Error("unreachable");
  assert.match(emptyItemsResult.error, /no timeline items/i);

  console.log("project timeline draft apply tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
