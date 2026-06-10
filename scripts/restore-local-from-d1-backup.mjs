#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = "/Volumes/reeseai-memory/backups/reese-photography-crm";
const defaultSource = path.join(backupRoot, "d1", "latest.sql");
const defaultDatabase = path.join(repoRoot, "data", "local.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const args = process.argv.slice(2);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

const source = path.resolve(valueAfter("--source") || defaultSource);
const databasePath = path.resolve(valueAfter("--database") || process.env.DATABASE_PATH || defaultDatabase);
const dryRun = args.includes("--dry-run");
const confirmed = args.includes("--yes");

const report = {
  createdAt: new Date().toISOString(),
  source,
  databasePath,
  dryRun,
  steps: {},
  warnings: [],
};

function fail(message) {
  console.error(message);
  process.exit(1);
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
    fail(`sqlite3 failed for ${dbPath}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseCount(dbPath, table) {
  const output = sqlite(dbPath, `SELECT COUNT(*) FROM ${table};`);
  const count = Number.parseInt(output, 10);
  return Number.isFinite(count) ? count : 0;
}

function assertLooksLikeStudioExport(sqlPath) {
  if (!fs.existsSync(sqlPath)) fail(`D1 backup SQL not found: ${sqlPath}`);
  const header = fs.readFileSync(sqlPath, "utf8").slice(0, 512 * 1024);
  const required = ["CREATE TABLE projects", "CREATE TABLE clients", "CREATE TABLE scheduler_bookings"];
  const missing = required.filter((needle) => !header.includes(needle));
  if (missing.length) {
    fail(`Backup SQL does not look like a Studio D1 export. Missing: ${missing.join(", ")}`);
  }
}

async function backupExistingDatabase() {
  if (!fs.existsSync(databasePath)) {
    report.steps.existingBackup = { ok: true, skipped: true, reason: "database does not exist" };
    return null;
  }

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(databasePath);
  db.pragma("wal_checkpoint(TRUNCATE)");

  const destinationDir = path.join(backupRoot, "sqlite");
  fs.mkdirSync(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, `local-before-d1-restore-${stamp}.db`);
  const tempDestination = path.join(os.tmpdir(), `reese-crm-local-before-d1-restore-${stamp}.db`);

  try {
    await db.backup(tempDestination);
    fs.copyFileSync(tempDestination, destination);
  } finally {
    db.close();
    fs.rmSync(tempDestination, { force: true });
  }

  report.steps.existingBackup = {
    ok: true,
    destination,
    bytes: fs.statSync(destination).size,
  };
  return destination;
}

function importSqlToTempDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reese-crm-d1-restore-"));
  const tempDb = path.join(tempDir, "restore.db");
  fs.rmSync(tempDb, { force: true });

  const result = run("sqlite3", [tempDb], {
    input: fs.readFileSync(source, "utf8"),
  });
  if (result.status !== 0) {
    fs.rmSync(tempDb, { force: true });
    fail(`Could not import D1 backup into temp SQLite database: ${result.stderr || result.stdout}`);
  }

  const counts = {
    projects: parseCount(tempDb, "projects"),
    clients: parseCount(tempDb, "clients"),
    schedulerBookings: parseCount(tempDb, "scheduler_bookings"),
  };
  if (counts.projects < 1 || counts.clients < 1) {
    fs.rmSync(tempDb, { force: true });
    fail(`Imported backup has suspicious counts: ${JSON.stringify(counts)}`);
  }

  report.steps.importPreview = {
    ok: true,
    tempDb,
    counts,
    bytes: fs.statSync(tempDb).size,
  };
  return { tempDb, tempDir };
}

function replaceLocalDatabase(tempDb) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
  fs.copyFileSync(tempDb, databasePath);
  report.steps.replaceLocal = {
    ok: true,
    bytes: fs.statSync(databasePath).size,
  };
}

function migrateLocalDatabase() {
  const result = run("npm", ["run", "db:migrate"], {
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
    },
  });
  report.steps.migrate = {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.status !== 0) fail(`Migration failed: ${result.stderr || result.stdout}`);
}

function finalCounts() {
  report.finalCounts = {
    projects: parseCount(databasePath, "projects"),
    clients: parseCount(databasePath, "clients"),
    schedulerBookings: parseCount(databasePath, "scheduler_bookings"),
    invoices: parseCount(databasePath, "invoices"),
  };
}

function writeReport() {
  const dir = path.join(backupRoot, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, `restore-local-from-d1-${stamp}.json`);
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Restore report written to ${destination}`);
}

assertLooksLikeStudioExport(source);

if (!dryRun && !confirmed) {
  fail("Refusing to replace the local database without --yes. Use --dry-run to preview only.");
}

const { tempDb, tempDir } = importSqlToTempDatabase();

try {
  if (dryRun) {
    console.log(`Dry run OK: ${report.steps.importPreview.counts.projects} projects, ${report.steps.importPreview.counts.clients} clients.`);
  } else {
    const backupPath = await backupExistingDatabase();
    replaceLocalDatabase(tempDb);
    migrateLocalDatabase();
    finalCounts();
    console.log(
      `Restored ${databasePath} from ${source}. ` +
        `Projects=${report.finalCounts.projects}, clients=${report.finalCounts.clients}.` +
        (backupPath ? ` Previous DB backup: ${backupPath}` : ""),
    );
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  writeReport();
}
