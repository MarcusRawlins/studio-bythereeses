import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-projects-page-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { default: ProjectsPage } = await import("./page");
  const database = rawDb();
  const now = "2026-05-31T12:00:00.000Z";

  const insertClient = database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const insertParticipant = database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES (?, ?, ?, 'primary', 1, ?)
  `);

  for (let index = 1; index <= 55; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const projectId = `project-${suffix}`;
    const clientId = `client-${suffix}`;
    const stage = index === 1 ? "planning" : "inquiry";
    const projectName = index === 1 ? "Alex Wedding" : `Pagination Wedding ${suffix}`;
    insertClient.run(clientId, index === 1 ? "Alex" : `Client ${suffix}`, index === 1 ? "Taylor" : "Reese", `client-${suffix}@example.com`, now, now);
    insertProject.run(projectId, projectName, "wedding", stage, `2026-09-${suffix}`, now, now);
    if (index !== 55) {
      insertParticipant.run(`participant-${suffix}`, projectId, clientId, now);
    }
  }

  const fullMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ notice: "seed-data-removed" }),
  }));
  assert.match(fullMarkup, /55 canonical projects loaded/);
  assert.match(fullMarkup, /Alex &amp; Taylor seed project/);
  assert.match(fullMarkup, /Alex Wedding/);
  assert.match(fullMarkup, /Pagination Wedding 55/);
  assert.doesNotMatch(fullMarkup, /Projects pagination/);
  assert.match(fullMarkup, /Filter/);
  assert.doesNotMatch(fullMarkup, /Project filters/);
  assert.doesNotMatch(fullMarkup, /Rows per page/);

  const secondPageMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ page: "2", q: "wedding", sort: "name", stages: "inquiry", pageSize: "50" }),
  }));
  assert.match(secondPageMarkup, /Showing 51-54 of 54 canonical projects/);
  assert.match(secondPageMarkup, /Pagination Wedding 55/);
  assert.match(secondPageMarkup, /Needs primary client/);
  assert.match(secondPageMarkup, /href="\/projects\?q=wedding&amp;sort=name&amp;stages=inquiry&amp;pageSize=50"/);

  const expandedMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ pageSize: "200" }),
  }));
  assert.match(expandedMarkup, /55 canonical projects loaded/);
  assert.match(expandedMarkup, /Pagination Wedding 55/);
  assert.doesNotMatch(expandedMarkup, /Projects pagination/);

  const filteredMarkup = renderToStaticMarkup(await ProjectsPage({
    searchParams: Promise.resolve({ q: "no match" }),
  }));
  assert.match(filteredMarkup, /0 of 55 canonical projects shown/);
  assert.match(filteredMarkup, /Clear filters/);

  console.log("projects page tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
