#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = "/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm";
const mirrorRoot = "/Volumes/reeseai-memory/04_Code/reese-photography-crm";
const today = new Date().toISOString().slice(0, 10);
const reportPath = path.join(backupRoot, "reconciliations", `${today}.md`);

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function fileInfo(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    ageHours: Math.round(((Date.now() - stat.mtimeMs) / 36e5) * 10) / 10,
  };
}

function latestManifest() {
  const dir = path.join(backupRoot, "manifests");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.startsWith("backup-") && file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function check(condition, label, detail, severity = "ok") {
  rows.push({ label, severity: condition ? "ok" : severity, detail });
  if (!condition && severity === "fail") failures.push(label);
  if (!condition && severity === "warn") warnings.push(label);
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const rows = [];
const failures = [];
const warnings = [];

const localHead = run("git", ["rev-parse", "HEAD"]).stdout;
const mirrorHead = fs.existsSync(path.join(mirrorRoot, ".git"))
  ? run("git", ["rev-parse", "HEAD"], mirrorRoot).stdout
  : "";

const latestLocalDb = fileInfo(path.join(backupRoot, "sqlite", "latest.db"));
const latestD1 = fileInfo(path.join(backupRoot, "d1", "latest.sql"));
const manifestPath = latestManifest();
const manifestInfo = manifestPath ? fileInfo(manifestPath) : { exists: false };

check(fs.existsSync(mirrorRoot), "Code mirror exists", mirrorRoot, "fail");
check(
  Boolean(localHead && mirrorHead && localHead === mirrorHead),
  "Code mirror matches local HEAD",
  `local=${localHead || "missing"} mirror=${mirrorHead || "missing"}`,
  "warn",
);
check(
  latestLocalDb.exists && latestLocalDb.bytes > 0,
  "Latest local SQLite backup exists",
  latestLocalDb.exists ? `${latestLocalDb.bytes} bytes, ${latestLocalDb.ageHours}h old` : "missing",
  "fail",
);
check(
  latestD1.exists && latestD1.bytes > 0,
  "Latest Cloudflare D1 export exists",
  latestD1.exists ? `${latestD1.bytes} bytes, ${latestD1.ageHours}h old` : "missing",
  "fail",
);
if (latestD1.exists && latestD1.bytes > 0) {
  check(
    latestD1.ageHours <= 36,
    "Latest Cloudflare D1 export is fresh",
    `${latestD1.bytes} bytes, ${latestD1.ageHours}h old`,
    "warn",
  );
}
check(
  manifestInfo.exists && manifestInfo.ageHours <= 36,
  "Recent daily backup manifest exists",
  manifestPath ? `${manifestPath}, ${manifestInfo.ageHours}h old` : "missing",
  "fail",
);

const report = `# Reese Photography CRM Backup Reconciliation - ${today}

Generated: ${new Date().toISOString()}

## Summary

- Status: ${failures.length ? "Needs attention" : warnings.length ? "Passes with warnings" : "Healthy"}
- Failures: ${failures.length ? failures.join(", ") : "None"}
- Warnings: ${warnings.length ? warnings.join(", ") : "None"}

## Checks

| Check | Status | Detail |
| --- | --- | --- |
${rows
  .map((row) => `| ${row.label} | ${row.severity.toUpperCase()} | ${String(row.detail).replaceAll("|", "\\|")} |`)
  .join("\n")}

## Paths

- Active repo: \`${repoRoot}\`
- Code mirror: \`${mirrorRoot}\`
- Backup root: \`${backupRoot}\`
- Latest local SQLite: \`${path.join(backupRoot, "sqlite", "latest.db")}\`
- Latest D1 export: \`${path.join(backupRoot, "d1", "latest.sql")}\`
`;

fs.writeFileSync(reportPath, report);
console.log(`Reconciliation report written to ${reportPath}`);

if (failures.length) process.exit(1);
