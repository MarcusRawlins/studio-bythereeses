#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_NAME = "reese-photography-crm";
export const PAGES_PROJECT_NAME = "studio-bythereeses";
export const MANIFEST_DIR = "/Volumes/reeseai-memory/backups/reese-photography-crm/manifests";

export function normalizeDeploymentList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.deployments)) return raw.deployments;
    if (raw.result && Array.isArray(raw.result.deployments)) return raw.result.deployments;
    if (Array.isArray(raw.result)) return raw.result;
  }
  return [];
}

export function summarizeWorkerDeployments(deployments) {
  const rows = normalizeDeploymentList(deployments)
    .map((deployment) => {
      const version = Array.isArray(deployment.versions) ? deployment.versions[0] : null;
      return {
        deploymentId: deployment.id || deployment.deployment_id || null,
        versionId: version?.version_id || deployment.version_id || deployment.id || null,
        createdOn: deployment.created_on || deployment.created_at || null,
        percentage: version?.percentage ?? deployment.percentage ?? null,
        source: deployment.source || null,
      };
    })
    .filter((row) => row.deploymentId || row.versionId);

  return {
    current: rows[0] || null,
    previous: rows[1] || null,
    all: rows,
  };
}

export function summarizePagesDeployments(deployments) {
  const rows = normalizeDeploymentList(deployments)
    .map((deployment) => ({
      deploymentId: deployment.id || deployment.deployment_id || null,
      createdOn: deployment.created_on || deployment.created_at || null,
      environment: deployment.environment || deployment.env || null,
      url: deployment.url || deployment.deployment_trigger?.metadata?.branch || null,
      status: deployment.latest_stage?.status || deployment.stage?.status || deployment.status || null,
    }))
    .filter((row) => row.deploymentId);

  return {
    current: rows[0] || null,
    previous: rows[1] || null,
    all: rows,
  };
}

export function readGitState(run = defaultRun) {
  const head = run("git", ["rev-parse", "HEAD"]).stdout;
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  const dirty = run("git", ["status", "--porcelain"]).stdout.length > 0;
  return { head, branch, dirty };
}

export function buildCaptureManifest({
  createdAt = new Date().toISOString(),
  git,
  worker,
  pages,
  warnings = [],
}) {
  return {
    createdAt,
    git,
    worker: {
      name: WORKER_NAME,
      ...worker,
    },
    pages: {
      projectName: PAGES_PROJECT_NAME,
      ...pages,
    },
    rollbackHints: {
      worker: worker.previous?.versionId
        ? `wrangler rollback ${worker.previous.versionId} --name ${WORKER_NAME} --yes`
        : null,
      pages: "Use Cloudflare dashboard: Workers & Pages > studio-bythereeses > Deployments > Rollback.",
      verify: "npm run smoke:production",
    },
    warnings,
  };
}

function defaultRun(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function runWrangler(args, env) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 10,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function parseJson(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const stamp = manifest.createdAt.replace(/[:.]/g, "-");
  const stampedPath = path.join(MANIFEST_DIR, `deploy-versions-${stamp}.json`);
  const latestPath = path.join(MANIFEST_DIR, "latest-deploy-versions.json");
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(stampedPath, payload);
  fs.writeFileSync(latestPath, payload);
  return { stampedPath, latestPath };
}

async function main() {
  const args = process.argv.slice(2);
  const gitOnly = args.includes("--git-only");
  const warnings = [];
  const git = readGitState();

  let workerRaw = null;
  let pagesRaw = null;

  if (!gitOnly) {
    if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
      warnings.push("CLOUDFLARE_API_TOKEN missing; captured git state only. Re-run after exporting a token.");
    } else {
      const workerList = runWrangler(["deployments", "list", "--name", WORKER_NAME, "--json"]);
      if (workerList.status !== 0) {
        warnings.push(`Worker deployment list failed: ${workerList.stderr || workerList.stdout}`);
      } else {
        workerRaw = parseJson(workerList.stdout);
        if (!workerRaw) warnings.push("Worker deployment list returned non-JSON output.");
      }

      const pagesList = runWrangler([
        "pages",
        "deployment",
        "list",
        "--project-name",
        PAGES_PROJECT_NAME,
        "--environment",
        "production",
        "--json",
      ]);
      if (pagesList.status !== 0) {
        warnings.push(`Pages deployment list failed: ${pagesList.stderr || pagesList.stdout}`);
      } else {
        pagesRaw = parseJson(pagesList.stdout);
        if (!pagesRaw) warnings.push("Pages deployment list returned non-JSON output.");
      }
    }
  }

  const manifest = buildCaptureManifest({
    git,
    worker: summarizeWorkerDeployments(workerRaw || []),
    pages: summarizePagesDeployments(pagesRaw || []),
    warnings,
  });

  const paths = writeManifest(manifest);
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  console.log(`Captured deploy versions:`);
  console.log(`  git ${git.branch}@${git.head}${git.dirty ? " (dirty)" : ""}`);
  if (manifest.worker.current) {
    console.log(`  worker current version ${manifest.worker.current.versionId || "(unknown)"}`);
  }
  if (manifest.pages.current) {
    console.log(`  pages current deployment ${manifest.pages.current.deploymentId || "(unknown)"}`);
  }
  console.log(`  manifest ${paths.latestPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}