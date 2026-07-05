import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  REQUIRED_STUDIO_TABLES,
  buildDrillReport,
  evaluateTablesExist,
  evaluateThresholds,
} from "./restore-verify-d1.mjs";

// Threshold pass: counts comfortably meet the configured minimums.
const passingThresholds = evaluateThresholds({ projects: 165, clients: 164 }, DEFAULT_THRESHOLDS);
assert.equal(passingThresholds.ok, true);
assert.deepEqual(passingThresholds.failures, []);

// Threshold pass exactly at the minimum boundary.
const boundaryThresholds = evaluateThresholds({ projects: 1, clients: 1 }, DEFAULT_THRESHOLDS);
assert.equal(boundaryThresholds.ok, true);

// Threshold fail: zero, missing, and below-minimum counts are all reported.
const failingThresholds = evaluateThresholds({ projects: 0, clients: undefined }, DEFAULT_THRESHOLDS);
assert.equal(failingThresholds.ok, false);
assert.equal(failingThresholds.failures.length, 2);
assert.match(failingThresholds.failures[0], /projects count 0 is below required minimum 1/);
assert.match(failingThresholds.failures[1], /clients count missing is below required minimum 1/);

// Configurable (stricter) thresholds, e.g. a recent production-smoke baseline.
const strictThresholds = evaluateThresholds({ projects: 100, clients: 100 }, { projects: 150, clients: 150 });
assert.equal(strictThresholds.ok, false);
assert.equal(strictThresholds.failures.length, 2);

// Table-existence pass.
const allTablesPresent = Object.fromEntries(REQUIRED_STUDIO_TABLES.map((table) => [table, true]));
const tablesPass = evaluateTablesExist(allTablesPresent);
assert.equal(tablesPass.ok, true);
assert.deepEqual(tablesPass.missing, []);

// Table-existence fail: reports exactly the missing table(s).
const missingOneTable = { ...allTablesPresent, invoices: false };
const tablesFailure = evaluateTablesExist(missingOneTable);
assert.equal(tablesFailure.ok, false);
assert.deepEqual(tablesFailure.missing, ["invoices"]);

// Report shape: ok is true only when the restore step, thresholds, and
// required tables all pass; the report always carries the same fixed keys.
const passingReport = buildDrillReport({
  createdAt: "2026-07-05T00:00:00.000Z",
  source: "/tmp/latest.sql",
  databasePath: "/tmp/d1-restore-drill.db",
  counts: { projects: 165, clients: 164 },
  tableExistence: allTablesPresent,
  thresholdResult: passingThresholds,
  tablesResult: tablesPass,
  restoreStep: { ok: true, command: "node scripts/restore-local-from-d1-backup.mjs", stdout: "", stderr: "" },
});
assert.equal(passingReport.ok, true);
assert.deepEqual(
  Object.keys(passingReport).sort(),
  ["counts", "createdAt", "databasePath", "ok", "restore", "source", "tables", "tablesCheck", "thresholds"].sort(),
);

// Report shape: threshold/table failure flips ok to false even if the
// underlying restore subprocess itself reported success.
const failingReport = buildDrillReport({
  createdAt: "2026-07-05T00:00:00.000Z",
  source: "/tmp/latest.sql",
  databasePath: "/tmp/d1-restore-drill.db",
  counts: { projects: 0, clients: 0 },
  tableExistence: missingOneTable,
  thresholdResult: evaluateThresholds({ projects: 0, clients: 0 }),
  tablesResult: tablesFailure,
  restoreStep: { ok: true, command: "node scripts/restore-local-from-d1-backup.mjs", stdout: "", stderr: "" },
});
assert.equal(failingReport.ok, false);

// Report shape: a failed restore subprocess also fails the report even when
// no counts/tables were evaluated yet.
const failedRestoreReport = buildDrillReport({
  createdAt: "2026-07-05T00:00:00.000Z",
  source: "/tmp/latest.sql",
  databasePath: "/tmp/d1-restore-drill.db",
  counts: {},
  tableExistence: {},
  thresholdResult: { ok: false, failures: ["restore step failed; see restore.stderr"] },
  tablesResult: { ok: false, missing: REQUIRED_STUDIO_TABLES },
  restoreStep: { ok: false, command: "node scripts/restore-local-from-d1-backup.mjs", stdout: "", stderr: "boom" },
});
assert.equal(failedRestoreReport.ok, false);

console.log("restore verify d1 tests passed");
