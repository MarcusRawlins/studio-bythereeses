#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const KNOWN_COPIES = [
  "/Volumes/reeseai-memory/code/reese-photography-crm",
  "/Users/tyler-macmini/code/reese-photography-crm",
  "/Users/tyler-macmini/Documents/studio-bythereeses",
];

export const CANONICAL_ORIGIN = "https://github.com/MarcusRawlins/studio-bythereeses.git";

function defaultRun(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

export function readCopyState(copyPath, { exists = fs.existsSync, run = defaultRun } = {}) {
  const base = { path: copyPath };

  if (!exists(copyPath)) {
    return { ...base, present: false };
  }
  if (!exists(path.join(copyPath, ".git"))) {
    return { ...base, present: true, isGitRepo: false };
  }

  const headResult = run("git", ["rev-parse", "HEAD"], copyPath);
  if (headResult.status !== 0) {
    return {
      ...base,
      present: true,
      isGitRepo: true,
      error: headResult.stderr || headResult.stdout || "git rev-parse HEAD failed",
    };
  }

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], copyPath).stdout;
  const head = headResult.stdout;
  const dirty = run("git", ["status", "--porcelain"], copyPath).stdout.length > 0;

  let originUrl = null;
  const originResult = run("git", ["remote", "get-url", "origin"], copyPath);
  if (originResult.status === 0) {
    originUrl = originResult.stdout;
  }

  let upstream = null;
  let ahead = null;
  let behind = null;
  const upstreamResult = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], copyPath);
  if (upstreamResult.status === 0) {
    upstream = upstreamResult.stdout;
    const countResult = run("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], copyPath);
    if (countResult.status === 0) {
      const [behindCount, aheadCount] = countResult.stdout.split(/\s+/);
      behind = Number(behindCount);
      ahead = Number(aheadCount);
    }
  }

  return {
    ...base,
    present: true,
    isGitRepo: true,
    branch,
    head,
    dirty,
    originUrl,
    upstream,
    ahead,
    behind,
  };
}

export function summarizeCopy(copy) {
  if (!copy.present) return `${copy.path}: absent`;
  if (!copy.isGitRepo) return `${copy.path}: present (not a git repo)`;
  if (copy.error) return `${copy.path}: git error (${copy.error})`;

  const shortHead = copy.head?.slice(0, 7) ?? "(unknown)";
  const dirtyFlag = copy.dirty ? " dirty" : "";
  const origin = copy.originUrl ?? "(no origin)";
  const upstream = copy.upstream ?? "(no upstream)";
  const sync =
    copy.upstream && copy.ahead != null && copy.behind != null
      ? ` ${copy.ahead} ahead / ${copy.behind} behind ${copy.upstream}`
      : "";

  return `${copy.path}: ${copy.branch}@${shortHead}${dirtyFlag}; origin=${origin}; upstream=${upstream}${sync}`;
}

export function evaluateSourceDrift({ primary, copies, canonicalOrigin = CANONICAL_ORIGIN }) {
  const errors = [];
  const warnings = [];
  const gitCopies = copies.filter((copy) => copy.present && copy.isGitRepo && copy.head);

  if (primary.dirty) {
    warnings.push(`Primary worktree is dirty (${primary.path}).`);
  }
  if (!primary.originUrl) {
    warnings.push(`Primary has no origin remote configured (${primary.path}).`);
  } else if (canonicalOrigin && primary.originUrl !== canonicalOrigin) {
    errors.push(`Primary origin URL (${primary.originUrl}) does not match canonical (${canonicalOrigin}).`);
  }
  if (!primary.upstream) {
    warnings.push(`Primary has no upstream tracking branch (${primary.path}).`);
  } else if ((primary.ahead ?? 0) > 0 || (primary.behind ?? 0) > 0) {
    warnings.push(
      `Primary is ${primary.ahead ?? 0} ahead and ${primary.behind ?? 0} behind ${primary.upstream}.`,
    );
  }

  const heads = new Set(gitCopies.map((copy) => copy.head));
  if (heads.size > 1) {
    const summary = gitCopies
      .map((copy) => `${copy.path}: ${copy.branch}@${copy.head.slice(0, 7)}`)
      .join("; ");
    errors.push(`Known copies disagree on HEAD: ${summary}`);
  }

  const branches = new Set(gitCopies.map((copy) => copy.branch));
  if (branches.size > 1) {
    warnings.push(`Known copies are on different branches: ${[...branches].join(", ")}`);
  }

  const origins = new Set(gitCopies.map((copy) => copy.originUrl).filter(Boolean));
  if (origins.size > 1) {
    errors.push(`Known copies have different origin URLs: ${[...origins].join(", ")}`);
  }

  for (const copy of copies) {
    if (!copy.present) {
      warnings.push(`Known copy absent: ${copy.path}`);
      continue;
    }
    if (!copy.isGitRepo) {
      warnings.push(`Known copy present but not a git repo: ${copy.path}`);
      continue;
    }
    if (copy.error) {
      errors.push(`Known copy git error (${copy.path}): ${copy.error}`);
      continue;
    }
    if (copy.dirty) {
      warnings.push(`Dirty worktree: ${copy.path} (${copy.branch}@${copy.head.slice(0, 7)}).`);
    }
    if (!copy.upstream) {
      warnings.push(`No upstream tracking branch: ${copy.path}`);
    } else if ((copy.ahead ?? 0) > 0 || (copy.behind ?? 0) > 0) {
      warnings.push(
        `${copy.path} is ${copy.ahead ?? 0} ahead and ${copy.behind ?? 0} behind ${copy.upstream}.`,
      );
    }
  }

  return {
    errors,
    warnings,
    aligned: errors.length === 0,
  };
}

function main() {
  const primary = readCopyState(repoRoot);
  const copies = KNOWN_COPIES.map((copyPath) => readCopyState(copyPath));
  const result = evaluateSourceDrift({ primary, copies });

  console.log("Source-of-truth drift check");
  console.log(`Primary: ${summarizeCopy(primary)}`);
  console.log("Known copies:");
  for (const copy of copies) {
    console.log(`  - ${summarizeCopy(copy)}`);
  }

  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);

  if (result.errors.length > 0) process.exit(1);
  console.log("Source drift check passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}