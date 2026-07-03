#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = "/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm";
const defaultDatabase = path.join(repoRoot, "data", "local.db");

const args = process.argv.slice(2);

function valueAfter(flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

const checkOnly = args.includes("--check");
const allowSeedDb = args.includes("--allow-seed-db");
const hostname = valueAfter("--hostname", "0.0.0.0");
const port = valueAfter("--port", "3000");
const databasePath = path.resolve(valueAfter("--database", process.env.DATABASE_PATH || defaultDatabase));

function run(command, runArgs, options = {}) {
  const result = spawnSync(command, runArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    ...options,
  });

  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function packageName() {
  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson.name;
}

function sqliteCount(table, dbPath = databasePath) {
  const result = run("sqlite3", [dbPath, `SELECT COUNT(*) FROM ${table};`]);
  if (result.status !== 0) {
    fail(`Could not read ${table} from ${dbPath}: ${result.stderr || result.stdout}`);
  }
  const count = Number.parseInt(result.stdout, 10);
  return Number.isFinite(count) ? count : 0;
}

function latestD1ProjectCount() {
  const latestSql = path.join(backupRoot, "d1", "latest.sql");
  if (!fs.existsSync(latestSql)) return null;
  const result = run("rg", ["-c", "INSERT INTO \"projects\"", latestSql]);
  if (result.status !== 0 && result.status !== 1) return null;
  const count = Number.parseInt(result.stdout, 10);
  return Number.isFinite(count) ? count : 0;
}

function portListener() {
  const result = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.status !== 0 || !result.stdout) return null;
  const pid = result.stdout.split(/\s+/)[0];
  const cwdResult = run("lsof", ["-p", pid]);
  const cwdLine = cwdResult.stdout
    .split("\n")
    .find((line) => line.includes(" cwd "));
  const cwd = cwdLine?.match(/\s(\/.*)$/)?.[1] || null;
  const command = run("ps", ["-o", "command=", "-p", pid]).stdout || null;
  return { pid, cwd, command };
}

function preflight() {
  if (packageName() !== "reese-photography-crm") {
    fail(`Wrong repo: expected package name reese-photography-crm in ${repoRoot}.`);
  }

  if (!fs.existsSync(databasePath)) {
    fail(`Local Studio database is missing at ${databasePath}. Run npm run db:restore-local:d1 -- --yes.`);
  }

  const counts = {
    projects: sqliteCount("projects"),
    clients: sqliteCount("clients"),
    schedulerBookings: sqliteCount("scheduler_bookings"),
  };
  const d1Projects = latestD1ProjectCount();

  if (!allowSeedDb && counts.projects <= 1 && d1Projects !== null && d1Projects > 1) {
    fail(
      `Local database only has ${counts.projects} project, but latest D1 backup has ${d1Projects}. ` +
        "Run npm run db:restore-local:d1 -- --yes, or pass --allow-seed-db if this is intentional.",
    );
  }

  const listener = portListener();
  if (listener && listener.cwd && path.resolve(listener.cwd) !== repoRoot) {
    fail(
      `Port ${port} is already serving another app from ${listener.cwd} (pid ${listener.pid}). ` +
        `Stop that process or choose another port with --port before opening Studio.`,
    );
  }

  console.log(
    `Studio preflight OK: ${counts.projects} projects, ${counts.clients} clients, ` +
      `${counts.schedulerBookings} bookings, database=${databasePath}.`,
  );

  if (listener) {
    console.log(`Port ${port} is already occupied by this repo (pid ${listener.pid}).`);
  }

  return { listener };
}

const { listener } = preflight();

if (checkOnly) process.exit(0);

if (listener) {
  fail(`Refusing to start a second Studio dev server on port ${port}.`);
}

const child = spawn("npx", ["next", "dev", "--hostname", hostname, "--port", port], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_PATH: databasePath,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
