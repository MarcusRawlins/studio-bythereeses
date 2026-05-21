#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = "/Volumes/reeseai-memory/backups/reese-photography-crm";
const mirrorRoot = "/Volumes/reeseai-memory/code/reese-photography-crm";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const dirs = {
  d1: path.join(backupRoot, "d1"),
  logs: path.join(backupRoot, "logs"),
  manifests: path.join(backupRoot, "manifests"),
  reconciliations: path.join(backupRoot, "reconciliations"),
  sqlite: path.join(backupRoot, "sqlite"),
};

const manifest = {
  createdAt: new Date().toISOString(),
  backupRoot,
  mirrorRoot,
  repoRoot,
  steps: {},
  warnings: [],
  errors: [],
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    ...options,
  });

  return {
    command: [command, ...args].join(" "),
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function getGitInfo() {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const status = run("git", ["status", "--short"]);

  manifest.git = {
    branch: branch.status === 0 ? branch.stdout : null,
    head: head.status === 0 ? head.stdout : null,
    statusShort: status.status === 0 ? status.stdout : null,
  };
}

function getTokenFromPrivateEnvFile() {
  const envPath = path.join(os.homedir(), ".reese-crm-backup.env");
  if (!fs.existsSync(envPath)) return "";

  const contents = fs.readFileSync(envPath, "utf8");
  const match = contents.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
}

function getTokenFromKeychain() {
  if (process.platform !== "darwin") return "";

  const result = spawnSync(
    "security",
    [
      "find-generic-password",
      "-a",
      os.userInfo().username,
      "-s",
      "reese-crm-cloudflare-api-token",
      "-w",
    ],
    { encoding: "utf8" },
  );

  return result.status === 0 ? result.stdout.trim() : "";
}

function getCloudflareToken() {
  return (
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
    getTokenFromKeychain() ||
    getTokenFromPrivateEnvFile()
  );
}

function mirrorCode() {
  ensureDir(mirrorRoot);

  const result = run("rsync", [
    "-a",
    "--exclude",
    "node_modules",
    "--exclude",
    ".next",
    "--exclude",
    ".open-next",
    "--exclude",
    ".wrangler",
    "--exclude",
    "data",
    "--exclude",
    ".env",
    "--exclude",
    ".env.*",
    "--exclude",
    ".DS_Store",
    `${repoRoot}/`,
    `${mirrorRoot}/`,
  ]);

  manifest.steps.codeMirror = {
    ok: result.status === 0,
    destination: mirrorRoot,
    stderr: result.stderr,
  };

  if (result.status !== 0) {
    manifest.errors.push(`Code mirror failed: ${result.stderr || result.stdout}`);
  }
}

async function backupLocalSqlite() {
  const source = process.env.DATABASE_PATH || path.join(repoRoot, "data", "local.db");
  if (!fs.existsSync(source)) {
    const warning = `Local SQLite database not found at ${source}; skipped local DB backup.`;
    manifest.warnings.push(warning);
    manifest.steps.localSqlite = { ok: true, skipped: true, source };
    return;
  }

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(source);
  db.pragma("wal_checkpoint(TRUNCATE)");

  ensureDir(dirs.sqlite);
  const destination = path.join(dirs.sqlite, `local-${stamp}.db`);
  const tempDestination = path.join(os.tmpdir(), `reese-crm-local-${stamp}.db`);

  try {
    await db.backup(tempDestination);
    fs.copyFileSync(tempDestination, destination);
  } finally {
    db.close();
    fs.rmSync(tempDestination, { force: true });
  }

  const latest = path.join(dirs.sqlite, "latest.db");
  fs.copyFileSync(destination, latest);

  manifest.steps.localSqlite = {
    ok: true,
    source,
    destination,
    latest,
    bytes: fs.statSync(destination).size,
  };
}

function exportD1() {
  const token = getCloudflareToken();
  if (!token) {
    const warning =
      "Cloudflare D1 export skipped because no token was available in CLOUDFLARE_API_TOKEN, Keychain, or ~/.reese-crm-backup.env.";
    manifest.warnings.push(warning);
    manifest.steps.d1 = { ok: true, skipped: true };
    return;
  }

  const output = path.join(dirs.d1, `studio-bythereeses-${stamp}.sql`);
  const result = run(
    "npx",
    [
      "wrangler",
      "d1",
      "export",
      "studio-bythereeses",
      "--remote",
      "--output",
      output,
      "--skip-confirmation",
    ],
    {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
      },
    },
  );

  manifest.steps.d1 = {
    ok: result.status === 0,
    destination: output,
    latest: path.join(dirs.d1, "latest.sql"),
    stderr: result.stderr ? result.stderr.replaceAll(token, "[redacted]") : "",
  };

  if (result.status !== 0) {
    manifest.errors.push(
      `Cloudflare D1 export failed: ${(result.stderr || result.stdout).replaceAll(token, "[redacted]")}`,
    );
    return;
  }

  fs.copyFileSync(output, path.join(dirs.d1, "latest.sql"));
  manifest.steps.d1.bytes = fs.statSync(output).size;
}

function writeManifest() {
  const manifestPath = path.join(dirs.manifests, `backup-${stamp}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Backup manifest written to ${manifestPath}`);
  if (manifest.warnings.length) {
    console.warn(`Warnings: ${manifest.warnings.join(" | ")}`);
  }
}

for (const dir of Object.values(dirs)) ensureDir(dir);
getGitInfo();
mirrorCode();
await backupLocalSqlite();
exportD1();
writeManifest();

if (manifest.errors.length) {
  console.error(manifest.errors.join("\n"));
  process.exit(1);
}
