#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "ops", "launchd");
const targetDir = path.join(os.homedir(), "Library", "LaunchAgents");
const backupLogDir = "/Volumes/reeseai-memory/09_Backups/backups/reese-photography-crm/logs";
const localLogDir = path.join(os.homedir(), "Library", "Logs", "reese-photography-crm");
const labels = [
  "com.reeses.crm.daily-backup",
  "com.reeses.crm.weekly-reconciliation",
];

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
}

fs.mkdirSync(targetDir, { recursive: true });
fs.mkdirSync(backupLogDir, { recursive: true });
fs.mkdirSync(localLogDir, { recursive: true });

for (const label of labels) {
  const file = `${label}.plist`;
  fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  run("launchctl", ["bootout", `gui/${process.getuid()}`, path.join(targetDir, file)]);
  const result = run("launchctl", ["bootstrap", `gui/${process.getuid()}`, path.join(targetDir, file)]);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.reeses.crm.daily-backup`]);

console.log("Installed Reese CRM daily backup and weekly reconciliation LaunchAgents.");
