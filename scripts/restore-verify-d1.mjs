#!/usr/bin/env node
// Ops drill: verify that the latest D1 backup SQL actually restores into a
// usable database before we ever need it for a real recovery. This is a thin
// wrapper around scripts/restore-local-from-d1-backup.mjs — it always targets
// a THROWAWAY database (default /tmp/d1-restore-drill.db), never data/local.db
// and never a production/remote database. No production side effects.
//
// Usage:
//   npm run drill:restore
//   npm run drill:restore -- --source /path/to/backup.sql --database /tmp/other-drill.db
//   npm run drill:restore -- --min-projects 150 --min-clients 150
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = "/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm";
const defaultSource = path.join(backupRoot, "d1", "latest.sql");
const defaultDatabase = "/tmp/d1-restore-drill.db";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// Studio tables that must exist in a restored export for it to be usable.
// Kept intentionally small/stable — this is a smoke-level drill, not a full
// schema diff (see docs/ops-stabilization-checklist.md "Backup / Restore Drill").
export const REQUIRED_STUDIO_TABLES = [
  "projects",
  "clients",
  "scheduler_bookings",
  "invoices",
  "proposals",
  "activity_logs",
];

// Minimum row-count thresholds. These intentionally stay low (>0) by default
// so the drill is meaningful in any environment; pass --min-projects /
// --min-clients (or a stricter baseline from the latest production smoke
// counts) for a tighter quarterly check.
export const DEFAULT_THRESHOLDS = {
  projects: 1,
  clients: 1,
};

export function evaluateThresholds(counts, thresholds = DEFAULT_THRESHOLDS) {
  const failures = [];
  for (const [table, minimum] of Object.entries(thresholds)) {
    const value = counts?.[table];
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
      failures.push(`${table} count ${value ?? "missing"} is below required minimum ${minimum}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function evaluateTablesExist(tableExistence, requiredTables = REQUIRED_STUDIO_TABLES) {
  const missing = requiredTables.filter((table) => !tableExistence?.[table]);
  return { ok: missing.length === 0, missing };
}

export function buildDrillReport({
  createdAt,
  source,
  databasePath,
  counts,
  tableExistence,
  thresholdResult,
  tablesResult,
  restoreStep,
}) {
  return {
    createdAt,
    source,
    databasePath,
    restore: restoreStep,
    counts,
    tables: tableExistence,
    thresholds: thresholdResult,
    tablesCheck: tablesResult,
    ok: Boolean(restoreStep?.ok) && thresholdResult.ok && tablesResult.ok,
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function run(command, runArgs, options = {}) {
  const result = spawnSync(command, runArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
    ...options,
  });
  return {
    command: [command, ...runArgs].join(" "),
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function sqlite(dbPath, sql) {
  const result = run("sqlite3", [dbPath, sql]);
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed for ${dbPath}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseCount(dbPath, table) {
  const output = sqlite(dbPath, `SELECT COUNT(*) FROM ${table};`);
  const count = Number.parseInt(output, 10);
  return Number.isFinite(count) ? count : 0;
}

function tableExists(dbPath, table) {
  const output = sqlite(dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}';`);
  return output.trim() === table;
}

// Always start from a clean throwaway database file. This keeps the drill
// idempotent across repeated runs and avoids the "back up existing database"
// branch inside restore-local-from-d1-backup.mjs, so the drill never writes
// anything besides its own stamped report.
function removeThrowawayDatabase(databasePath) {
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function runRestoreIntoThrowawayDatabase({ source, databasePath }) {
  const result = run("node", [
    "scripts/restore-local-from-d1-backup.mjs",
    "--source",
    source,
    "--database",
    databasePath,
    "--yes",
  ]);
  return {
    ok: result.status === 0,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeReport(report) {
  const dir = path.join(backupRoot, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, `restore-verify-d1-${stamp}.json`);
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  return destination;
}

async function main() {
  const args = process.argv.slice(2);
  const source = path.resolve(valueAfter(args, "--source") || defaultSource);
  const databasePath = path.resolve(valueAfter(args, "--database") || defaultDatabase);
  const minProjects = Number.parseInt(valueAfter(args, "--min-projects") || "", 10);
  const minClients = Number.parseInt(valueAfter(args, "--min-clients") || "", 10);
  const thresholds = {
    projects: Number.isFinite(minProjects) ? minProjects : DEFAULT_THRESHOLDS.projects,
    clients: Number.isFinite(minClients) ? minClients : DEFAULT_THRESHOLDS.clients,
  };
  const createdAt = new Date().toISOString();

  if (!fs.existsSync(source)) {
    console.error(`D1 backup SQL not found: ${source}`);
    process.exit(1);
    return;
  }

  removeThrowawayDatabase(databasePath);
  const restoreStep = runRestoreIntoThrowawayDatabase({ source, databasePath });

  if (!restoreStep.ok) {
    const failedReport = buildDrillReport({
      createdAt,
      source,
      databasePath,
      counts: {},
      tableExistence: {},
      thresholdResult: { ok: false, failures: ["restore step failed; see restore.stderr"] },
      tablesResult: { ok: false, missing: REQUIRED_STUDIO_TABLES },
      restoreStep,
    });
    const destination = writeReport(failedReport);
    console.error(`Restore drill FAILED (restore step). Report: ${destination}`);
    if (restoreStep.stderr) console.error(restoreStep.stderr);
    process.exit(1);
    return;
  }

  const tableExistence = {};
  for (const table of REQUIRED_STUDIO_TABLES) {
    tableExistence[table] = tableExists(databasePath, table);
  }

  const counts = {};
  for (const table of Object.keys(thresholds)) {
    counts[table] = tableExistence[table] ? parseCount(databasePath, table) : 0;
  }

  const thresholdResult = evaluateThresholds(counts, thresholds);
  const tablesResult = evaluateTablesExist(tableExistence, REQUIRED_STUDIO_TABLES);

  const finalReport = buildDrillReport({
    createdAt,
    source,
    databasePath,
    counts,
    tableExistence,
    thresholdResult,
    tablesResult,
    restoreStep,
  });

  const destination = writeReport(finalReport);

  if (!finalReport.ok) {
    console.error(`Restore verification FAILED. Report: ${destination}`);
    if (thresholdResult.failures.length) console.error(thresholdResult.failures.join("\n"));
    if (tablesResult.missing.length) console.error(`Missing tables: ${tablesResult.missing.join(", ")}`);
    process.exit(1);
    return;
  }

  console.log(
    `Restore verification passed. projects=${counts.projects}, clients=${counts.clients}. Report: ${destination}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
