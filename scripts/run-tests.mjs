#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const excludedDirs = new Set([".git", ".next", ".open-next", ".wrangler", "node_modules"]);
const patternArg = process.argv.find((arg) => arg.startsWith("--pattern="));
const pattern = patternArg ? new RegExp(patternArg.slice("--pattern=".length)) : null;

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      files.push(...collectTests(path.join(dir, entry.name)));
      continue;
    }

    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (!/\.(test)\.(mjs|ts|tsx)$/.test(entry.name)) continue;
    if (pattern && !pattern.test(filePath)) continue;
    files.push(filePath);
  }

  return files;
}

const tests = collectTests(process.cwd()).sort();

if (tests.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

let passed = 0;
const failures = [];

for (const testFile of tests) {
  const relative = path.relative(process.cwd(), testFile);
  const command = testFile.endsWith(".mjs") ? "node" : "tsx";
  const result = spawnSync(command, [relative], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });

  if (result.status === 0) {
    passed += 1;
    console.log(`PASS ${relative}`);
    continue;
  }

  failures.push(relative);
  console.error(`FAIL ${relative}`);
  if (result.stdout.trim()) console.error(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
}

console.log(`${passed}/${tests.length} tests passed.`);

if (failures.length > 0) {
  console.error(`Failed tests: ${failures.join(", ")}`);
  process.exit(1);
}
