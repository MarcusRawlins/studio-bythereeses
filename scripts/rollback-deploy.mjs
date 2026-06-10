#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_DIR, WORKER_NAME } from "./capture-deploy-versions.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = path.join(MANIFEST_DIR, "latest-deploy-versions.json");

export function resolveRollbackTarget(manifest, { versionId, usePrevious = false } = {}) {
  if (versionId?.trim()) return versionId.trim();
  if (usePrevious) return manifest?.worker?.previous?.versionId || null;
  return manifest?.worker?.previous?.versionId || null;
}

export function formatRollbackPlan(manifest, targetVersionId) {
  const lines = [
    "Rollback plan (Worker + Pages front door):",
    `  Worker name: ${WORKER_NAME}`,
    `  Target Worker version: ${targetVersionId || "(missing — run npm run deploy:capture-versions first)"}`,
    "  Pages rollback: Cloudflare dashboard > Workers & Pages > studio-bythereeses > Deployments > Rollback",
    `  Prior capture: ${manifest?.createdAt || "unknown"}`,
    `  Git at capture: ${manifest?.git?.branch || "?"}@${manifest?.git?.head || "?"}`,
    "  After rollback: npm run smoke:production",
    "  Full gate if redeploying from git: npm run lint && npm run build && npm run backup:data && npm run deploy:preflight",
  ];
  return lines.join("\n");
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function runWranglerRollback(versionId, message) {
  const args = ["rollback", versionId, "--name", WORKER_NAME, "--message", message, "--yes"];
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function printUsage() {
  console.log(`Usage:
  npm run deploy:rollback -- --plan
  npm run deploy:rollback -- --plan --manifest ${defaultManifest}
  npm run deploy:rollback -- --worker-version <version-id> --yes

Notes:
  - Default target is the previous Worker version from the latest capture manifest.
  - Pages still rolls back through the Cloudflare dashboard (no wrangler rollback command).
  - Always run npm run smoke:production after a rollback.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const manifestPath = path.resolve(
    args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : defaultManifest,
  );
  const manifest = loadManifest(manifestPath);
  const versionFlag = args.includes("--worker-version") ? args[args.indexOf("--worker-version") + 1] : null;
  const targetVersionId = resolveRollbackTarget(manifest, {
    versionId: versionFlag,
    usePrevious: !versionFlag,
  });

  if (args.includes("--plan") || !args.includes("--yes")) {
    console.log(formatRollbackPlan(manifest, targetVersionId));
    if (!args.includes("--yes")) {
      console.log("\nDry run only. Pass --yes to execute Worker rollback.");
      if (!targetVersionId) process.exit(1);
      return;
    }
  }

  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    console.error("CLOUDFLARE_API_TOKEN is required for Worker rollback.");
    process.exit(1);
  }
  if (!targetVersionId) {
    console.error("No Worker version id available. Run npm run deploy:capture-versions before deploying.");
    process.exit(1);
  }

  const message = `ops rollback to ${targetVersionId}`;
  const result = runWranglerRollback(targetVersionId, message);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.status !== 0) process.exit(result.status);

  console.log("Worker rollback submitted. Roll back Pages in the dashboard if needed, then run npm run smoke:production.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}