import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-honeybook-import-"));
process.env.DATABASE_PATH = path.join(tempDir, "local.db");

async function main() {
  const { rawDb } = await import("@/db/client");
  const { importHoneyBookProjectsFromCsv } = await import("./honeybook-import");
  const database = rawDb();
  const now = "2026-06-01T00:00:00.000Z";
  const csvPath = path.join(tempDir, "honeybook-projects.csv");

  database.prepare(`
    INSERT INTO clients (id, first_name, last_name, email, created_at, updated_at)
    VALUES
      ('client-bailey', 'Bailey', 'Bickley', 'babickley92@gmail.com', ?, ?),
      ('client-sam', 'Samantha', 'Fox', 'foxhensonwedding@gmail.com', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO projects (id, name, type, stage, status, event_date, budget_cents, created_at, updated_at)
    VALUES ('project-sam', 'Sam & Matthew Wedding', 'wedding', 'retainer_paid', 'active', '2026-06-05', 540000, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO project_participants (id, project_id, client_id, role, is_primary_contact, created_at)
    VALUES ('participant-sam', 'project-sam', 'client-sam', 'primary', 1, ?)
  `).run(now);

  fs.writeFileSync(csvPath, [
    "Company Name,Project Name,Booked (yes/no),Project Owner,Team Members,Client Info,Project Type,Lead Source,Project Creation Date,Booked Date,Project Date,Number of files sent,Total Project Value,Tax,Total Paid,Gratuity,Refunded Amount",
    "The Reese's,Bailey Bickley's Project,No,Alex & Tyler Reese hello@bythereeses.com,,Bailey Bickley babickley92@gmail.com,Wedding,Instagram,2026-01-27 12:00:00 UTC,,2026-06-12,0,0.00,0.00,0.00,0.00,0.00",
    "The Reese's,Bailey Bickley's Project,No,Alex & Tyler Reese hello@bythereeses.com,,Bailey Bickley babickley92@gmail.com,Wedding,Instagram,2026-01-27 12:00:00 UTC,,2026-06-12,0,0.00,0.00,0.00,0.00,0.00",
    "The Reese's,Sam & Matthew,Yes,Alex & Tyler Reese hello@bythereeses.com,,Samantha Fox foxhensonwedding@gmail.com,Wedding,Other,2026-01-14 12:00:00 UTC,2026-02-01 12:00:00 UTC,2026-06-05,0,5400.00,0.00,1000.00,0.00,0.00",
    "The Reese's,Old Lead,No,Alex & Tyler Reese hello@bythereeses.com,,Old Lead old@example.com,Wedding,Instagram,2026-01-01 12:00:00 UTC,,2026-05-01,0,0.00,0.00,0.00,0.00,0.00",
  ].join("\n"));

  const preview = await importHoneyBookProjectsFromCsv({
    filePath: csvPath,
    cutoffDate: "2026-06-01",
    apply: false,
    now,
  });

  assert.equal(preview.scannedRows, 4);
  assert.equal(preview.importedCount, 0);
  assert.deepEqual(preview.candidates.map((candidate) => candidate.projectName), ["Bailey Bickley's Project"]);
  assert.deepEqual(preview.skippedCounts, {
    beforeCutoff: 1,
    duplicateExportRow: 1,
    existingProject: 1,
    missingClientEmail: 0,
    invalidEventDate: 0,
  });

  const applied = await importHoneyBookProjectsFromCsv({
    filePath: csvPath,
    cutoffDate: "2026-06-01",
    apply: true,
    now,
  });

  assert.equal(applied.importedCount, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM projects").get().count, 2);

  const baileyProject = database.prepare(`
    SELECT p.name, p.type, p.stage, p.status, p.event_date, p.budget_cents, pp.client_id, pp.is_primary_contact
    FROM projects p
    INNER JOIN project_participants pp ON pp.project_id = p.id
    WHERE p.name = 'Bailey Bickley''s Project'
  `).get();
  assert.deepEqual(baileyProject, {
    name: "Bailey Bickley's Project",
    type: "wedding",
    stage: "inquiry",
    status: "active",
    event_date: "2026-06-12",
    budget_cents: null,
    client_id: "client-bailey",
    is_primary_contact: 1,
  });

  const source = database.prepare(`
    SELECT kind, title, source_type, source_id, metadata_json
    FROM project_sources
    WHERE project_id = ?
  `).get(applied.imported[0].projectId);
  assert.equal(source.kind, "honeybook_import");
  assert.equal(source.title, "HoneyBook project export row");
  assert.equal(source.source_type, "honeybook_project_report");
  assert.equal(JSON.parse(source.metadata_json).leadSource, "Instagram");

  const activity = database.prepare(`
    SELECT action, actor_type, actor_name
    FROM activity_logs
    WHERE project_id = ?
  `).get(applied.imported[0].projectId);
  assert.deepEqual(activity, {
    action: "project.created_by_agent",
    actor_type: "agent",
    actor_name: "The Reeses Studio Agent",
  });

  console.log("honeybook import tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
