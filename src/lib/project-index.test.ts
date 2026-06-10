import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-project-index-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { listProjectIndex } = await import("./crm");
  const database = rawDb();
  const now = "2026-06-01T12:00:00.000Z";

  const insertClient = database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, venue_name, created_at, updated_at)
    VALUES (?, ?, 'wedding', ?, ?, ?, ?, ?, ?)
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES (?, ?, ?, 'primary', 1, ?)
  `);

  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const projectId = `project-${suffix}`;
    const clientId = `client-${suffix}`;
    const stage = index === 1 ? "planning" : "inquiry";
    insertClient.run(clientId, `Client ${suffix}`, "Reese", `client-${suffix}@example.com`, now, now);
    const status = index === 11 ? "archived" : "active";
    insertProject.run(projectId, `Project ${suffix}`, stage, status, `2026-09-${suffix}`, `Venue ${suffix}`, now, now);
    if (index !== 12) {
      insertParticipant.run(`participant-${suffix}`, projectId, clientId, now);
    }
  }

  const secondPage = await listProjectIndex({ page: 2, pageSize: 5, sort: "eventDate" });
  assert.equal(secondPage.totalCount, 11);
  assert.equal(secondPage.filteredCount, 11);
  assert.equal(secondPage.currentPage, 2);
  assert.equal(secondPage.totalPages, 3);
  assert.equal(secondPage.rangeStart, 6);
  assert.equal(secondPage.rangeEnd, 10);
  assert.deepEqual(secondPage.rows.map((row) => row.project.name), [
    "Project 06",
    "Project 07",
    "Project 08",
    "Project 09",
    "Project 10",
  ]);

  const filtered = await listProjectIndex({ q: "venue 12", stages: ["inquiry"], page: 5, pageSize: 10, sort: "name" });
  assert.equal(filtered.totalCount, 11);
  assert.equal(filtered.filteredCount, 1);
  assert.equal(filtered.currentPage, 1);
  assert.equal(filtered.totalPages, 1);
  assert.equal(filtered.rangeStart, 1);
  assert.equal(filtered.rangeEnd, 1);
  assert.equal(filtered.rows[0].project.name, "Project 12");
  assert.equal(filtered.rows[0].client, null);

  const expanded = await listProjectIndex({ pageSize: 200 });
  assert.equal(expanded.pageSize, 200);
  assert.equal(expanded.totalPages, 1);
  assert.equal(expanded.rows.length, 11);
  assert.equal(expanded.rows.some((row) => row.project.name === "Project 11"), false);

  console.log("project index tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
