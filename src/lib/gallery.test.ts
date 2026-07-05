import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-gallery-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function main() {
  const { rawDb } = await import("@/db/client");
  const {
    normalizeGalleryUrl,
    inferProviderLabel,
    createProjectGallery,
    updateProjectGallery,
    deleteProjectGallery,
    attachProjectGalleryFromAgent,
  } = await import("./gallery");
  const database = rawDb();
  const now = "2026-05-29T12:00:00.000Z";

  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, created_at, updated_at)
    VALUES ('project-1', 'Gallery Wedding', 'wedding', 'editing', 'active', ?, ?)
  `).run(now, now);

  // ---------------------------------------------------------------------
  // normalizeGalleryUrl — URL safety / XSS reject list (§8, highest priority)
  // ---------------------------------------------------------------------

  const accepted = normalizeGalleryUrl("https://client.pixieset.com/gallery/wedding");
  assert.equal(new URL(accepted).protocol, "https:");
  assert.equal(new URL(accepted).hostname, "client.pixieset.com");

  const rejections: Array<[string, string]> = [
    ["javascript:alert(1)", "javascript scheme"],
    ["JaVaScRiPt:alert(1)", "mixed-case javascript scheme"],
    ["  javascript:alert(1)", "leading-whitespace javascript scheme"],
    ["java\tscript:alert(1)", "tab-embedded javascript scheme"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["vbscript:msgbox(1)", "vbscript scheme"],
    ["http://example.com/gallery", "non-tls http scheme"],
    ["https://user:pass@host.com/g", "embedded credentials"],
    ["file:///etc/passwd", "file scheme"],
    [`https://example.com/${"a".repeat(2100)}`, "over-length URL"],
    ["not a url at all", "unparseable string"],
    ["https://localhost/gallery", "hostless dotless host"],
  ];

  for (const [raw, label] of rejections) {
    assert.throws(() => normalizeGalleryUrl(raw), undefined, `expected rejection for ${label}`);
  }

  // ---------------------------------------------------------------------
  // inferProviderLabel — soft allowlist, never throws/rejects
  // ---------------------------------------------------------------------

  assert.equal(inferProviderLabel("https://client.pixieset.com/gallery"), "Pixieset");
  assert.equal(inferProviderLabel("https://pixieset.com/gallery"), "Pixieset");
  assert.equal(inferProviderLabel("https://studio.pic-time.com/g"), "Pic-Time");
  assert.equal(inferProviderLabel("https://res.cloudinary.com/g"), "Cloudinary");
  assert.equal(inferProviderLabel("https://gallery.brand.com/g"), null);
  assert.equal(inferProviderLabel("not a url"), null);

  // ---------------------------------------------------------------------
  // createProjectGallery — timestamps, expiresAt, deliveredAt, field caps
  // ---------------------------------------------------------------------

  const created = await createProjectGallery({
    projectId: "project-1",
    title: "Engagement gallery",
    url: "https://client.pixieset.com/engagement",
    status: "draft",
    expiresAt: "2026-12-01",
  });
  assert.match(created.createdAt, ISO_SHAPE, "createdAt is ISO, not SQL CURRENT_TIMESTAMP shape");
  assert.match(created.updatedAt, ISO_SHAPE, "updatedAt is ISO, not SQL CURRENT_TIMESTAMP shape");
  assert.equal(created.status, "draft");
  assert.equal(created.deliveredAt, null, "draft gallery has no deliveredAt");
  assert.equal(created.provider, "Pixieset", "provider inferred from host when not supplied");
  assert.match(created.expiresAt ?? "", ISO_SHAPE, "expiresAt normalizes to ISO");

  await assert.rejects(
    () => createProjectGallery({ projectId: "project-1", title: "Bad expiry", url: "https://client.pixieset.com/g2", expiresAt: "not a date" }),
    /valid date/,
  );
  await assert.rejects(
    () => createProjectGallery({ projectId: "project-1", title: "a".repeat(201), url: "https://client.pixieset.com/g3" }),
    /too long/,
  );
  await assert.rejects(
    () => createProjectGallery({ projectId: "project-1", title: "Long provider", url: "https://client.pixieset.com/g4", provider: "a".repeat(81) }),
    /too long/,
  );
  await assert.rejects(
    () => createProjectGallery({ projectId: "project-1", title: "Long passcode", url: "https://client.pixieset.com/g5", passcode: "a".repeat(201) }),
    /too long/,
  );

  const deliveredOnCreate = await createProjectGallery({
    projectId: "project-1",
    title: "Wedding gallery",
    url: "https://client.pixieset.com/wedding",
    status: "delivered",
    // Hostile/unexpected extra field — deliveredAt is not part of
    // CreateProjectGalleryInput at all, so even a caller that tries to smuggle
    // one in cannot influence the stored value.
    ...({ deliveredAt: "2020-01-01T00:00:00.000Z" } as Record<string, unknown>),
  });
  assert.notEqual(deliveredOnCreate.deliveredAt, "2020-01-01T00:00:00.000Z", "deliveredAt is never taken from caller input");
  assert.match(deliveredOnCreate.deliveredAt ?? "", ISO_SHAPE, "deliveredAt set server-side when status starts delivered");

  // ---------------------------------------------------------------------
  // updateProjectGallery — deliveredAt transition + stability, activity log
  // ---------------------------------------------------------------------

  const activityCountBeforeUpdate = (database.prepare(
    "SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'gallery.updated'",
  ).get() as { count: number }).count;
  assert.equal(activityCountBeforeUpdate, 0);

  const delivered = await updateProjectGallery({
    projectId: "project-1",
    galleryId: created.id,
    status: "delivered",
  });
  assert.match(delivered.deliveredAt ?? "", ISO_SHAPE, "deliveredAt set the first time status becomes delivered");

  const deliveredAtAfterFirstDelivery = delivered.deliveredAt;

  const editedAgain = await updateProjectGallery({
    projectId: "project-1",
    galleryId: created.id,
    title: "Engagement gallery (final)",
  });
  assert.equal(editedAgain.deliveredAt, deliveredAtAfterFirstDelivery, "deliveredAt stays stable across later edits");
  assert.equal(editedAgain.title, "Engagement gallery (final)");

  assert.deepEqual(
    database.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'gallery.updated'").get(),
    { count: 2 },
  );

  await assert.rejects(
    () => updateProjectGallery({ projectId: "other-project", galleryId: created.id, title: "Hijack" }),
    /not found/i,
    "cross-project gallery id must be rejected",
  );

  // ---------------------------------------------------------------------
  // deleteProjectGallery — round trip + activity log
  // ---------------------------------------------------------------------

  await deleteProjectGallery({ projectId: "project-1", galleryId: created.id, actorType: "admin", actorName: "Tyler" });
  const afterDelete = database.prepare("SELECT COUNT(*) AS count FROM project_galleries WHERE id = ?").get(created.id) as { count: number };
  assert.equal(afterDelete.count, 0);
  assert.deepEqual(
    database.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE action = 'gallery.deleted'").get(),
    { count: 1 },
  );

  // ---------------------------------------------------------------------
  // Agent-authority guard (§5.4 / Active-Learning Log) — a hostile/elevated
  // agent body can NEVER mint a client-visible gallery.
  // ---------------------------------------------------------------------

  const hostileInput = {
    title: "Hostile client delivery",
    url: "https://client.pixieset.com/hostile",
    status: "delivered",
    createdBy: "admin",
  };
  const agentGallery = await attachProjectGalleryFromAgent("project-1", hostileInput as never);
  assert.equal(agentGallery.status, "draft", "agent attach is forced to draft regardless of input");
  assert.equal(agentGallery.createdBy, "agent", "agent attach is forced to createdBy=agent regardless of input");

  const deliveredByAgentCount = database.prepare(
    "SELECT COUNT(*) AS count FROM project_galleries WHERE status = 'delivered' AND created_by = 'agent'",
  ).get() as { count: number };
  assert.equal(deliveredByAgentCount.count, 0, "the agent tool must create zero client-visible (delivered) galleries");

  const agentCreatedActivity = database.prepare(
    "SELECT actor_type AS actorType FROM activity_logs WHERE action = 'gallery.created' ORDER BY created_at DESC LIMIT 1",
  ).get() as { actorType: string };
  assert.equal(agentCreatedActivity.actorType, "agent");

  console.log("gallery tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
