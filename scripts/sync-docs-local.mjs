#!/usr/bin/env node
// Mirror the repo's knowledge docs to a local folder OUTSIDE the repo, so Tyler always has a
// plain-Finder copy of the operating docs even without opening the repo.
//
//   npm run docs:local-sync
//
// Default target: ~/Documents/CLAUDE/Reeses-Studio (override: DOCS_SYNC_TARGET=/some/path).
// Copies: docs/ (recursively, incl. specs), AGENTS.md, CLAUDE.md, plus a generated _SYNC-INFO.md
// stamping when/from-what-commit the mirror was made. One-way (repo -> folder): files removed from
// docs/ are pruned from the mirror's docs/ tree so it never drifts stale, but anything ELSE Tyler
// keeps in the target folder (his own notes, screenshots) is left untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.DOCS_SYNC_TARGET
  ? path.resolve(process.env.DOCS_SYNC_TARGET)
  : path.join(os.homedir(), "Documents", "CLAUDE", "Reeses-Studio");

function copyTree(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  const wanted = new Set();
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    wanted.add(entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
  // Prune files that no longer exist in the source docs tree (mirror stays exact).
  for (const entry of fs.readdirSync(toDir, { withFileTypes: true })) {
    if (!wanted.has(entry.name)) {
      fs.rmSync(path.join(toDir, entry.name), { recursive: true, force: true });
    }
  }
}

function main() {
  const docsSrc = path.join(repoRoot, "docs");
  if (!fs.existsSync(docsSrc)) {
    console.error(`No docs/ directory found at ${docsSrc}`);
    process.exit(1);
  }

  fs.mkdirSync(target, { recursive: true });
  copyTree(docsSrc, path.join(target, "docs"));

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const from = path.join(repoRoot, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(target, name));
  }

  let commit = "unknown";
  let branch = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim();
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim();
  } catch {
    // Not a git checkout (e.g. an exported copy) — stamp without commit info.
  }

  fs.writeFileSync(
    path.join(target, "_SYNC-INFO.md"),
    [
      "# Reeses-Studio doc mirror",
      "",
      "This folder is a ONE-WAY mirror of the CRM repo's knowledge docs. Do not edit the mirrored",
      "files here — edit them in the repo (or tell the agent) and re-run the sync. Your own notes/",
      "files in this folder are safe: only the mirrored `docs/` tree is pruned to match the repo.",
      "",
      `- Synced: ${new Date().toISOString()}`,
      `- From: ${repoRoot}`,
      `- Branch: ${branch}`,
      `- Commit: ${commit}`,
      "",
      "Start with `docs/handoff-build-state.md`. Deploy: `docs/deploy-next.md`.",
      "Re-sync: `npm run docs:local-sync` in the repo.",
    ].join("\n") + "\n",
  );

  const fileCount = execSync(
    process.platform === "win32" ? `dir /s /b "${target}" | find /c /v ""` : `find "${target}" -type f | wc -l`,
    { shell: process.platform === "win32" ? undefined : "/bin/bash" },
  )
    .toString()
    .trim();
  console.log(`docs mirrored to ${target} (${fileCount} files, commit ${commit})`);
}

main();
